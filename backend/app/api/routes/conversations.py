"""
Direct customer↔pharmacy conversations (independent of orders).

Endpoints
---------
  POST /api/conversations                   -> get-or-create (customer initiates)
  GET  /api/conversations                   -> list mine (customer or pharmacy)
  GET  /api/conversations/{id}/messages     -> full message history
  POST /api/conversations/{id}/messages     -> append a message

Permission rules
----------------
  * Customer owner: account.id == conversation.customer_account_id
  * Pharmacy owner: account.pharmacy.id == conversation.pharmacy_id
"""
from __future__ import annotations

import json

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID
import uuid as uuid_module

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import desc, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_account, get_db
from app.api.routes.ai import (
    has_ai_mention,
    moderate_message,
    mediai_reply_for_chat,
)
from app.services.notify import notify as user_notify
from app.services.customer_policy import ensure_customer_not_banned
from app.services.delivery import delivery_fee_for_distance
from app.services.dispatch import broadcast_rider_offers
from app.services.geo_policy import (
    CONNECT_RADIUS_KM,
    RIDER_BROADCAST_RADIUS_KM,
    ensure_within_connect_radius,
)
from app.services.stock import reserve_items_stock, restore_order_stock
from app.services.pharmacy_policy import ensure_pharmacy_not_blocked
from app.models import (
    Account,
    Conversation,
    ConversationMessage,
    CustomerProfile,
    Medicine,
    Order,
    OrderMessage,
    OrderStatus,
    PharmacyProfile,
    RiderOffer,
    RiderOfferStatus,
    RiderProfile,
    RoleEnum,
    SenderRole,
)

import math

RIDER_CHAT_ARCHIVE_HOURS = 73
RIDER_CHAT_ARCHIVE_DELTA = timedelta(hours=RIDER_CHAT_ARCHIVE_HOURS)
RIDER_ARCHIVE_STATUSES = (
    OrderStatus.delivered,
    OrderStatus.rejected,
    OrderStatus.cancelled,
)

# ---- Smart Prescription AI add-on listener ----
# Only inside an active Smart Prescription order/handshake, when a pharmacy
# asks whether the customer wants anything else, AI may post an
# `ai_addon_prompt` card. Normal/manual order chats stay silent unless a
# participant explicitly mentions @mediai.
_ADDON_INTENT_PATTERNS = [
    # Bangla
    r"আর\s*কিছু\s*(নিবেন|নেবেন|চান|লাগবে|দরকার)",
    r"আরো\s*কিছু\s*(নিবেন|নেবেন|চান|লাগবে|দরকার)",
    r"অন্য\s*কিছু\s*(নিবেন|নেবেন|চান|লাগবে|দরকার)",
    r"আর\s*কিছু\s*যোগ",
    r"আর\s*কি\s*নিবেন",
    # Banglish
    r"\bar\s*kichu\s*(niben|neben|chai|chan|dorkar|lagbe)\b",
    r"\baro\s*kichu\s*(niben|neben|chai|chan|dorkar|lagbe)\b",
    r"\banyo\s*kichu\s*(niben|neben|chan)\b",
    # English
    r"\banything\s+else\b",
    r"\bwant\s+more\b",
    r"\bneed\s+(anything|something)\s+else\b",
    r"\bany\s+other\s+(medicine|item|product)s?\b",
    r"\bshould\s+i\s+add\s+anything\b",
]
_ADDON_INTENT_RE = re.compile("|".join(_ADDON_INTENT_PATTERNS), re.IGNORECASE)


def _is_addon_inquiry(text: str) -> bool:
    if not text:
        return False
    return bool(_ADDON_INTENT_RE.search(text))


