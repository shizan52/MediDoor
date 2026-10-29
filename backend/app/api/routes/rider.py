"""Rider-side endpoints — accept offers dispatched within the platform
5 km connect radius (app/services/geo_policy.py)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_account, get_db
from app.models import (
    Account,
    Conversation,
    ConversationMessage,
    CustomerProfile,
    Order,
    OrderMessage,
    OrderStatus,
    PharmacyProfile,
    RiderOffer,
    RiderOfferStatus,
    RoleEnum,
    SenderRole,
)
from sqlalchemy.orm import selectinload
from app.services.notify import notify as user_notify

router = APIRouter(prefix="/api/rider", tags=["rider"])


def _require_rider(account: Account):
    if account.role != RoleEnum.rider or not account.rider:
        raise HTTPException(403, "Rider role required")
    return account.rider


def _require_verified_rider(account: Account):
    """Stricter guard for endpoints that imply the rider is "on duty".

    Used by the location ping (== going online) and offer-acceptance, so an
    un-verified rider can browse the app but cannot actually take orders or
    advertise their location to dispatching. The client maps the 403 detail
    to a friendly Bengali banner on the dashboard.
    """
    r = _require_rider(account)
    if not r.is_verified:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "rider_not_verified",
                "verification_status": r.verification_status or "pending",
                "verification_note": r.verification_note,
                "message": (
                    "আপনার rider account এখনো MediDoor admin দ্বারা verify হয়নি। "
                    "Verification সম্পন্ন না হওয়া পর্যন্ত আপনি online হতে পারবেন না।"
                ),
            },
        )
    return r


class LocationPing(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    # GPS 1-σ accuracy in metres, when the client knows it. Fixes worse than
    # MAX_PING_ACCURACY_M (IP/coarse Wi-Fi lookups) are rejected — a rider
    # must be on a device with real GPS to go online.
    accuracy_m: float | None = Field(default=None, ge=0)


MAX_PING_ACCURACY_M = 1000.0


@router.post("/me/ping")
async def ping_location(
    payload: LocationPing,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    r = _require_verified_rider(account)
    if payload.accuracy_m is not None and payload.accuracy_m > MAX_PING_ACCURACY_M:
        return {
            "ok": False,
            "code": "gps_accuracy_poor",
            "message": (
                "এই device-এ সঠিক GPS location পাওয়া যাচ্ছে না। "
                "Mobile বা GPS-সহ device দিয়ে login করুন — তবেই online হতে পারবেন।"
            ),
        }
    r.last_lat = payload.lat
    r.last_lng = payload.lng
    r.last_seen_at = datetime.now(timezone.utc)
    # Coming online (or moving) makes this rider eligible for orders that were
    # broadcast while they were offline/stale — without this backfill an order
    # whose "Call rider" fired when no rider was fresh strands in `ready`
    # forever. Best-effort: a backfill failure must never break the ping.
    new_offers = 0
    try:
        from app.services.dispatch import backfill_offers_for_rider
        new_offers = len(await backfill_offers_for_rider(db, r))
    except Exception:
        new_offers = 0
    await db.commit()
    return {"ok": True, "new_offers": new_offers}


@router.get("/offers")
async def my_offers(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    r = _require_rider(account)
    rows = (await db.execute(
        select(RiderOffer)
        .options(selectinload(RiderOffer.order))
        .where(RiderOffer.rider_id == r.id, RiderOffer.status == RiderOfferStatus.offered)
        .order_by(RiderOffer.offered_at.desc())
        .limit(50)
    )).scalars().all()
    # Bulk-load pharmacies for pickup info
    pharm_ids = {o.order.pharmacy_id for o in rows if o.order}
    customer_ids = {o.order.customer_account_id for o in rows if o.order and o.order.customer_account_id}
    pharm_map: Dict[UUID, PharmacyProfile] = {}
    customer_map: Dict[UUID, CustomerProfile] = {}
    if pharm_ids:
        pres = await db.execute(
            select(PharmacyProfile).where(PharmacyProfile.id.in_(pharm_ids))
        )
        pharm_map = {p.id: p for p in pres.scalars().all()}
    if customer_ids:
        cres = await db.execute(
            select(CustomerProfile).where(CustomerProfile.account_id.in_(customer_ids))
        )
        customer_map = {c.account_id: c for c in cres.scalars().all()}
    items = []
    for o in rows:
        order = o.order
        pharm = pharm_map.get(order.pharmacy_id) if order else None
        customer = customer_map.get(order.customer_account_id) if order and order.customer_account_id else None
        items.append({
            "id": str(o.id),
            "order_id": str(o.order_id),
            "payout_amount": o.payout_amount,
            "distance_km": o.distance_km,
            "status": o.status.value,
            "offered_at": o.offered_at.isoformat() if o.offered_at else None,
            # Pickup point (the pharmacy)
            "pickup": {
                "pharmacy_id": str(pharm.id),
                "name": pharm.pharmacy_name,
                "address": pharm.address,
                "lat": pharm.lat,
                "lng": pharm.lng,
                "phone": pharm.phone_number,
                "banner_photo_url": pharm.banner_photo_url,
            } if pharm else None,
            # Drop point (the customer)
            "drop": {
                "name": order.customer_name,
                "address": order.delivery_address,
                "phone": order.customer_phone,
                "lat": order.delivery_lat,
                "lng": order.delivery_lng,
                "profile_photo_url": customer.profile_photo_url if customer else None,
            } if order else None,
            "total": order.total if order else None,
        })
    return {"items": items}


@router.post("/offers/{offer_id}/accept")
async def accept_offer(
    offer_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    r = _require_verified_rider(account)
    offer = (await db.execute(
        select(RiderOffer).where(RiderOffer.id == offer_id, RiderOffer.rider_id == r.id)
    )).scalar_one_or_none()
    if not offer:
        raise HTTPException(404, "Offer not found")
    if offer.status != RiderOfferStatus.offered:
        raise HTTPException(409, f"Offer already {offer.status.value}")

    order = (await db.execute(select(Order).where(Order.id == offer.order_id))).scalar_one()
    if order.status != OrderStatus.ready:
        offer.status = RiderOfferStatus.expired
        offer.responded_at = datetime.now(timezone.utc)
        await db.commit()
        raise HTTPException(409, f"Order is no longer available ({order.status.value})")
    if order.accepted_rider_id:
        # Another rider beat this one to it.
        offer.status = RiderOfferStatus.expired
        offer.responded_at = datetime.now(timezone.utc)
        await db.commit()
        raise HTTPException(409, "Order already taken")

    offer.status = RiderOfferStatus.accepted
    offer.responded_at = datetime.now(timezone.utc)
    order.accepted_rider_id = r.id
    order.status = OrderStatus.dispatched

    # Mark every other offer for this order as expired.
    siblings = (await db.execute(
        select(RiderOffer).where(
            RiderOffer.order_id == order.id, RiderOffer.id != offer.id
        )
    )).scalars().all()
    for s in siblings:
        s.status = RiderOfferStatus.expired
        s.responded_at = datetime.now(timezone.utc)

    db.add(OrderMessage(
        order_id=order.id, sender_role=SenderRole.system,
        body="🛵 Rider assigned — on the way to pick up.",
        preset_key="rider_accepted",
    ))

    if order.customer_account_id:
        await user_notify(
            db, order.customer_account_id,
            kind="order_status",
            title="Rider নিয়োগ 🛵",
            body_bn=f"{r.nick_name or r.full_name or 'Rider'} আপনার order pickup-এ যাত্রা করেছে।",
            payload={"order_id": str(order.id), "status": "dispatched"},
        )

    # If this order is linked to a chat conversation, attach this rider as
    # the 3rd participant so the rider sees + can post in that thread.
    if order.conversation_id:
        from app.models import Conversation, ConversationMessage
        conv = (await db.execute(
            select(Conversation).where(Conversation.id == order.conversation_id)
        )).scalar_one_or_none()
        if conv is not None:
            conv.rider_id = r.id
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=SenderRole.system,
                body=f"🛵 {r.nick_name or r.full_name or 'Rider'} delivery accept koreche.",
                preset_key="rider_joined",
                visibility="all",
            ))
            # Phase 5 — AI auto @rider expiry-date check.
            # Asks the rider (privately, visible to pharmacy + rider) to
            # confirm every medicine's expiry date before pickup.
            try:
                _items_raw = json.loads(order.items_json or "[]")
                _items = _items_raw if isinstance(_items_raw, list) else []
            except Exception:
                _items = []
            _names = [
                str(it.get("name") or "").strip()
                for it in _items if isinstance(it, dict) and it.get("name")
            ][:20]
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=SenderRole.system,
                body=(
                    "🤖 medi AI → @rider: pickup-এর আগে প্রতিটি ওষুধের expiry date "
                    "verify করে নিন। কোনো ওষুধের expiry আজ থেকে ৬ মাসের কম হলে customer-কে "
                    "জানান এবং pharmacy থেকে replacement চান।"
                ),
                preset_key="ai_rider_expiry_check",
                payload_json=json.dumps({
                    "order_id": str(order.id),
                    "rider_id": str(r.id),
                    "items": _names,
                }),
                # Customer + rider see this; pharmacy must NOT (otherwise it
                # tips off a bad-actor pharmacy that we're auditing them).
                visibility="customer_rider",
            ))
            # Phase 6 — Location auto-prompt for the customer.
            # AI asks the customer to share their live precise location now
            # that a rider is en-route, so the rider's route is accurate.
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=SenderRole.system,
                body=(
                    "📍 medi AI: rider আসছে — দয়া করে আপনার live location share করুন "
                    "যাতে rider সঠিক জায়গায় পৌঁছাতে পারে।"
                ),
                preset_key="ai_customer_location_prompt",
                payload_json=json.dumps({
                    "order_id": str(order.id),
                    "rider_id": str(r.id),
                    "current_address": order.delivery_address,
                    "current_lat": order.delivery_lat,
                    "current_lng": order.delivery_lng,
                }),
                visibility="customer_rider",
            ))
    await db.commit()
    return {"ok": True, "order_id": str(order.id)}


# ---------------- active orders + status updates ----------------

def _serialize_active(
    o: Order,
    pharm: PharmacyProfile | None = None,
    customer: CustomerProfile | None = None,
    derived_status: str | None = None,
) -> Dict[str, Any]:
    return {
        "id": str(o.id),
        "pharmacy_id": str(o.pharmacy_id),
        "customer_account_id": str(o.customer_account_id),
        "customer_name": o.customer_name,
        "customer_phone": o.customer_phone,
        "delivery_address": o.delivery_address,
        "delivery_lat": o.delivery_lat,
        "delivery_lng": o.delivery_lng,
        "customer_profile_photo_url": customer.profile_photo_url if customer else None,
        "status": derived_status or o.status.value,
        "total": o.total,
        "delivery_fee": o.delivery_fee,
        "note": o.note,
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "conversation_id": str(o.conversation_id) if o.conversation_id else None,
        "pickup": {
            "pharmacy_id": str(pharm.id),
            "name": pharm.pharmacy_name,
            "address": pharm.address,
            "lat": pharm.lat,
            "lng": pharm.lng,
            "phone": pharm.phone_number,
            "banner_photo_url": pharm.banner_photo_url,
        } if pharm else None,
    }


@router.get("/orders/active")
async def active_orders(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Orders this rider has accepted and is currently delivering."""
    r = _require_rider(account)
    rows = (await db.execute(
        select(Order)
        .where(
            Order.accepted_rider_id == r.id,
            Order.status.in_([OrderStatus.dispatched]),
        )
        .order_by(Order.created_at.desc())
    )).scalars().all()
    pharm_ids = {o.pharmacy_id for o in rows}
    customer_ids = {o.customer_account_id for o in rows if o.customer_account_id}
    pharm_map: Dict[UUID, PharmacyProfile] = {}
    customer_map: Dict[UUID, CustomerProfile] = {}
    if pharm_ids:
        pres = await db.execute(select(PharmacyProfile).where(PharmacyProfile.id.in_(pharm_ids)))
        pharm_map = {p.id: p for p in pres.scalars().all()}
    if customer_ids:
        cres = await db.execute(select(CustomerProfile).where(CustomerProfile.account_id.in_(customer_ids)))
        customer_map = {c.account_id: c for c in cres.scalars().all()}
    picked_ids: set[UUID] = set()
    if rows:
        picked_rows = await db.execute(
            select(OrderMessage.order_id).where(
                OrderMessage.order_id.in_([o.id for o in rows]),
                OrderMessage.preset_key == "picked_up",
            )
        )
        picked_ids = {row[0] for row in picked_rows.all()}
    return {
        "items": [
            _serialize_active(
                o,
                pharm_map.get(o.pharmacy_id),
                customer_map.get(o.customer_account_id),
                "picked_up" if o.id in picked_ids else None,
            )
            for o in rows
        ]
    }