def _km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine distance in km."""
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


# ---------- schemas ----------
class ConversationStart(BaseModel):
    pharmacy_id: UUID
    # Customer's live location — enforced against the 5 km connect radius
    # when supplied. Optional at schema level so server-side flows (Smart
    # Prescription, already radius-gated at scan time) keep working.
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class MessageIn(BaseModel):
    body: str = Field(default="", max_length=4000)
    attachment_url: Optional[str] = Field(default=None, max_length=500)
    preset_key: Optional[str] = Field(default=None, max_length=40)
    # Structured payload for itemized presets (order_request / pharmacy_quote)
    payload: Optional[Dict[str, Any]] = None
    # Visibility scope. "all" (default), "customer_rider" (customer<->rider),
    # "customer_pharmacy" (customer<->pharmacy), "pharmacy_rider" (pharmacy<->rider).
    visibility: Optional[str] = Field(default="all", max_length=20)


# ---------- helpers ----------
def _conv_dict(
    c: Conversation,
    pharmacy: PharmacyProfile | None,
    customer: CustomerProfile | None = None,
    rider: RiderProfile | None = None,
) -> Dict[str, Any]:
    return {
        "id": str(c.id),
        "pharmacy_id": str(c.pharmacy_id),
        "pharmacy_name": pharmacy.pharmacy_name if pharmacy else "Pharmacy",
        "pharmacy_avatar": pharmacy.banner_photo_url if pharmacy else None,
        "customer_account_id": str(c.customer_account_id),
        "customer_name": c.customer_name,
        "customer_avatar": customer.profile_photo_url if customer else None,
        "rider_id": str(c.rider_id) if c.rider_id else None,
        "rider_name": (rider.nick_name or rider.full_name) if rider else None,
        "rider_avatar": rider.profile_photo_url if rider else None,
        "rider_phone": rider.phone_number if rider else None,
        "last_message_at": c.last_message_at.isoformat() if c.last_message_at else None,
        "customer_last_read_at": c.customer_last_read_at.isoformat() if c.customer_last_read_at else None,
        "pharmacy_last_read_at": c.pharmacy_last_read_at.isoformat() if c.pharmacy_last_read_at else None,
        "rider_last_read_at": c.rider_last_read_at.isoformat() if c.rider_last_read_at else None,
        "blocked_at": c.blocked_at.isoformat() if c.blocked_at else None,
        "block_reason": c.block_reason,
        "block_category": c.block_category,
        "flag_count": int(c.flag_count or 0),
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


def _msg_dict(m: ConversationMessage) -> Dict[str, Any]:
    payload: Any = None
    if m.payload_json:
        try:
            payload = json.loads(m.payload_json)
        except Exception:
            payload = None
    return {
        "id": str(m.id),
        "conversation_id": str(m.conversation_id),
        "sender_role": m.sender_role.value if hasattr(m.sender_role, "value") else str(m.sender_role),
        "body": m.body or "",
        "attachment_url": m.attachment_url,
        "preset_key": m.preset_key,
        "payload": payload,
        "visibility": getattr(m, "visibility", "all") or "all",
        "moderation_risk": getattr(m, "moderation_risk", None),
        "moderation_category": getattr(m, "moderation_category", None),
        "moderation_reason": getattr(m, "moderation_reason", None),
        "was_blocked": bool(getattr(m, "was_blocked", False)),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _can_see(visibility: str, viewer: str) -> bool:
    """viewer is one of 'customer'|'pharmacy'|'rider'. Returns whether the
    message with the given visibility tag should be shown to this viewer."""
    v = (visibility or "all").strip()
    if v == "all":
        return True
    if v == "customer_rider":
        return viewer in ("customer", "rider")
    if v == "customer_pharmacy":
        return viewer in ("customer", "pharmacy")
    if v == "pharmacy_rider":
        return viewer in ("pharmacy", "rider")
    if v == "customer_only":
        # AI's private question to the customer — pharmacy + rider must
        # NOT see it. Customer's typed answer is mirrored back via a
        # separate `ai_proxy_reply` scoped to the original asker.
        return viewer == "customer"
    return True


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


async def _rider_archive_info(
    conv: Conversation,
    rider_id: UUID,
    db: AsyncSession,
) -> Optional[Dict[str, Any]]:
    """Return the 73-hour read-only archive window for a former rider.

    A former rider may review only their own completed/cancelled delivery for
    73 hours. They are not a live participant anymore, so sending remains
    blocked and messages after the leave/completion moment are hidden.
    """
    order = (
        await db.execute(
            select(Order)
            .where(
                Order.conversation_id == conv.id,
                Order.accepted_rider_id == rider_id,
                Order.status.in_(RIDER_ARCHIVE_STATUSES),
            )
            .order_by(desc(Order.updated_at), desc(Order.created_at))
            .limit(1)
        )
    ).scalar_one_or_none()
    if order is None:
        return None

    completed_at = _naive_utc(order.updated_at or order.created_at)
    if completed_at is None:
        return None
    archive_until = completed_at + RIDER_CHAT_ARCHIVE_DELTA
    if archive_until < datetime.utcnow():
        return None

    # Include the rider's delivery_complete/rider_left system rows, but do not
    # include later customer↔pharmacy follow-up. These rows are posted in the
    # same transaction, so a narrow window around completed_at is enough and
    # avoids accidentally selecting a later delivery's rider_left.
    window_start = completed_at - timedelta(minutes=5)
    window_end = completed_at + timedelta(minutes=15)
    cutoff_candidates = [completed_at]
    leave_rows = (
        await db.execute(
            select(ConversationMessage.created_at)
            .where(
                ConversationMessage.conversation_id == conv.id,
                ConversationMessage.preset_key.in_(("delivery_complete", "rider_left")),
                ConversationMessage.created_at >= window_start,
                ConversationMessage.created_at <= window_end,
            )
            .order_by(desc(ConversationMessage.created_at))
            .limit(2)
        )
    ).scalars().all()
    for row_time in leave_rows:
        normalized = _naive_utc(row_time)
        if normalized is not None:
            cutoff_candidates.append(normalized)

    message_cutoff = max(cutoff_candidates)

    # One Conversation is reused forever for the same customer+pharmacy pair.
    # If a newer order starts after this rider's leave point, the old archive
    # must disappear for that rider until they actually accept the new delivery
    # and become `conv.rider_id` again. Otherwise a former rider can reopen the
    # reused conversation and the UI may look like they are back in the chat.
    newer_order = (
        await db.execute(
            select(Order.id)
            .where(
                Order.conversation_id == conv.id,
                Order.created_at > completed_at,
            )
            .limit(1)
        )
    ).first()
    if newer_order is not None:
        return None

    newer_order_request = (
        await db.execute(
            select(ConversationMessage.id)
            .where(
                ConversationMessage.conversation_id == conv.id,
                ConversationMessage.preset_key == "order_request",
                ConversationMessage.created_at > message_cutoff,
            )
            .limit(1)
        )
    ).first()
    if newer_order_request is not None:
        return None

    return {
        "order": order,
        "message_cutoff": message_cutoff,
        "archive_until": archive_until,
    }


async def _get_conversation_or_403(
    conversation_id: UUID, account: Account, db: AsyncSession
) -> Conversation:
    c = (
        await db.execute(select(Conversation).where(Conversation.id == conversation_id))
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")

    is_customer = account.id == c.customer_account_id
    is_pharmacy = account.pharmacy is not None and account.pharmacy.id == c.pharmacy_id
    is_rider = False
    if account.rider is not None:
        if c.rider_id is not None and account.rider.id == c.rider_id:
            is_rider = True
        else:
            archive = await _rider_archive_info(c, account.rider.id, db)
            if archive is not None:
                is_rider = True
    if not (is_customer or is_pharmacy or is_rider):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a participant")
    return c


def _viewer_side(account: Account, conv: Conversation) -> str:
    if account.id == conv.customer_account_id:
        return "customer"
    if account.pharmacy and account.pharmacy.id == conv.pharmacy_id:
        return "pharmacy"
    if account.role == RoleEnum.rider and account.rider:
        return "rider"
    return "customer"


# Bug #11 — auto-expire stale ai_handshake rows that the pharmacy never
# answered. Runs lazily on every GET /messages so we don't need a cron.
HANDSHAKE_TIMEOUT_MINUTES = 5
CONFIRM_PROMPT_TIMEOUT_MINUTES = 15


async def _expire_stale_handshakes(conv: Conversation, db: AsyncSession) -> None:
    cutoff = datetime.utcnow() - timedelta(minutes=HANDSHAKE_TIMEOUT_MINUTES)
    stale = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.conversation_id == conv.id,
            ConversationMessage.preset_key == "ai_handshake",
            ConversationMessage.created_at <= cutoff,
        )
    )).scalars().all()
    changed = False
    for row in stale:
        try:
            rp = json.loads(row.payload_json) if row.payload_json else {}
        except Exception:
            continue
        if rp.get("status") not in (None, "", "awaiting_pharmacy"):
            continue
        rp["status"] = "timeout"
        row.payload_json = json.dumps(rp, ensure_ascii=False)
        db.add(row)
        db.add(ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.system,
            body=(
                "⏰ Pharmacy reply দেয়নি — অন্য pharmacy try করতে "
                "Smart Prescription আবার চালান।"
            ),
            preset_key="ai_handshake_rejected",
            payload_json=json.dumps({
                "handshake_id": rp.get("handshake_id"),
                "pharmacy_reason": "Timeout — pharmacy did not respond within 5 min.",
                "timeout": True,
            }, ensure_ascii=False),
            visibility="all",
        ))
        changed = True

    # Also expire orphan confirm_prompt cards: pharmacy said OK, customer
    # never clicked Final Confirm within 15 min. Without this the green
    # "Final Confirm — Place order" CTA stays alive forever and the
    # customer could place an order with stale prices days later.
    cp_cutoff = datetime.utcnow() - timedelta(minutes=CONFIRM_PROMPT_TIMEOUT_MINUTES)
    cp_stale = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.conversation_id == conv.id,
            ConversationMessage.preset_key == "ai_customer_confirm_prompt",
            ConversationMessage.created_at <= cp_cutoff,
        )
    )).scalars().all()
    if cp_stale:
        # Build set of handshake_ids already resolved (completed/cancelled/rejected).
        resolved_ids: set[str] = set()
        terminal_rows = (await db.execute(
            select(ConversationMessage).where(
                ConversationMessage.conversation_id == conv.id,
                ConversationMessage.preset_key.in_([
                    "ai_handshake_completed",
                    "ai_handshake_rejected",
                    "ai_handshake_cancelled",
                ]),
            )
        )).scalars().all()
        for tr in terminal_rows:
            try:
                tp = json.loads(tr.payload_json) if tr.payload_json else {}
            except Exception:
                continue
            hid = tp.get("handshake_id")
            if hid:
                resolved_ids.add(str(hid))
            for hid in tp.get("handshake_ids") or []:
                if hid:
                    resolved_ids.add(str(hid))
        for row in cp_stale:
            try:
                rp = json.loads(row.payload_json) if row.payload_json else {}
            except Exception:
                continue
            if rp.get("status") in ("confirmed", "cancelled", "timeout"):
                continue
            hid = str(rp.get("handshake_id") or "")
            if hid and hid in resolved_ids:
                # Already terminal via completed/rejected/cancelled — just mark
                # status so FE quick-check picks it up without scanning history.
                if rp.get("status") != "confirmed":
                    rp["status"] = "confirmed"
                    row.payload_json = json.dumps(rp, ensure_ascii=False)
                    db.add(row)
                    changed = True
                continue
            rp["status"] = "timeout"
            row.payload_json = json.dumps(rp, ensure_ascii=False)
            db.add(row)
            if hid:
                handshake_rows = (await db.execute(
                    select(ConversationMessage).where(
                        ConversationMessage.conversation_id == conv.id,
                        ConversationMessage.preset_key == "ai_handshake",
                    )
                )).scalars().all()
                for handshake_row in handshake_rows:
                    try:
                        hp = json.loads(handshake_row.payload_json) if handshake_row.payload_json else {}
                    except Exception:
                        continue
                    if str(hp.get("handshake_id") or "") != hid:
                        continue
                    if hp.get("status") in ("confirmed", "rejected", "cancelled", "timeout"):
                        continue
                    hp["status"] = "timeout"
                    handshake_row.payload_json = json.dumps(hp, ensure_ascii=False)
                    db.add(handshake_row)
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=SenderRole.system,
                body=(
                    "⏰ Final confirm দেওয়া হয়নি — order auto-cancel হয়েছে। "
                    "নতুন stock check-এর জন্য Smart Prescription আবার চালান।"
                ),
                preset_key="ai_handshake_cancelled",
                payload_json=json.dumps({
                    "handshake_id": hid or None,
                    "timeout": True,
                    "reason": "customer_confirm_timeout",
                }, ensure_ascii=False),
                visibility="all",
            ))
            changed = True

    if changed:
        try:
            await db.commit()
        except Exception:
            await db.rollback()


# ---------- routes ----------
@router.post("", status_code=200)
async def start_conversation(
    payload: ConversationStart,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers can start conversations")
    ensure_customer_not_banned(account)

    pharmacy = (
        await db.execute(select(PharmacyProfile).where(PharmacyProfile.id == payload.pharmacy_id))
    ).scalar_one_or_none()
    if not pharmacy:
        raise HTTPException(404, "Pharmacy not found")
    if getattr(pharmacy, "is_blocked", False):
        raise HTTPException(status.HTTP_423_LOCKED, detail={
            "code": "pharmacy_blocked",
            "message": "এই pharmacy আপাতত MediDoor-এ available নয়।",
        })

    existing = (
        await db.execute(
            select(Conversation).where(
                Conversation.pharmacy_id == pharmacy.id,
                Conversation.customer_account_id == account.id,
            )
        )
    ).scalar_one_or_none()
    if existing:
        cust = (
            await db.execute(
                select(CustomerProfile).where(CustomerProfile.account_id == account.id)
            )
        ).scalar_one_or_none()
        return _conv_dict(existing, pharmacy, cust)

    # 5 km connect gate — a customer may only START a chat with a pharmacy
    # inside their connect radius (existing threads above stay reachable so
    # order history survives a move; new orders are gated separately).
    ensure_within_connect_radius(payload.lat, payload.lng, pharmacy, require_location=False)

    customer_name = (
        (
            f"{account.customer.first_name or ''} {account.customer.last_name or ''}".strip()
            if account.customer
            else None
        )
        or account.gmail
        or "Customer"
    )
    conv = Conversation(
        pharmacy_id=pharmacy.id,
        customer_account_id=account.id,
        customer_name=customer_name,
    )
    db.add(conv)
    try:
        await db.commit()
    except IntegrityError:
        # Concurrent request created the same (pharmacy_id, customer_account_id).
        # Roll back and return the now-existing conversation.
        await db.rollback()
        conv = (
            await db.execute(
                select(Conversation).where(
                    Conversation.pharmacy_id == pharmacy.id,
                    Conversation.customer_account_id == account.id,
                )
            )
        ).scalar_one()
        cust = (
            await db.execute(
                select(CustomerProfile).where(CustomerProfile.account_id == account.id)
            )
        ).scalar_one_or_none()
        return _conv_dict(conv, pharmacy, cust)
    await db.refresh(conv)
    cust = (
        await db.execute(
            select(CustomerProfile).where(CustomerProfile.account_id == account.id)
        )
    ).scalar_one_or_none()
    return _conv_dict(conv, pharmacy, cust)


@router.get("")
async def list_conversations(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    rider_archive_candidate_ids: set[uuid_module.UUID] = set()
    if account.role == RoleEnum.customer:
        rows = (
            await db.execute(
                select(Conversation)
                .where(Conversation.customer_account_id == account.id)
                .order_by(desc(Conversation.last_message_at))
            )
        ).scalars().all()
    elif account.role == RoleEnum.pharmacy and account.pharmacy:
        rows = (
            await db.execute(
                select(Conversation)
                .where(Conversation.pharmacy_id == account.pharmacy.id)
                .order_by(desc(Conversation.last_message_at))
            )
        ).scalars().all()
    elif account.role == RoleEnum.rider and account.rider:
        archive_cutoff = datetime.utcnow() - RIDER_CHAT_ARCHIVE_DELTA
        archive_ids = (
            await db.execute(
                select(Order.conversation_id)
                .where(
                    Order.accepted_rider_id == account.rider.id,
                    Order.conversation_id.is_not(None),
                    Order.status.in_(RIDER_ARCHIVE_STATUSES),
                    Order.updated_at >= archive_cutoff,
                )
                .order_by(desc(Order.updated_at))
            )
        ).scalars().all()
        rider_archive_candidate_ids = {conv_id for conv_id in archive_ids if conv_id is not None}
        filters = [Conversation.rider_id == account.rider.id]
        if rider_archive_candidate_ids:
            filters.append(Conversation.id.in_(rider_archive_candidate_ids))
        rows = (
            await db.execute(
                select(Conversation)
                .where(or_(*filters))
                .order_by(desc(Conversation.last_message_at))
            )
        ).scalars().all()
    else:
        return []

    pharmacy_ids = {c.pharmacy_id for c in rows}
    pharmacies = {}
    if pharmacy_ids:
        ps = (
            await db.execute(
                select(PharmacyProfile).where(PharmacyProfile.id.in_(pharmacy_ids))
            )
        ).scalars().all()
        pharmacies = {p.id: p for p in ps}

    customer_ids = {c.customer_account_id for c in rows}
    customers: Dict[uuid_module.UUID, CustomerProfile] = {}
    if customer_ids:
        cs = (
            await db.execute(
                select(CustomerProfile).where(CustomerProfile.account_id.in_(customer_ids))
            )
        ).scalars().all()
        customers = {c.account_id: c for c in cs}

    rider_ids = {c.rider_id for c in rows if c.rider_id}
    riders: Dict[uuid_module.UUID, RiderProfile] = {}
    if rider_ids:
        rs = (
            await db.execute(
                select(RiderProfile).where(RiderProfile.id.in_(rider_ids))
            )
        ).scalars().all()
        riders = {r.id: r for r in rs}

    # Enrich each conversation with last-message preview + unread count
    # so mobile chat lists can render WhatsApp-style summaries with
    # an unread badge instead of a static "Tap to open chat" placeholder.
    PRESET_PREVIEWS = {
        "order_request": "📦 Order request",
        "pharmacy_quote": "💰 Pharmacy quote",
        "order_confirm": "✅ Order confirmed",
        "confirmed": "✅ Order confirmed",
        "order_reject": "❌ Order rejected",
        "rejected": "❌ Order rejected",
        "order_cancel": "🚫 Order cancelled",
        "cancelled": "🚫 Order cancelled",
        "preparing": "🟢 Preparing order",
        "order_status_preparing": "🟢 Preparing order",
        "placed": "🧾 Order placed",
        "rider_call": "📞 Calling rider",
        "call_rider": "📞 Calling rider",
        "rider_assigned": "🛵 Rider assigned",
        "rider_accepted": "🛵 Rider accepted",
        "rider_joined": "🛵 Rider joined",
        "dispatched": "🚚 Dispatched",
        "picked_up": "📦 Picked up",
        "handed_over": "📤 Handed to rider",
        "delivered": "📬 Delivered",
        "delivery_complete": "📬 Delivery complete",
        "rider_left": "👋 Rider left",
        "rating": "⭐ Rating",
        "ai_prescription_intro": "🤖 medi AI",
        "ai_block": "🛡️ Blocked by AI",
        "ai_warn_medium": "⚠️ AI warning",
        "ai_warn_low": "⚠️ AI notice",
        "ai_unblock": "✅ Unblocked",
    }

    def _viewer_for(c: Conversation) -> str:
        if account.role == RoleEnum.customer:
            return "customer"
        if account.role == RoleEnum.pharmacy:
            return "pharmacy"
        return "rider"

    def _preview(m: ConversationMessage) -> str:
        if m.preset_key and m.preset_key in PRESET_PREVIEWS:
            return PRESET_PREVIEWS[m.preset_key]
        if m.body:
            text = m.body.strip().replace("\n", " ")
            return text[:80]
        if m.attachment_url:
            return "📎 Photo"
        return ""

    enriched: List[Dict[str, Any]] = []
    for c in rows:
        rider_archive: Optional[Dict[str, Any]] = None
        if (
            account.role == RoleEnum.rider
            and account.rider
            and c.rider_id != account.rider.id
            and c.id in rider_archive_candidate_ids
        ):
            rider_archive = await _rider_archive_info(c, account.rider.id, db)
            if rider_archive is None:
                continue

        d = _conv_dict(
            c,
            pharmacies.get(c.pharmacy_id),
            customers.get(c.customer_account_id),
            riders.get(c.rider_id) if c.rider_id else None,
        )
        if rider_archive is not None:
            d["rider_read_only"] = True
            d["rider_archive_until"] = rider_archive["archive_until"].isoformat()
            d["rider_message_cutoff"] = rider_archive["message_cutoff"].isoformat()
            d["last_message_at"] = rider_archive["message_cutoff"].isoformat()
        else:
            d["rider_read_only"] = False
            d["rider_archive_until"] = None
            d["rider_message_cutoff"] = None

        # Last visible message for preview
        viewer = _viewer_for(c)
        last_msg = None
        msg_query = select(ConversationMessage).where(ConversationMessage.conversation_id == c.id)
        if rider_archive is not None:
            msg_query = msg_query.where(
                ConversationMessage.created_at <= rider_archive["message_cutoff"]
            )
        msgs = (
            await db.execute(
                msg_query.order_by(desc(ConversationMessage.created_at)).limit(8)
            )
        ).scalars().all()
        for m in msgs:
            if viewer == "customer" and m.preset_key == "ai_question_for_customer":
                continue
            if _can_see(getattr(m, "visibility", "all"), viewer):
                last_msg = m
                break

        d["last_message_preview"] = _preview(last_msg) if last_msg else ""
        d["last_sender_role"] = (
            last_msg.sender_role.value
            if last_msg and hasattr(last_msg.sender_role, "value")
            else (str(last_msg.sender_role) if last_msg else None)
        )

        # Unread count: messages from other parties, after viewer's last_read_at
        if viewer == "customer":
            cutoff = c.customer_last_read_at
        elif viewer == "pharmacy":
            cutoff = c.pharmacy_last_read_at
        else:
            cutoff = c.rider_last_read_at

        from sqlalchemy import func as _func
        q = select(_func.count(ConversationMessage.id)).where(
            ConversationMessage.conversation_id == c.id,
            ConversationMessage.sender_role != viewer,
        )
        visible_scopes = {
            "customer": ("all", "customer_rider", "customer_pharmacy", "customer_only"),
            "pharmacy": ("all", "customer_pharmacy", "pharmacy_rider"),
            "rider": ("all", "customer_rider", "pharmacy_rider"),
        }.get(viewer, ("all",))
        q = q.where(or_(
            ConversationMessage.visibility.is_(None),
            ConversationMessage.visibility.in_(visible_scopes),
        ))
        if viewer == "customer":
            q = q.where(or_(
                ConversationMessage.preset_key.is_(None),
                ConversationMessage.preset_key != "ai_question_for_customer",
            ))
        if rider_archive is not None:
            q = q.where(ConversationMessage.created_at <= rider_archive["message_cutoff"])
        if cutoff is not None:
            q = q.where(ConversationMessage.created_at > cutoff)
        unread = (await db.execute(q)).scalar_one() or 0
        d["unread_count"] = int(unread)
        enriched.append(d)

    if account.role == RoleEnum.rider:
        enriched.sort(key=lambda row: row.get("last_message_at") or "", reverse=True)

    return enriched


@router.get("/ai-proxy-questions")
async def list_ai_proxy_questions(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """Pending MediAI questions for the customer's AI inbox.

    These rows are stored as customer-only conversation messages so the answer
    can still be relayed to the original pharmacy/rider thread, but customer
    UI should surface them in the MediAI inbox rather than as normal chat
    bubbles in the customer↔pharmacy message stream.
    """
    if account.role != RoleEnum.customer:
        return []
    rows = (
        await db.execute(
            select(ConversationMessage, Conversation, PharmacyProfile.pharmacy_name)
            .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
            .join(PharmacyProfile, PharmacyProfile.id == Conversation.pharmacy_id)
            .where(
                Conversation.customer_account_id == account.id,
                ConversationMessage.preset_key == "ai_question_for_customer",
                ConversationMessage.visibility == "customer_only",
            )
            .order_by(desc(ConversationMessage.created_at))
            .limit(20)
        )
    ).all()
    out: List[Dict[str, Any]] = []
    from app.services.ai_proxy import active_smart_prescription_context_since
    for msg, conv, pharmacy_name in rows:
        d = _msg_dict(msg)
        payload = d.get("payload") if isinstance(d.get("payload"), dict) else {}
        if str((payload or {}).get("status") or "open") == "answered":
            continue
        active_since = await active_smart_prescription_context_since(conv, db)
        if active_since is None:
            continue
        msg_time = _naive_utc(msg.created_at)
        since_time = _naive_utc(active_since)
        if msg_time is not None and since_time is not None and msg_time < since_time:
            continue
        d["pharmacy_id"] = str(conv.pharmacy_id)
        d["pharmacy_name"] = pharmacy_name
        out.append(d)
    return out


@router.get("/{conversation_id}/messages")
async def list_messages(
    conversation_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    conv = await _get_conversation_or_403(conversation_id, account, db)
    # Bug #11 — lazy handshake timeout: any ai_handshake awaiting_pharmacy
    # for >5 min is auto-expired so the customer is not left hanging.
    await _expire_stale_handshakes(conv, db)
    viewer = _viewer_side(account, conv)
    rider_archive: Optional[Dict[str, Any]] = None
    if account.role == RoleEnum.rider and account.rider and conv.rider_id != account.rider.id:
        rider_archive = await _rider_archive_info(conv, account.rider.id, db)
        if rider_archive is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Rider chat archive expired")
    msg_query = select(ConversationMessage).where(
        ConversationMessage.conversation_id == conversation_id
    )
    if rider_archive is not None:
        msg_query = msg_query.where(
            ConversationMessage.created_at <= rider_archive["message_cutoff"]
        )
    rows = (
        await db.execute(
            msg_query.order_by(ConversationMessage.created_at)
        )
    ).scalars().all()
    return [_msg_dict(m) for m in rows if _can_see(getattr(m, "visibility", "all"), viewer)]

@router.get("/{conversation_id}/track")
async def conversation_track(
    conversation_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Map snapshot for a chat-first order conversation.

    Participants can see the pharmacy pickup, customer delivery point (when
    known), and rider live location once a rider has accepted an order.
    """
    conv = await _get_conversation_or_403(conversation_id, account, db)
    rider_archive: Optional[Dict[str, Any]] = None
    if account.role == RoleEnum.rider and account.rider and conv.rider_id != account.rider.id:
        rider_archive = await _rider_archive_info(conv, account.rider.id, db)
        if rider_archive is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Rider chat archive expired")
    if rider_archive is not None:
        order = rider_archive["order"]
    else:
        order = (await db.execute(
            select(Order)
            .where(Order.conversation_id == conv.id)
            .order_by(Order.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()
    pharmacy_id = order.pharmacy_id if order else conv.pharmacy_id
    pharmacy = (await db.execute(
        select(PharmacyProfile).where(PharmacyProfile.id == pharmacy_id)
    )).scalar_one_or_none()
    customer = (await db.execute(
        select(CustomerProfile).where(CustomerProfile.account_id == conv.customer_account_id)
    )).scalar_one_or_none()
    rider = None
    rider_id = order.accepted_rider_id if order and order.accepted_rider_id else conv.rider_id
    if rider_id:
        rider = (await db.execute(select(RiderProfile).where(RiderProfile.id == rider_id))).scalar_one_or_none()
    return {
        "conversation_id": str(conv.id),
        "order_id": str(order.id) if order else None,
        "status": order.status.value if order else None,
        "pharmacy": {
            "id": str(pharmacy.id) if pharmacy else None,
            "name": pharmacy.pharmacy_name if pharmacy else None,
            "address": pharmacy.address if pharmacy else None,
            "lat": pharmacy.lat if pharmacy else None,
            "lng": pharmacy.lng if pharmacy else None,
            "phone": pharmacy.phone_number if pharmacy else None,
            "banner_photo_url": pharmacy.banner_photo_url if pharmacy else None,
        },
        "customer": {
            "name": order.customer_name if order else conv.customer_name,
            "address": order.delivery_address if order else None,
            "lat": order.delivery_lat if order else None,
            "lng": order.delivery_lng if order else None,
            "phone": order.customer_phone if order else None,
            "profile_photo_url": customer.profile_photo_url if customer else None,
        },
        "rider": {
            "name": (rider.nick_name or rider.full_name) if rider else None,
            "lat": rider.last_lat if rider else None,
            "lng": rider.last_lng if rider else None,
            "phone": rider.phone_number if rider else None,
            "last_seen_at": rider.last_seen_at.isoformat() if rider and rider.last_seen_at else None,
        } if rider else None,
        "now": datetime.utcnow().isoformat(),
    }


@router.post("/{conversation_id}/messages", status_code=201)
async def post_message(
    conversation_id: UUID,
    payload: MessageIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    body = (payload.body or "").strip()
    if not body and not payload.attachment_url:
        raise HTTPException(400, "Message body or attachment required")

    conv = await _get_conversation_or_403(conversation_id, account, db)
    if account.role == RoleEnum.rider and account.rider and conv.rider_id != account.rider.id:
        archive = await _rider_archive_info(conv, account.rider.id, db)
        if archive is not None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "rider_archive_read_only",
                    "message": "Delivery complete — this rider chat is read-only.",
                    "archive_until": archive["archive_until"].isoformat(),
                },
            )
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not an active rider in this conversation")

    # Hard-stop: locked conversations refuse any new messages from
    # participants until an admin unblocks them. Returns 423 Locked so the
    # frontend can render a clear "blocked" banner.
    if conv.blocked_at is not None:
        raise HTTPException(
            status.HTTP_423_LOCKED,
            detail={
                "code": "conversation_blocked",
                "blocked_at": conv.blocked_at.isoformat(),
                "reason": conv.block_reason or "Conversation blocked by safety system.",
                "category": conv.block_category or "policy",
            },
        )

    viewer = _viewer_side(account, conv)
    if viewer == "customer":
        ensure_customer_not_banned(account)
        sender = SenderRole.customer
    elif viewer == "rider":
        sender = SenderRole.rider
    else:
        ensure_pharmacy_not_blocked(account)
        sender = SenderRole.pharmacy

    visibility = (payload.visibility or "all").strip()
    if visibility not in ("all", "customer_rider", "customer_pharmacy", "pharmacy_rider", "customer_only"):
        visibility = "all"
    # `customer_only` is reserved for server-side AI cards — clients can't
    # post into that channel directly.
    if visibility == "customer_only":
        visibility = "all"
    # Restrict who can use private channels:
    # `customer_rider` (== @rider note) is for customer or rider; pharmacy can't use it.
    # `pharmacy_rider` is for pharmacy or rider; customer can't use it.
    if visibility == "customer_rider" and viewer == "pharmacy":
        visibility = "all"
    if visibility == "customer_pharmacy" and viewer == "rider":
        visibility = "all"
    if visibility == "pharmacy_rider" and viewer == "customer":
        visibility = "all"
    # Rider-only channels only make sense once a rider has joined. Customer↔pharmacy
    # private history may exist before/after a rider joins, so keep it scoped.
    if visibility in ("customer_rider", "pharmacy_rider") and not conv.rider_id:
        visibility = "all"

    if (
        sender == SenderRole.pharmacy
        and payload.preset_key in ("pharmacy_handshake_ok", "pharmacy_handshake_reject")
    ):
        target_handshake_id = None
        if isinstance(payload.payload, dict):
            target_handshake_id = (payload.payload or {}).get("handshake_id")
        if not target_handshake_id:
            raise HTTPException(400, "Handshake id required")
        handshake_rows = (await db.execute(
            select(ConversationMessage).where(
                ConversationMessage.conversation_id == conv.id,
                ConversationMessage.preset_key == "ai_handshake",
            ).order_by(ConversationMessage.created_at.desc())
        )).scalars().all()
        target_payload: Dict[str, Any] | None = None
        for row in handshake_rows:
            try:
                row_payload = json.loads(row.payload_json) if row.payload_json else {}
            except Exception:
                row_payload = {}
            if row_payload.get("handshake_id") == target_handshake_id:
                target_payload = row_payload
                break
        if target_payload is None:
            raise HTTPException(409, "Smart Prescription stock check not found")
        if str(target_payload.get("status") or "awaiting_pharmacy") != "awaiting_pharmacy":
            raise HTTPException(409, "Smart Prescription stock check is already closed")

    # ---- Rx hard-block: customer order_request must include prescription
    # if any item is marked prescription_required by the pharmacy. ----
    if (
        sender == SenderRole.customer
        and payload.preset_key == "order_request"
        and payload.payload
        and isinstance(payload.payload, dict)
    ):
        items = payload.payload.get("items") or []
        med_ids: list[UUID] = []
        for it in items:
            mid = (it or {}).get("medicine_id")
            if mid:
                try:
                    med_ids.append(UUID(str(mid)))
                except Exception:
                    continue
        rx_names: list[str] = []
        if med_ids:
            rx_rows = (await db.execute(
                select(Medicine.name).where(
                    Medicine.id.in_(med_ids),
                    Medicine.prescription_required.is_(True),
                )
            )).all()
            rx_names = [r[0] for r in rx_rows]
        if rx_names and not (payload.attachment_url and str(payload.attachment_url).strip()):
            preview = ", ".join(rx_names[:3])
            more = "" if len(rx_names) <= 3 else f" সহ {len(rx_names) - 3} টি অতিরিক্ত item"
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "prescription_required",
                    "message": (
                        f"এই order-এ prescription আবশ্যক ({preview}{more})। "
                        "Order request পাঠানোর আগে prescription upload করুন।"
                    ),
                    "items": rx_names,
                },
            )
        # ---- 5 km connect gate: a chat order_request must carry the
        # customer's delivery point and it must be inside the connect
        # radius of this pharmacy. Blocks both far-away orders and
        # location-less orders (which used to silently fall back to the
        # pharmacy's own coords → 0 km delivery fee). ----
        if items:
            d_lat = payload.payload.get("delivery_lat")
            d_lng = payload.payload.get("delivery_lng")
            try:
                d_lat = float(d_lat) if d_lat is not None else None
                d_lng = float(d_lng) if d_lng is not None else None
            except (TypeError, ValueError):
                d_lat = d_lng = None
            pharm_row = (await db.execute(
                select(PharmacyProfile).where(PharmacyProfile.id == conv.pharmacy_id)
            )).scalar_one_or_none()
            if pharm_row is not None:
                ensure_within_connect_radius(d_lat, d_lng, pharm_row)

    # ---- AI moderation (run BEFORE save so HIGH-risk locks the conv first) ----
    # Skip moderation for: empty body, system messages, structured presets
    # (order_request, etc.), and @mediai mention messages (those are user
    # asking the bot, not violating content).
    verdict: Dict[str, Any] = {"risk": "none", "category": "none", "reason": ""}
    if body and sender != SenderRole.system and not payload.preset_key and not has_ai_mention(body):
        try:
            verdict = await moderate_message(body)
        except Exception:
            verdict = {"risk": "none", "category": "none", "reason": ""}

    risk = str(verdict.get("risk", "none")).lower()
    cat = str(verdict.get("category", "none"))[:40]
    reason = (verdict.get("reason") or "").strip()[:300]

    now = datetime.utcnow()
    msg = ConversationMessage(
        conversation_id=conv.id,
        sender_role=sender,
        body=body,
        attachment_url=payload.attachment_url,
        preset_key=payload.preset_key,
        payload_json=json.dumps(payload.payload) if payload.payload else None,
        visibility=visibility,
        moderation_risk=risk if risk in ("low", "medium", "high") else None,
        moderation_category=cat if risk in ("low", "medium", "high") else None,
        moderation_reason=reason if risk in ("low", "medium", "high") else None,
        was_blocked=(risk == "high"),
        created_at=now,
    )
    db.add(msg)
    conv.last_message_at = now
    if viewer == "customer":
        conv.customer_last_read_at = now
    elif viewer == "rider":
        conv.rider_last_read_at = now
    else:
        conv.pharmacy_last_read_at = now

    # ---- Post AI moderation system messages + lock state ----
    sender_label = _sender_display_name(account, conv, viewer)
    if risk == "high":
        conv.blocked_at = now
        conv.block_reason = reason or "নিরাপত্তা নীতি ভঙ্গের জন্য conversation block করা হলো।"
        conv.block_category = cat
        conv.flag_count = int(conv.flag_count or 0) + 1
        block_text = (
            f"⛔ Conversation locked by medi AI\n"
            f"কারণ: {conv.block_reason}\n"
            f"Admin review না হওয়া পর্যন্ত আর message পাঠানো যাবে না।"
        )
        db.add(ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.system,
            body=block_text,
            preset_key="ai_block",
            payload_json=json.dumps({"category": cat, "risk": "high", "sender": sender_label}),
            visibility="all",
        ))
    elif risk == "medium":
        conv.flag_count = int(conv.flag_count or 0) + 1
        warn_text = (
            f"🚨 medi AI সতর্কতা — {sender_label}\n"
            f"{reason or 'এই কথা platform-policy ভঙ্গ করছে।'}\n"
            f"আবার হলে conversation auto-block হবে এবং admin notify হবে।"
        )
        db.add(ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.system,
            body=warn_text,
            preset_key="ai_warn_medium",
            payload_json=json.dumps({"category": cat, "risk": "medium", "sender": sender_label}),
            visibility="all",
        ))
    elif risk == "low":
        warn_text = (
            f"⚠️ medi AI tip — {sender_label}: {reason or 'একটু সাবধানে কথা বলুন।'}"
        )
        db.add(ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.system,
            body=warn_text,
            preset_key="ai_warn_low",
            payload_json=json.dumps({"category": cat, "risk": "low", "sender": sender_label}),
            visibility="all",
        ))

    # If the message was hard-blocked, skip downstream side-effects (no
    # order materialisation, no rider broadcast, no @mediai reply).
    if risk == "high":
        await db.commit()
        await db.refresh(msg)
        return _msg_dict(msg)

    # ---- chat → Order linkage (preset side-effects) ----
    if sender == SenderRole.pharmacy and payload.preset_key == "order_confirm":
        # Pharmacy confirmed the order — materialise an Order row but do NOT
        # broadcast yet. Pharmacy clicks "Call rider" separately.
        order = await _ensure_chat_order(conv, db)
        # If this Order was pre-created (e.g. AI prescription dispatch) and
        # is still `pending`, advance it to `confirmed` so customer/pharmacy
        # status views reflect the chat acceptance.
        if order is not None and order.status == OrderStatus.pending:
            order.status = OrderStatus.confirmed
    elif sender == SenderRole.pharmacy and payload.preset_key == "call_rider":
        # Pharmacy explicitly summons a rider for this conversation.
        order = await _ensure_chat_order(conv, db)
        if order is not None:
            if order.status not in (
                OrderStatus.delivered, OrderStatus.rejected, OrderStatus.cancelled,
            ):
                order.status = OrderStatus.ready
                order.updated_at = now
            await _broadcast_riders_for_order(order, db)
    elif payload.preset_key == "handed_over":
        order = None
        if account.rider is not None:
            order = (await db.execute(
                select(Order)
                .where(
                    Order.conversation_id == conv.id,
                    Order.accepted_rider_id == account.rider.id,
                    Order.status == OrderStatus.dispatched,
                )
                .order_by(desc(Order.created_at))
                .limit(1)
            )).scalar_one_or_none()
        if order is None:
            order = (await db.execute(
                select(Order)
                .where(
                    Order.conversation_id == conv.id,
                    Order.status == OrderStatus.dispatched,
                )
                .order_by(desc(Order.created_at))
                .limit(1)
            )).scalar_one_or_none()
        if order is not None:
            picked = (await db.execute(
                select(OrderMessage.id).where(
                    OrderMessage.order_id == order.id,
                    OrderMessage.preset_key == "picked_up",
                ).limit(1)
            )).scalar_one_or_none()
            if picked is None:
                order.updated_at = now
                db.add(OrderMessage(
                    order_id=order.id,
                    sender_role=sender,
                    body="🚲 Order picked up — heading to customer.",
                    preset_key="picked_up",
                ))
    elif payload.preset_key == "order_reject":
        # Either side can reject/cancel the active order from chat.
        # Mark the most-recent Order for this conversation as rejected/cancelled
        # so analytics + the next order_request work correctly.
        order = (await db.execute(
            select(Order).where(Order.conversation_id == conv.id)
            .order_by(Order.created_at.desc()).limit(1)
        )).scalar_one_or_none()
        if order and order.status not in (
            OrderStatus.delivered, OrderStatus.rejected, OrderStatus.cancelled,
        ):
            order.status = (
                OrderStatus.cancelled if sender == SenderRole.customer
                else OrderStatus.rejected
            )
            order.updated_at = now
            # Return reserved stock to inventory (no-op if nothing was held).
            await restore_order_stock(db, order)
            # If a rider was assigned, free them up.
            if conv.rider_id is not None:
                db.add(ConversationMessage(
                    conversation_id=conv.id,
                    sender_role=SenderRole.system,
                    body="🛵 Rider has left the chat — order cancelled.",
                    preset_key="rider_left",
                    visibility="all",
                    created_at=now,
                ))
                conv.rider_id = None
            open_offers = (await db.execute(
                select(RiderOffer).where(
                    RiderOffer.order_id == order.id,
                    RiderOffer.status == RiderOfferStatus.offered,
                )
            )).scalars().all()
            for offer in open_offers:
                offer.status = RiderOfferStatus.expired
                offer.responded_at = datetime.now(timezone.utc)
    elif sender == SenderRole.rider and payload.preset_key == "delivery_complete":
        # Rider marks the delivery complete via chat.
        order = None
        if account.rider is not None:
            order = (await db.execute(
                select(Order)
                .where(
                    Order.conversation_id == conv.id,
                    Order.accepted_rider_id == account.rider.id,
                    Order.status.not_in(RIDER_ARCHIVE_STATUSES),
                )
                .order_by(desc(Order.created_at))
                .limit(1)
            )).scalar_one_or_none()
        if order is None:
            order = (await db.execute(
                select(Order).where(Order.conversation_id == conv.id)
                .order_by(Order.created_at.desc()).limit(1)
            )).scalar_one_or_none()
        if order and order.status != OrderStatus.delivered:
            picked = (await db.execute(
                select(OrderMessage.id).where(
                    OrderMessage.order_id == order.id,
                    OrderMessage.preset_key == "picked_up",
                ).limit(1)
            )).scalar_one_or_none()
            if picked is None:
                raise HTTPException(409, "Mark pickup before delivery")
            order.status = OrderStatus.delivered
            order.updated_at = now
            db.add(OrderMessage(
                order_id=order.id, sender_role=SenderRole.rider,
                body="✅ Delivered to customer.", preset_key="delivered",
            ))
        # Auto-detach the rider from this conversation (they "leave the
        # group") so the customer↔pharmacy thread is back to a 1-to-1 chat
        # for any post-delivery follow-up. The rider can still see the
        # finished thread in their own history if we kept a record, but
        # clearing rider_id removes the conversation from their active list.
        if conv.rider_id is not None:
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=SenderRole.system,
                body="🛵 Rider has left the chat — delivery complete.",
                preset_key="rider_left",
                visibility="all",
                created_at=now,
            ))
            conv.rider_id = None
    elif (
        sender == SenderRole.pharmacy
        and payload.preset_key in ("pharmacy_handshake_ok", "pharmacy_handshake_reject")
    ):
        # Pharmacy responded to a `/prescription-handshake` ai_handshake card.
        # Find the matching ai_handshake message in this conversation, mark its
        # payload as accepted/rejected, and (on accept) auto-post an
        # `ai_customer_confirm_prompt` so the customer sees a Final-Confirm
        # button right inside the chat (matching the modal-side button).
        target_handshake_id: str | None = None
        if isinstance(payload.payload, dict):
            target_handshake_id = (payload.payload or {}).get("handshake_id")
        handshake_rows = (await db.execute(
            select(ConversationMessage).where(
                ConversationMessage.conversation_id == conv.id,
                ConversationMessage.preset_key == "ai_handshake",
            ).order_by(ConversationMessage.created_at.desc())
        )).scalars().all()
        target_row: ConversationMessage | None = None
        for row in handshake_rows:
            try:
                pl = json.loads(row.payload_json) if row.payload_json else {}
            except Exception:
                pl = {}
            if str(pl.get("status") or "awaiting_pharmacy") != "awaiting_pharmacy":
                continue
            if target_handshake_id and pl.get("handshake_id") != target_handshake_id:
                continue
            target_row = row
            break
        if target_row is not None:
            try:
                tp = json.loads(target_row.payload_json) if target_row.payload_json else {}
            except Exception:
                tp = {}
            if payload.preset_key == "pharmacy_handshake_ok":
                tp["status"] = "pharmacy_ok"
                target_row.payload_json = json.dumps(tp, ensure_ascii=False)
                db.add(target_row)
                # Auto-prompt the customer with a Final-Confirm card
                confirm_payload = {
                    "handshake_id": tp.get("handshake_id"),
                    "items": tp.get("items") or [],
                    "subtotal": tp.get("subtotal"),
                    "delivery_fee": tp.get("delivery_fee"),
                    "total": tp.get("total"),
                    "prescription_url": tp.get("prescription_url"),
                    "pharmacy_id": tp.get("pharmacy_id"),
                    "pharmacy_name": tp.get("pharmacy_name"),
                    "note": tp.get("note"),
                    "delivery_address": tp.get("delivery_address"),
                    "delivery_lat": tp.get("delivery_lat"),
                    "delivery_lng": tp.get("delivery_lng"),
                    "split_part": tp.get("split_part"),
                    "split_total": tp.get("split_total"),
                    "status": "awaiting_customer",
                }
                db.add(ConversationMessage(
                    conversation_id=conv.id,
                    sender_role=SenderRole.system,
                    body=(
                        f"✅ Pharmacy stock confirm — ৳{float(tp.get('total') or 0):.0f}"
                    ),
                    preset_key="ai_customer_confirm_prompt",
                    payload_json=json.dumps(confirm_payload, ensure_ascii=False),
                    visibility="all",
                ))
                # Push a customer notification so the cancel-race is solved
                # even if the Smart-Rx modal was closed mid-handshake. The
                # customer can tap the notification to land back in the
                # conversation and Final-Confirm directly from the bubble.
                try:
                    await user_notify(
                        db, conv.customer_account_id,
                        kind="ai_alert",
                        title="Pharmacy ready ✅",
                        body_bn=(
                            f"{tp.get('pharmacy_name') or 'Pharmacy'} আপনার Rx order-এ "
                            f"stock confirm করেছে (৳{float(tp.get('total') or 0):.0f})। "
                            "Final Confirm দিন।"
                        ),
                        payload={
                            "conversation_id": str(conv.id),
                            "handshake_id": tp.get("handshake_id"),
                            "kind": "ai_customer_confirm_prompt",
                        },
                    )
                except Exception as exc:  # pragma: no cover — best-effort
                    print(f"[ai_handshake] notify failed: {type(exc).__name__}: {exc}")
            else:  # pharmacy_handshake_reject
                tp["status"] = "rejected"
                tp["pharmacy_reason"] = (body or "")[:300]
                target_row.payload_json = json.dumps(tp, ensure_ascii=False)
                db.add(target_row)
                db.add(ConversationMessage(
                    conversation_id=conv.id,
                    sender_role=SenderRole.system,
                    body="❌ Pharmacy stock নেই — অন্য pharmacy try করুন।",
                    preset_key="ai_handshake_rejected",
                    payload_json=json.dumps({
                        "handshake_id": tp.get("handshake_id"),
                        "pharmacy_reason": tp.get("pharmacy_reason"),
                    }),
                    visibility="all",
                ))
    elif (
        sender == SenderRole.customer
        and payload.preset_key == "customer_handshake_cancel"
    ):
        # Customer cancels the open handshake (either before or after pharmacy
        # accepted). No credit is consumed. Mark every open ai_handshake +
        # ai_customer_confirm_prompt row for the targeted handshake_id as
        # cancelled and post a single "customer cancelled" pill the pharmacy
        # can see, so they stop expecting a final confirm.
        target_handshake_id = None
        if isinstance(payload.payload, dict):
            target_handshake_id = (payload.payload or {}).get("handshake_id")
        open_rows = (await db.execute(
            select(ConversationMessage).where(
                ConversationMessage.conversation_id == conv.id,
                ConversationMessage.preset_key.in_(
                    ("ai_handshake", "ai_customer_confirm_prompt")
                ),
            )
        )).scalars().all()
        cancelled_any = False
        for row in open_rows:
            try:
                rp = json.loads(row.payload_json) if row.payload_json else {}
            except Exception:
                rp = {}
            if rp.get("status") in ("confirmed", "rejected", "cancelled"):
                continue
            if target_handshake_id and rp.get("handshake_id") != target_handshake_id:
                continue
            rp["status"] = "cancelled"
            row.payload_json = json.dumps(rp, ensure_ascii=False)
            db.add(row)
            cancelled_any = True
        # Bug #10 — if Final-Confirm already created an Order, cancel that
        # Order too (provided pharmacy hasn't started preparing it yet).
        # Walk ai_handshake_completed rows for this handshake_id to find
        # the associated order_id(s), then mark each pending Order as
        # cancelled and notify via OrderMessage.
        cancelled_order_ids: list[str] = []
        completed_rows = (await db.execute(
            select(ConversationMessage).where(
                ConversationMessage.conversation_id == conv.id,
                ConversationMessage.preset_key == "ai_handshake_completed",
            )
        )).scalars().all()
        order_ids_to_check: set[str] = set()
        for crow in completed_rows:
            try:
                cp = json.loads(crow.payload_json) if crow.payload_json else {}
            except Exception:
                cp = {}
            if target_handshake_id and cp.get("handshake_id") != target_handshake_id:
                # Also accept handshake_ids list match
                hids = cp.get("handshake_ids") or []
                if target_handshake_id not in hids:
                    continue
            oid = cp.get("order_id")
            if oid:
                order_ids_to_check.add(str(oid))
        if order_ids_to_check:
            try:
                order_uuids = [UUID(x) for x in order_ids_to_check]
            except Exception:
                order_uuids = []
            if order_uuids:
                pending_orders = (await db.execute(
                    select(Order).where(
                        Order.id.in_(order_uuids),
                        Order.status.in_((OrderStatus.pending,)),
                    )
                )).scalars().all()
                for ord_row in pending_orders:
                    ord_row.status = OrderStatus.cancelled
                    db.add(ord_row)
                    db.add(OrderMessage(
                        order_id=ord_row.id,
                        sender_role=SenderRole.system,
                        body="🚫 Customer cancelled the order via chat.",
                        preset_key="cancelled",
                    ))
                    cancelled_order_ids.append(str(ord_row.id))
        if cancelled_any:
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=SenderRole.system,
                body=(
                    "🚫 Customer order cancel করেছে।"
                    + (f" (Order #{cancelled_order_ids[0][:8]} cancelled)" if cancelled_order_ids else "")
                ),
                preset_key="ai_handshake_cancelled",
                payload_json=json.dumps({
                    "handshake_id": target_handshake_id,
                    "cancelled_order_ids": cancelled_order_ids,
                }),
                visibility="all",
            ))

    # ---- Smart Prescription add-on listener ----
    # Pharmacy free-form question like "আর কিছু নিবেন?" → in Smart Rx only,
    # AI posts a system card so the customer can 1-tap request suggestions
    # from this pharmacy's catalog. Manual orders intentionally do nothing.
    if (
        sender == SenderRole.pharmacy
        and not payload.preset_key
        and body
        and _is_addon_inquiry(body)
    ):
        from app.services.ai_proxy import has_active_smart_prescription_context

        smart_rx_context = await has_active_smart_prescription_context(conv, db)

        # Don't spam — skip if an unanswered ai_addon_prompt was posted in the
        # last 6 messages of this conversation.
        if smart_rx_context:
            recent_msgs = (await db.execute(
                select(ConversationMessage)
                .where(ConversationMessage.conversation_id == conv.id)
                .order_by(ConversationMessage.created_at.desc())
                .limit(6)
            )).scalars().all()
            already_prompted = any(
                (m.preset_key == "ai_addon_prompt") for m in recent_msgs
            )
            if not already_prompted:
                db.add(ConversationMessage(
                    conversation_id=conv.id,
                    sender_role=SenderRole.system,
                    body="🤖 Pharmacy আর কিছু লাগবে কিনা জানতে চাইছে।",
                    preset_key="ai_addon_prompt",
                    payload_json=json.dumps({
                        "pharmacy_question": (body or "")[:240],
                        "pharmacy_id": str(conv.pharmacy_id),
                        "conversation_id": str(conv.id),
                    }, ensure_ascii=False),
                    visibility="all",
                ))

    # ---- @mediai mention (run only if not blocked / warned high) ----
    if body and sender != SenderRole.system and has_ai_mention(body):
        try:
            recent = (await db.execute(
                select(ConversationMessage)
                .where(ConversationMessage.conversation_id == conv.id)
                .order_by(ConversationMessage.created_at.desc())
                .limit(8)
            )).scalars().all()
            history = [
                {"role": m.sender_role.value, "body": m.body or ""}
                for m in reversed(recent) if m.body
            ]
            ai_text = await mediai_reply_for_chat(history, body)
        except Exception:
            ai_text = None
        if ai_text:
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=SenderRole.system,
                body=ai_text,
                preset_key="ai_reply",
                visibility="all",
            ))

    # ---- medi AI proxy reply (Phase 7) ----------------------------------
    # Pharmacy / rider sent a free-form message and an order/handshake is
    # active → either auto-answer in the customer's voice OR post a
    # private `customer_only` question card. Best-effort — never blocks
    # the original message commit.
    if (
        risk != "high"
        and sender in (SenderRole.pharmacy, SenderRole.rider)
        and not payload.preset_key
        and body
        and not has_ai_mention(body)
    ):
        try:
            from app.services.ai_proxy import maybe_proxy_reply  # local import (avoid cycles)
            await maybe_proxy_reply(conv, msg, db)
        except Exception as exc:  # pragma: no cover — proxy is best-effort
            print(f"[ai_proxy] reply failed: {type(exc).__name__}: {exc}")

    await db.commit()
    await db.refresh(msg)
    return _msg_dict(msg)


class AiProxyAnswerIn(BaseModel):
    parent_question_id: UUID
    answer: str = Field(..., min_length=1, max_length=1200)


class AiProxyMessageIn(BaseModel):
    body: str = Field(..., min_length=1, max_length=1200)
    target: str = Field(default="pharmacy", max_length=20)


@router.post("/{conversation_id}/ai-proxy-answer", status_code=201)
async def ai_proxy_answer(
    conversation_id: UUID,
    payload: AiProxyAnswerIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Customer answers an `ai_question_for_customer` card. The answer is
    posted as a scoped customer message so pharmacy / rider sees a natural
    reply, while the original card is marked answered so the UI can swap the
    input for a checkmark.
    """
    conv = await _get_conversation_or_403(conversation_id, account, db)
    if account.id != conv.customer_account_id:
        raise HTTPException(403, "Only the customer can answer their own AI question")
    ensure_customer_not_banned(account)
    if conv.blocked_at is not None:
        raise HTTPException(
            status.HTTP_423_LOCKED,
            detail={"code": "conversation_blocked", "message": "Conversation locked."},
        )

    # Keep answer submission aligned with the same lazy timeout semantics as
    # GET /messages. Otherwise a customer could answer a card from a stock
    # check that has already expired but has not been reloaded yet.
    await _expire_stale_handshakes(conv, db)

    parent = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.id == payload.parent_question_id,
            ConversationMessage.conversation_id == conv.id,
            ConversationMessage.preset_key == "ai_question_for_customer",
        )
    )).scalar_one_or_none()
    if not parent:
        raise HTTPException(404, "AI question not found in this conversation")

    parent_payload: Dict[str, Any] = {}
    if parent.payload_json:
        try:
            parsed = json.loads(parent.payload_json)
            parent_payload = parsed if isinstance(parsed, dict) else {}
        except Exception:
            parent_payload = {}
    if (getattr(parent, "visibility", "all") or "all") != "customer_only":
        raise HTTPException(409, "AI question is not answerable")
    if str(parent_payload.get("status") or "open").lower() == "answered":
        raise HTTPException(409, "AI question is already answered")

    from app.services.ai_proxy import active_smart_prescription_context_since, relay_customer_answer_to_other_side

    active_since = await active_smart_prescription_context_since(conv, db)
    parent_time = _naive_utc(parent.created_at)
    since_time = _naive_utc(active_since)
    parent_context_time: datetime | None = None
    parent_context_raw = parent_payload.get("smart_context_started_at")
    if parent_context_raw:
        try:
            parent_context_time = _naive_utc(
                datetime.fromisoformat(str(parent_context_raw).replace("Z", "+00:00"))
            )
        except Exception:
            parent_context_time = None

    context_mismatch = False
    if parent_context_time is not None:
        context_mismatch = (
            since_time is None
            or abs((since_time - parent_context_time).total_seconds()) > 2
        )
    elif parent_time is not None and since_time is not None:
        context_mismatch = parent_time < since_time

    if active_since is None or context_mismatch or (
        parent_time is not None and since_time is not None and parent_time < since_time
    ):
        parent_payload["status"] = "expired"
        parent.payload_json = json.dumps(parent_payload, ensure_ascii=False)
        db.add(parent)
        await db.commit()
        raise HTTPException(409, "AI question expired")

    answer = (payload.answer or "").strip()
    verdict: Dict[str, Any] = {"risk": "none", "category": "none", "reason": ""}
    try:
        verdict = await moderate_message(answer)
    except Exception:
        verdict = {"risk": "none", "category": "none", "reason": ""}
    risk = str(verdict.get("risk", "none")).lower()
    cat = str(verdict.get("category", "none"))[:40]
    reason = (verdict.get("reason") or "").strip()[:300]

    reply = await relay_customer_answer_to_other_side(
        conv, payload.parent_question_id, answer, db,
    )
    now = datetime.utcnow()
    reply.created_at = reply.created_at or now
    reply.moderation_risk = risk if risk in ("low", "medium", "high") else None
    reply.moderation_category = cat if risk in ("low", "medium", "high") else None
    reply.moderation_reason = reason if risk in ("low", "medium", "high") else None
    reply.was_blocked = risk == "high"
    if risk == "high":
        conv.blocked_at = now
        conv.block_reason = reason or "নিরাপত্তা নীতি ভঙ্গের জন্য conversation block করা হলো।"
        conv.block_category = cat
        conv.flag_count = int(conv.flag_count or 0) + 1
        db.add(ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.system,
            body=(
                "⛔ Conversation locked by medi AI\n"
                f"কারণ: {conv.block_reason}\n"
                "Admin review না হওয়া পর্যন্ত আর message পাঠানো যাবে না।"
            ),
            preset_key="ai_block",
            payload_json=json.dumps({"category": cat, "risk": "high", "sender": "customer"}),
            visibility="all",
            created_at=now,
        ))
    conv.last_message_at = now
    conv.customer_last_read_at = now
    await db.commit()
    await db.refresh(reply)
    return _msg_dict(reply)


@router.post("/{conversation_id}/ai-proxy-message", status_code=201)
async def ai_proxy_message(
    conversation_id: UUID,
    payload: AiProxyMessageIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Customer sends a message from the MediAI inbox/control surface.

    The row is still a normal customer-side conversation message, but it is
    audited with `preset_key=ai_proxy_reply` and scoped to the chosen target so
    the customer can coordinate with pharmacy/rider without switching threads.
    """
    conv = await _get_conversation_or_403(conversation_id, account, db)
    if account.id != conv.customer_account_id:
        raise HTTPException(403, "Only the customer can send via MediAI")
    ensure_customer_not_banned(account)
    if conv.blocked_at is not None:
        raise HTTPException(
            status.HTTP_423_LOCKED,
            detail={"code": "conversation_blocked", "message": "Conversation locked."},
        )

    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(400, "Message body required")
    target = (payload.target or "pharmacy").strip().lower()
    if target not in ("pharmacy", "rider", "all"):
        target = "pharmacy"
    if target == "rider" and conv.rider_id is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"code": "no_active_rider", "message": "No rider is active in this conversation."},
        )

    visibility = {
        "pharmacy": "customer_pharmacy",
        "rider": "customer_rider",
        "all": "all",
    }[target]

    verdict: Dict[str, Any] = {"risk": "none", "category": "none", "reason": ""}
    try:
        verdict = await moderate_message(body)
    except Exception:
        verdict = {"risk": "none", "category": "none", "reason": ""}
    risk = str(verdict.get("risk", "none")).lower()
    cat = str(verdict.get("category", "none"))[:40]
    reason = (verdict.get("reason") or "").strip()[:300]

    now = datetime.utcnow()
    msg = ConversationMessage(
        conversation_id=conv.id,
        sender_role=SenderRole.customer,
        body=body[:1200],
        preset_key="ai_proxy_reply",
        payload_json=json.dumps({
            "ai_proxy": True,
            "via_medi_ai_inbox": True,
            "target": target,
        }, ensure_ascii=False),
        visibility=visibility,
        moderation_risk=risk if risk in ("low", "medium", "high") else None,
        moderation_category=cat if risk in ("low", "medium", "high") else None,
        moderation_reason=reason if risk in ("low", "medium", "high") else None,
        was_blocked=(risk == "high"),
        created_at=now,
    )
    db.add(msg)
    conv.last_message_at = now
    conv.customer_last_read_at = now

    if risk == "high":
        conv.blocked_at = now
        conv.block_reason = reason or "নিরাপত্তা নীতি ভঙ্গের জন্য conversation block করা হলো।"
        conv.block_category = cat
        conv.flag_count = int(conv.flag_count or 0) + 1
        db.add(ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.system,
            body=(
                "⛔ Conversation locked by medi AI\n"
                f"কারণ: {conv.block_reason}\n"
                "Admin review না হওয়া পর্যন্ত আর message পাঠানো যাবে না।"
            ),
            preset_key="ai_block",
            payload_json=json.dumps({"category": cat, "risk": "high", "sender": "Customer via MediAI"}),
            visibility="all",
            created_at=now,
        ))
    elif risk == "medium":
        conv.flag_count = int(conv.flag_count or 0) + 1
        db.add(ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.system,
            body=f"🚨 medi AI সতর্কতা — Customer via MediAI\n{reason or 'এই কথা platform-policy ভঙ্গ করছে।'}",
            preset_key="ai_warn_medium",
            payload_json=json.dumps({"category": cat, "risk": "medium", "sender": "Customer via MediAI"}),
            visibility="all",
            created_at=now,
        ))

    await db.commit()
    await db.refresh(msg)
    return _msg_dict(msg)