@router.get("/orders/{order_id}/messages")
async def order_messages(
    order_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    r = _require_rider(account)
    order = (await db.execute(
        select(Order).where(Order.id == order_id)
    )).scalar_one_or_none()
    if not order or order.accepted_rider_id != r.id:
        raise HTTPException(404, "Order not found")
    msgs = (await db.execute(
        select(OrderMessage)
        .where(OrderMessage.order_id == order_id)
        .order_by(OrderMessage.created_at)
    )).scalars().all()
    return {
        "items": [
            {
                "id": str(m.id),
                "sender_role": m.sender_role.value,
                "body": m.body,
                "preset_key": m.preset_key,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in msgs
        ]
    }


class RiderMessageIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    preset_key: str | None = None


@router.post("/orders/{order_id}/messages")
async def post_order_message(
    order_id: UUID,
    payload: RiderMessageIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    r = _require_rider(account)
    order = (await db.execute(
        select(Order).where(Order.id == order_id)
    )).scalar_one_or_none()
    if not order or order.accepted_rider_id != r.id:
        raise HTTPException(404, "Order not found")
    db.add(OrderMessage(
        order_id=order.id, sender_role=SenderRole.rider,
        body=payload.body, preset_key=payload.preset_key,
    ))
    await db.commit()
    return {"ok": True}


@router.post("/orders/{order_id}/picked-up")
async def picked_up(
    order_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    r = _require_rider(account)
    order = (await db.execute(
        select(Order).where(Order.id == order_id)
    )).scalar_one_or_none()
    if not order or order.accepted_rider_id != r.id:
        raise HTTPException(404, "Order not found")
    if order.status != OrderStatus.dispatched:
        raise HTTPException(409, f"Cannot pick up in status '{order.status.value}'")
    already_picked = (await db.execute(
        select(OrderMessage.id).where(
            OrderMessage.order_id == order.id,
            OrderMessage.preset_key == "picked_up",
        ).limit(1)
    )).scalar_one_or_none()
    if already_picked is not None:
        return {"ok": True}
    order.updated_at = datetime.utcnow()
    db.add(OrderMessage(
        order_id=order.id, sender_role=SenderRole.rider,
        body="🚲 Order picked up — heading to customer.",
        preset_key="picked_up",
    ))
    if order.customer_account_id:
        await user_notify(
            db, order.customer_account_id,
            kind="order_status",
            title="Rider rowna diyeche 🚲",
            body_bn=f"{r.nick_name or r.full_name or 'Rider'} order pickup করে আপনার দিকে আসছে।",
            payload={"order_id": str(order.id), "status": "picked_up"},
        )
    await db.commit()
    return {"ok": True}


@router.post("/orders/{order_id}/delivered")
async def delivered(
    order_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    r = _require_rider(account)
    order = (await db.execute(
        select(Order).where(Order.id == order_id)
    )).scalar_one_or_none()
    if not order or order.accepted_rider_id != r.id:
        raise HTTPException(404, "Order not found")
    if order.status not in (OrderStatus.dispatched,):
        raise HTTPException(409, f"Cannot deliver in status '{order.status.value}'")
    picked = (await db.execute(
        select(OrderMessage.id).where(
            OrderMessage.order_id == order.id,
            OrderMessage.preset_key == "picked_up",
        ).limit(1)
    )).scalar_one_or_none()
    if picked is None:
        raise HTTPException(409, "Mark pickup before delivery")
    order.status = OrderStatus.delivered
    db.add(OrderMessage(
        order_id=order.id, sender_role=SenderRole.rider,
        body="✅ Delivered to customer.",
        preset_key="delivered",
    ))
    if order.customer_account_id:
        await user_notify(
            db, order.customer_account_id,
            kind="order_status",
            title="Delivered 🎉",
            body_bn="আপনার order পৌঁছেছে — pharmacy ও rider-কে rate করুন।",
            payload={"order_id": str(order.id), "status": "delivered"},
        )
    # Mirror the chat-side `delivery_complete` auto-leave: if the order is
    # tied to a conversation and a rider is currently in it, post (1) the
    # rider's `delivery_complete` chat message so the customer's
    # RatingPrompt unlocks, then (2) a system "rider has left" message and
    # detach the rider so the customer↔pharmacy thread returns to 1-to-1.
    # This keeps the rider tab's active list, the customer's @rider button,
    # and the rating UI all in sync with the actual delivered state.
    if order.conversation_id is not None:
        conv = (await db.execute(
            select(Conversation).where(Conversation.id == order.conversation_id)
        )).scalar_one_or_none()
        if conv is not None and conv.rider_id is not None:
            leave_at = datetime.utcnow()
            order.updated_at = leave_at
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=SenderRole.rider,
                body="✅ Delivery complete — handed to customer.",
                preset_key="delivery_complete",
                visibility="all",
                created_at=leave_at,
            ))
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=SenderRole.system,
                body="🛵 Rider has left the chat — delivery complete.",
                preset_key="rider_left",
                visibility="all",
                created_at=leave_at,
            ))
            conv.rider_id = None
            conv.last_message_at = leave_at
    await db.commit()
    return {"ok": True}


# ---------------- earnings + platform fee ----------------

PLATFORM_FEE_PCT = 0.09  # rider pays 9% of last 48h earnings to platform


def _earnings_window(rows: list[tuple[float, datetime]], cutoff: datetime | None) -> Dict[str, Any]:
    """rows = list of (payout_amount, delivered_at). Returns earnings + count + active_days.

    SQLite stores datetimes as tz-naive even when the column is declared
    timezone-aware, so we strip tzinfo from `cutoff` to keep comparisons
    consistent across SQLite/Postgres.
    """
    if cutoff is not None and cutoff.tzinfo is not None:
        cutoff = cutoff.replace(tzinfo=None)

    def _normalize(t: datetime | None) -> datetime | None:
        if t is None:
            return None
        return t.replace(tzinfo=None) if t.tzinfo is not None else t

    sel = (
        rows
        if cutoff is None
        else [r for r in rows if (n := _normalize(r[1])) is not None and n >= cutoff]
    )
    earnings = round(sum(r[0] for r in sel), 2)
    days = {n.date() for r in sel if (n := _normalize(r[1])) is not None}
    return {
        "earnings": earnings,
        "deliveries": len(sel),
        "active_days": len(days),
    }


@router.get("/me/earnings")
async def my_earnings(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Rider's income breakdown across rolling windows + platform-fee due.

    Earnings = sum of `RiderOffer.payout_amount` for offers this rider
    accepted whose order eventually reached `delivered` state. The
    "delivered at" timestamp is approximated using `Order.updated_at`.
    """
    r = _require_rider(account)
    rows_raw = (await db.execute(
        select(RiderOffer.payout_amount, Order.updated_at)
        .join(Order, Order.id == RiderOffer.order_id)
        .where(
            RiderOffer.rider_id == r.id,
            RiderOffer.status == RiderOfferStatus.accepted,
            Order.status == OrderStatus.delivered,
        )
    )).all()
    rows: list[tuple[float, datetime]] = [(float(p or 0.0), t) for (p, t) in rows_raw]

    now = datetime.now(timezone.utc)
    from datetime import timedelta

    windows = {
        "last_48h":  _earnings_window(rows, now - timedelta(hours=48)),
        "week":      _earnings_window(rows, now - timedelta(days=7)),
        "month":     _earnings_window(rows, now - timedelta(days=30)),
        "year":      _earnings_window(rows, now - timedelta(days=365)),
        "lifetime":  _earnings_window(rows, None),
    }
    fee_due = round(windows["last_48h"]["earnings"] * PLATFORM_FEE_PCT, 2)
    return {
        "windows": windows,
        "platform_fee_pct": PLATFORM_FEE_PCT,
        "platform_fee_due": fee_due,
        "currency": "BDT",
    }


class PlatformFeePayIn(BaseModel):
    amount: float = Field(ge=0)


@router.post("/me/platform-fee/pay")
async def pay_platform_fee(
    payload: PlatformFeePayIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Mock platform-fee payment endpoint.

    Real payment-gateway integration (bKash / Nagad / SSLCommerz) will
    replace this stub. For now we just accept the amount and return
    success so the UI flow can be exercised end-to-end.
    """
    _require_rider(account)
    if payload.amount <= 0:
        raise HTTPException(400, "Amount must be greater than zero")
    return {
        "ok": True,
        "amount": round(payload.amount, 2),
        "paid_at": datetime.now(timezone.utc).isoformat(),
        "note": "Mock payment accepted. Real gateway coming soon.",
    }


# ---------------------------------------------------------------------------
# Admin <-> rider message thread (verification follow-up + general support)
# ---------------------------------------------------------------------------

from app.models.rider_admin_message import RiderAdminMessage  # noqa: E402


def _serialize_admin_msg(m: RiderAdminMessage) -> Dict[str, Any]:
    return {
        "id": str(m.id),
        "direction": m.direction,
        "body": m.body,
        "attachment_url": m.attachment_url,
        "attachment_mime": m.attachment_mime,
        "is_read": bool(m.is_read),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


class RiderReplyIn(BaseModel):
    body: str = Field(default="", max_length=4000)
    attachment_url: Optional[str] = Field(default=None, max_length=500)
    attachment_mime: Optional[str] = Field(default=None, max_length=120)


@router.get("/me/admin-thread")
async def get_admin_thread(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Full conversation history between this rider and MediDoor admin."""
    _require_rider(account)
    rows = (
        await db.execute(
            select(RiderAdminMessage)
            .where(RiderAdminMessage.rider_account_id == account.id)
            .order_by(RiderAdminMessage.created_at.asc())
        )
    ).scalars().all()
    # Mark admin->rider messages as read for this rider.
    unread = [m for m in rows if m.direction == "admin_to_rider" and not m.is_read]
    for m in unread:
        m.is_read = True
    if unread:
        await db.commit()
    return {"items": [_serialize_admin_msg(m) for m in rows]}


@router.get("/me/admin-thread/unread")
async def admin_thread_unread(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """How many admin->rider messages are still unread."""
    _require_rider(account)
    n = (
        await db.execute(
            select(func.count(RiderAdminMessage.id))  # type: ignore[arg-type]
            .where(RiderAdminMessage.rider_account_id == account.id)
            .where(RiderAdminMessage.direction == "admin_to_rider")
            .where(RiderAdminMessage.is_read.is_(False))
        )
    ).scalar() or 0
    return {"unread": int(n)}


@router.post("/me/admin-thread")
async def reply_to_admin(
    payload: RiderReplyIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Rider sends a message to MediDoor admin."""
    _require_rider(account)
    body = (payload.body or "").strip()
    attachment_url = (payload.attachment_url or "").strip() or None
    attachment_mime = (payload.attachment_mime or "").strip() or None
    if not body and not attachment_url:
        raise HTTPException(400, "Message body or attachment required")
    msg = RiderAdminMessage(
        rider_account_id=account.id,
        direction="rider_to_admin",
        body=body,
        attachment_url=attachment_url,
        attachment_mime=attachment_mime,
        is_read=False,
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    return _serialize_admin_msg(msg)