def _sender_display_name(account: Account, conv: Conversation, viewer: str) -> str:
    """Best-effort human-readable label for moderation system messages."""
    try:
        if viewer == "customer":
            if account.customer:
                full = f"{account.customer.first_name or ''} {account.customer.last_name or ''}".strip()
                if full:
                    return full
            return conv.customer_name or "Customer"
        if viewer == "pharmacy" and account.pharmacy:
            return account.pharmacy.pharmacy_name or "Pharmacy"
        if viewer == "rider" and account.rider:
            return account.rider.nick_name or account.rider.full_name or "Rider"
    except Exception:
        pass
    return viewer.capitalize()


async def _ensure_chat_order(
    conv: Conversation, db: AsyncSession,
) -> Order | None:
    """Idempotently create the Order row for this chat conversation.

    Reads the most recent `order_request` payload to populate items / totals.
    Returns the existing Order if one already exists for this conversation.
    No rider broadcast happens here — see `_broadcast_riders_for_order`.
    """
    pharm = (await db.execute(
        select(PharmacyProfile).where(PharmacyProfile.id == conv.pharmacy_id)
    )).scalar_one_or_none()
    if not pharm:
        return None

    cust_profile = (await db.execute(
        select(CustomerProfile).where(
            CustomerProfile.account_id == conv.customer_account_id
        )
    )).scalar_one_or_none()
    cust_name = (
        f"{cust_profile.first_name or ''} {cust_profile.last_name or ''}".strip()
        if cust_profile else "Chat customer"
    ) or "Chat customer"
    cust_phone = (cust_profile.phone_number if cust_profile else None) or "+8800000000000"

    history = (await db.execute(
        select(ConversationMessage)
        .where(ConversationMessage.conversation_id == conv.id)
        .order_by(ConversationMessage.created_at.desc())
    )).scalars().all()
    last_request: ConversationMessage | None = None
    for m in history:
        if m.preset_key == "order_request":
            last_request = m
            break

    existing = (await db.execute(
        select(Order).where(Order.conversation_id == conv.id)
        .order_by(Order.created_at.desc()).limit(1)
    )).scalar_one_or_none()
    # Re-use only if the previous order is still active AND it was created
    # after the latest order_request. A single customer↔pharmacy conversation
    # can contain many sequential prescription/order requests; an older active
    # chat order must not swallow a newly confirmed AI prescription request.
    if existing and existing.status not in (
        OrderStatus.delivered, OrderStatus.rejected, OrderStatus.cancelled,
    ):
        if not last_request or not existing.created_at or not last_request.created_at:
            return existing
        if existing.created_at >= last_request.created_at:
            return existing

    items_json_str = "[]"
    order_items: list = []
    subtotal = 0.0
    delivery_fee: float | None = None  # None → compute from distance below
    note = f"Chat conversation {conv.id}"
    delivery_address = "Chat-based order — see conversation"
    delivery_lat = pharm.lat
    delivery_lng = pharm.lng

    if last_request and last_request.payload_json:
        try:
            data = json.loads(last_request.payload_json)
            items = data.get("items") or []
            if items:
                items_json_str = json.dumps(items)
                order_items = items
            subtotal = float(data.get("subtotal") or 0)
            if data.get("delivery_fee") is not None:
                delivery_fee = float(data["delivery_fee"])
            if data.get("delivery_address"):
                delivery_address = str(data["delivery_address"])[:500]
            if data.get("delivery_lat") is not None:
                delivery_lat = float(data["delivery_lat"])
            if data.get("delivery_lng") is not None:
                delivery_lng = float(data["delivery_lng"])
            if data.get("note"):
                note = str(data["note"])[:1000]
        except Exception:
            pass

    # 5 km connect gate (defense in depth — new order_requests are already
    # gated at post time; legacy payloads without coords keep the pharmacy
    # fallback rather than breaking old threads).
    if (
        delivery_lat is not None and delivery_lng is not None
        and pharm.lat is not None and pharm.lng is not None
    ):
        d_check = _km(delivery_lat, delivery_lng, pharm.lat, pharm.lng)
        if d_check > CONNECT_RADIUS_KM:
            raise HTTPException(409, (
                f"Delivery location pharmacy থেকে {d_check:.1f} km দূরে — "
                f"MediDoor-এ {CONNECT_RADIUS_KM:.0f} km-এর মধ্যে delivery হয়।"
            ))

    # When the request didn't carry an explicit fee, fall back to the same
    # 10 BDT/km distance rule the storefront uses (pharmacy → customer).
    if delivery_fee is None:
        dist_km = None
        if (
            delivery_lat is not None and delivery_lng is not None
            and pharm.lat is not None and pharm.lng is not None
        ):
            dist_km = _km(delivery_lat, delivery_lng, pharm.lat, pharm.lng)
        delivery_fee = delivery_fee_for_distance(dist_km)

    total = round(subtotal + delivery_fee, 2)
    rx_url = (
        last_request.attachment_url
        if (last_request and last_request.attachment_url) else None
    )
    order = Order(
        pharmacy_id=pharm.id,
        customer_account_id=conv.customer_account_id,
        customer_name=cust_name,
        customer_phone=cust_phone,
        delivery_address=delivery_address,
        delivery_lat=delivery_lat,
        delivery_lng=delivery_lng,
        items_json=items_json_str,
        prescription_url=rx_url,
        note=note,
        subtotal=subtotal,
        delivery_fee=delivery_fee,
        total=total,
        # Chat orders now follow the normal lifecycle: pharmacy "confirm" puts
        # it in `confirmed` (opens the modify window); "Call rider" advances it
        # to `ready`. This unifies chat orders with manual/AI orders instead of
        # jumping straight to `ready`.
        status=OrderStatus.confirmed,
        conversation_id=conv.id,
    )
    # Reserve stock now so chat orders can't oversell (manual + AI orders
    # already do this). Raises 409 if a medicine is short — the pharmacy's
    # confirm is then rejected with a clear reason. Restored on cancel/reject.
    await reserve_items_stock(db, order_items)
    order.stock_reserved = True
    db.add(order)
    await db.flush()
    db.add(OrderMessage(
        order_id=order.id, sender_role=SenderRole.system,
        body="📦 Chat order confirmed.",
        preset_key="placed",
    ))
    return order


async def _broadcast_riders_for_order(order: Order, db: AsyncSession) -> int:
    """Broadcast a RiderOffer to every eligible rider around the pharmacy —
    shared rules (verified + fresh ping + 5 km) in app/services/dispatch.py.
    Idempotent-ish: if offers already exist for this order, returns 0."""
    pharm = (await db.execute(
        select(PharmacyProfile).where(PharmacyProfile.id == order.pharmacy_id)
    )).scalar_one_or_none()
    if not pharm or pharm.lat is None or pharm.lng is None:
        return 0
    existing = (await db.execute(
        select(RiderOffer).where(RiderOffer.order_id == order.id).limit(1)
    )).scalar_one_or_none()
    if existing:
        return 0
    offers = await broadcast_rider_offers(db, order, pharm)
    sent = len(offers)
    if sent:
        db.add(OrderMessage(
            order_id=order.id, sender_role=SenderRole.system,
            body=f"📣 {sent} rider(s) notified within {RIDER_BROADCAST_RADIUS_KM:.0f} km.",
            preset_key="dispatched",
        ))
    return sent


@router.post("/{conversation_id}/seen", status_code=200)
async def mark_seen(
    conversation_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Mark all messages in this conversation as seen by the calling side.
    Updates customer_last_read_at or pharmacy_last_read_at."""
    conv = await _get_conversation_or_403(conversation_id, account, db)
    now = datetime.utcnow()
    viewer = _viewer_side(account, conv)
    if viewer == "customer":
        conv.customer_last_read_at = now
    elif viewer == "rider":
        conv.rider_last_read_at = now
    else:
        conv.pharmacy_last_read_at = now
    await db.commit()
    return {"ok": True, "side": viewer, "at": now.isoformat()}
