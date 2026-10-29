"""
Admin Orders & Conversations cockpit — backend endpoints.

Powers the Tk admin tool's "📦 Orders & Conversations" tab. Every endpoint is
gated by ``get_admin_account`` (same as moderation/users routes), bypasses the
participant-only visibility filter used by the public conversation route, and
records every mutation in ``admin_audit_log``.

Endpoints
---------
GET  /api/admin/orders                              — paginated list with filters
GET  /api/admin/orders/{order_id}                   — full detail (items+msgs+conv+rider)
GET  /api/admin/conversations/{conv_id}/messages    — UNFILTERED transcript
POST /api/admin/orders/{order_id}/cancel            — force-cancel + refund note
POST /api/admin/orders/{order_id}/reassign-rider    — release current rider, re-broadcast
PATCH /api/admin/orders/{order_id}                  — edit items / fees / address / pharmacy
DELETE /api/admin/conversations/{conv_id}/messages/{msg_id}  — soft delete with audit
POST /api/admin/orders/{order_id}/purge             — hard-delete the order tree
POST /api/admin/conversations/{conv_id}/purge       — hard-delete the conversation tree
GET  /api/admin/audit-log                           — recent admin actions feed
GET  /api/admin/purge-log                           — recent retention sweeps

Admin identity rule (from the product spec): the admin must NEVER inject
messages into the 3-party customer↔pharmacy↔rider chat. To talk to a
participant they use the existing per-role admin support thread endpoints
(``/api/admin/users/{group}/{id}/thread``).
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_db
from app.api.routes.moderation import get_admin_account
from app.models import (
    Account,
    AdminAuditLog,
    Conversation,
    ConversationMessage,
    CustomerProfile,
    DataPurgeLog,
    Order,
    OrderMessage,
    OrderStatus,
    PharmacyProfile,
    RiderOffer,
    RiderProfile,
    SenderRole,
)
from app.services.dispatch import broadcast_rider_offers
from app.services.geo_policy import RIDER_BROADCAST_RADIUS_KM
from app.services.stock import restore_order_stock


router = APIRouter(prefix="/api/admin", tags=["admin-cockpit"])

TERMINAL_STATUSES = (OrderStatus.delivered, OrderStatus.rejected, OrderStatus.cancelled)

UPLOAD_ROOT = Path(__file__).resolve().parents[3] / "uploads"


# ────────────────────────────────────────────────────────────────────────────
# helpers
# ────────────────────────────────────────────────────────────────────────────


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _items(o: Order) -> List[Dict[str, Any]]:
    try:
        return json.loads(o.items_json or "[]") or []
    except json.JSONDecodeError:
        return []


def _km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


async def _audit(
    db: AsyncSession,
    admin: Account,
    *,
    action: str,
    target_type: str,
    target_id: str,
    reason: str | None = None,
    details: Dict[str, Any] | None = None,
) -> None:
    db.add(
        AdminAuditLog(
            actor_gmail=(admin.gmail or "admin").lower(),
            action=action,
            target_type=target_type,
            target_id=target_id,
            reason=reason,
            details_json=json.dumps(details, ensure_ascii=False) if details else None,
        )
    )


def _serialize_order_row(
    o: Order,
    *,
    pharmacy: PharmacyProfile | None,
    customer: CustomerProfile | None,
    rider: RiderProfile | None,
    flag_count: int = 0,
    blocked: bool = False,
) -> Dict[str, Any]:
    items = _items(o)
    return {
        "id": str(o.id),
        "status": o.status.value,
        "pharmacy_id": str(o.pharmacy_id),
        "pharmacy_name": pharmacy.pharmacy_name if pharmacy else "—",
        "customer_account_id": str(o.customer_account_id) if o.customer_account_id else None,
        "customer_name": o.customer_name,
        "customer_phone": o.customer_phone,
        "customer_gmail": customer.account.gmail if (customer and customer.account) else None,
        "rider_id": str(o.accepted_rider_id) if o.accepted_rider_id else None,
        "rider_name": (rider.full_name if rider else None) if rider else None,
        "items_count": sum(int(i.get("qty", 0) or 0) for i in items),
        "subtotal": o.subtotal,
        "delivery_fee": o.delivery_fee,
        "total": o.total,
        "conversation_id": str(o.conversation_id) if o.conversation_id else None,
        "flag_count": int(flag_count or 0),
        "conversation_blocked": bool(blocked),
        "created_at": _iso(o.created_at),
        "updated_at": _iso(o.updated_at),
    }


def _serialize_conv_msg_admin(m: ConversationMessage) -> Dict[str, Any]:
    """Like the public _msg_dict, but always returns visibility/payload — no filter."""
    payload = None
    if getattr(m, "payload_json", None):
        try:
            payload = json.loads(m.payload_json)
        except Exception:  # noqa: BLE001
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
        "created_at": _iso(m.created_at),
    }


def _serialize_order_msg(m: OrderMessage) -> Dict[str, Any]:
    return {
        "id": str(m.id),
        "sender_role": m.sender_role.value if hasattr(m.sender_role, "value") else str(m.sender_role),
        "body": m.body,
        "preset_key": m.preset_key,
        "created_at": _iso(m.created_at),
    }


def _serialize_rider_offer(ro: RiderOffer, rider: RiderProfile | None) -> Dict[str, Any]:
    return {
        "id": str(ro.id),
        "rider_id": str(ro.rider_id),
        "rider_name": rider.full_name if rider else None,
        "rider_phone": rider.phone_number if rider else None,
        "payout_amount": ro.payout_amount,
        "distance_km": ro.distance_km,
        "status": ro.status.value if hasattr(ro.status, "value") else str(ro.status),
        "offered_at": _iso(ro.offered_at),
        "responded_at": _iso(ro.responded_at),
    }


# ────────────────────────────────────────────────────────────────────────────
# LIST + DETAIL
# ────────────────────────────────────────────────────────────────────────────


@router.get("/orders")
async def list_orders(
    status_filter: str | None = Query(None, alias="status"),
    pharmacy_id: UUID | None = None,
    customer_account_id: UUID | None = None,
    rider_id: UUID | None = None,
    q: str | None = Query(None, description="match in customer name/phone or pharmacy name"),
    only_flagged: bool = False,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    stmt = select(Order)
    if status_filter and status_filter != "all":
        try:
            stmt = stmt.where(Order.status == OrderStatus(status_filter))
        except ValueError as exc:
            raise HTTPException(400, f"Bad status: {status_filter}") from exc
    if pharmacy_id is not None:
        stmt = stmt.where(Order.pharmacy_id == pharmacy_id)
    if customer_account_id is not None:
        stmt = stmt.where(Order.customer_account_id == customer_account_id)
    if rider_id is not None:
        stmt = stmt.where(Order.accepted_rider_id == rider_id)
    if q:
        needle = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(Order.customer_name.ilike(needle), Order.customer_phone.ilike(needle))
        )

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (
        await db.execute(stmt.order_by(desc(Order.updated_at)).limit(limit).offset(offset))
    ).scalars().all()

    # Resolve pharmacy / customer / rider in batch.
    pharmacy_ids = {o.pharmacy_id for o in rows}
    customer_acc_ids = {o.customer_account_id for o in rows if o.customer_account_id}
    rider_ids = {o.accepted_rider_id for o in rows if o.accepted_rider_id}
    conv_ids = {o.conversation_id for o in rows if o.conversation_id}

    pharmacies: Dict[UUID, PharmacyProfile] = {}
    if pharmacy_ids:
        for p in (await db.execute(select(PharmacyProfile).where(PharmacyProfile.id.in_(pharmacy_ids)))).scalars():
            pharmacies[p.id] = p

    customers: Dict[UUID, CustomerProfile] = {}
    if customer_acc_ids:
        for c in (
            await db.execute(
                select(CustomerProfile)
                .options(selectinload(CustomerProfile.account))
                .where(CustomerProfile.account_id.in_(customer_acc_ids))
            )
        ).scalars():
            customers[c.account_id] = c

    riders: Dict[UUID, RiderProfile] = {}
    if rider_ids:
        for r in (
            await db.execute(
                select(RiderProfile)
                .options(selectinload(RiderProfile.account))
                .where(RiderProfile.id.in_(rider_ids))
            )
        ).scalars():
            riders[r.id] = r

    conv_meta: Dict[UUID, tuple[int, bool]] = {}
    if conv_ids:
        for c in (await db.execute(select(Conversation).where(Conversation.id.in_(conv_ids)))).scalars():
            conv_meta[c.id] = (int(c.flag_count or 0), c.blocked_at is not None)

    items_out: List[Dict[str, Any]] = []
    for o in rows:
        flags, blocked = conv_meta.get(o.conversation_id, (0, False)) if o.conversation_id else (0, False)
        if only_flagged and not (flags or blocked):
            continue
        items_out.append(
            _serialize_order_row(
                o,
                pharmacy=pharmacies.get(o.pharmacy_id),
                customer=customers.get(o.customer_account_id) if o.customer_account_id else None,
                rider=riders.get(o.accepted_rider_id) if o.accepted_rider_id else None,
                flag_count=flags,
                blocked=blocked,
            )
        )

    return {"total": int(total or 0), "orders": items_out}


@router.get("/orders/{order_id}")
async def get_order_detail(
    order_id: UUID,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    o = (
        await db.execute(
            select(Order)
            .options(selectinload(Order.messages), selectinload(Order.rider_offers))
            .where(Order.id == order_id)
        )
    ).scalar_one_or_none()
    if not o:
        raise HTTPException(404, "Order not found")

    pharmacy = (
        await db.execute(select(PharmacyProfile).where(PharmacyProfile.id == o.pharmacy_id))
    ).scalar_one_or_none()
    customer = None
    if o.customer_account_id:
        customer = (
            await db.execute(
                select(CustomerProfile)
                .options(selectinload(CustomerProfile.account))
                .where(CustomerProfile.account_id == o.customer_account_id)
            )
        ).scalar_one_or_none()
    rider = None
    if o.accepted_rider_id:
        rider = (
            await db.execute(
                select(RiderProfile)
                .options(selectinload(RiderProfile.account))
                .where(RiderProfile.id == o.accepted_rider_id)
            )
        ).scalar_one_or_none()

    # Resolve rider profiles for offers in batch.
    offer_rider_ids = {ro.rider_id for ro in (o.rider_offers or [])}
    offer_riders: Dict[UUID, RiderProfile] = {}
    if offer_rider_ids:
        for r in (
            await db.execute(
                select(RiderProfile)
                .options(selectinload(RiderProfile.account))
                .where(RiderProfile.id.in_(offer_rider_ids))
            )
        ).scalars():
            offer_riders[r.id] = r

    conv = None
    if o.conversation_id:
        conv = (
            await db.execute(select(Conversation).where(Conversation.id == o.conversation_id))
        ).scalar_one_or_none()

    return {
        "id": str(o.id),
        "status": o.status.value,
        "pharmacy": {
            "id": str(o.pharmacy_id),
            "name": pharmacy.pharmacy_name if pharmacy else "—",
            "phone": pharmacy.phone_number if pharmacy else None,
            "address": pharmacy.address if pharmacy else None,
            "lat": pharmacy.lat if pharmacy else None,
            "lng": pharmacy.lng if pharmacy else None,
        },
        "customer": {
            "account_id": str(o.customer_account_id) if o.customer_account_id else None,
            "name": o.customer_name,
            "phone": o.customer_phone,
            "gmail": customer.account.gmail if (customer and customer.account) else None,
            "address": o.delivery_address,
            "lat": o.delivery_lat,
            "lng": o.delivery_lng,
        },
        "rider": (
            {
                "id": str(o.accepted_rider_id),
                "name": rider.full_name if rider else None,
                "phone": rider.phone_number if rider else None,
                "gmail": rider.account.gmail if (rider and rider.account) else None,
            }
            if rider
            else None
        ),
        "items": _items(o),
        "subtotal": o.subtotal,
        "delivery_fee": o.delivery_fee,
        "total": o.total,
        "note": o.note,
        "prescription_url": o.prescription_url,
        "rejection_reason": o.rejection_reason,
        "conversation": (
            {
                "id": str(conv.id),
                "blocked_at": _iso(conv.blocked_at),
                "block_reason": conv.block_reason,
                "block_category": conv.block_category,
                "flag_count": int(conv.flag_count or 0),
                "rider_id": str(conv.rider_id) if conv.rider_id else None,
                "last_message_at": _iso(conv.last_message_at),
            }
            if conv
            else None
        ),
        "order_messages": [_serialize_order_msg(m) for m in (o.messages or [])],
        "rider_offers": [
            _serialize_rider_offer(ro, offer_riders.get(ro.rider_id))
            for ro in sorted(o.rider_offers or [], key=lambda x: x.offered_at or datetime.min, reverse=True)
        ],
        "created_at": _iso(o.created_at),
        "updated_at": _iso(o.updated_at),
    }


@router.get("/conversations/{conv_id}/messages")
async def get_conversation_messages(
    conv_id: UUID,
    limit: int = Query(500, ge=1, le=2000),
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    c = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "Conversation not found")
    msgs = (
        await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.conversation_id == conv_id)
            .order_by(ConversationMessage.created_at)
            .limit(limit)
        )
    ).scalars().all()
    return {
        "conversation": {
            "id": str(c.id),
            "pharmacy_id": str(c.pharmacy_id),
            "customer_account_id": str(c.customer_account_id),
            "rider_id": str(c.rider_id) if c.rider_id else None,
            "blocked_at": _iso(c.blocked_at),
            "block_reason": c.block_reason,
            "flag_count": int(c.flag_count or 0),
            "last_message_at": _iso(c.last_message_at),
        },
        "messages": [_serialize_conv_msg_admin(m) for m in msgs],
    }


# ────────────────────────────────────────────────────────────────────────────
# MUTATIONS
# ────────────────────────────────────────────────────────────────────────────


class CancelIn(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)
    refund_note: str | None = Field(default=None, max_length=500)


@router.post("/orders/{order_id}/cancel")
async def force_cancel_order(
    order_id: UUID,
    body: CancelIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    o = (await db.execute(select(Order).where(Order.id == order_id))).scalar_one_or_none()
    if not o:
        raise HTTPException(404, "Order not found")
    if o.status in TERMINAL_STATUSES:
        raise HTTPException(409, f"Order already {o.status.value}")

    prev = o.status.value
    o.status = OrderStatus.cancelled
    o.rejection_reason = (body.reason or "").strip() or "Cancelled by admin"
    # Return reserved stock to inventory (idempotent; no-op for chat orders
    # that never reserved). Keeps admin cancels consistent with the rest.
    await restore_order_stock(db, o)

    # Decline any outstanding rider offers so riders don't see a stale offer.
    offers = (
        await db.execute(select(RiderOffer).where(RiderOffer.order_id == o.id))
    ).scalars().all()
    now = datetime.now(timezone.utc)
    for ro in offers:
        if ro.status.value == "offered":
            ro.status = ro.status.__class__("declined")
            ro.responded_at = now

    # System message inside the order thread (admin actions can post to
    # order_messages — this is system audit, not the participant chat).
    refund_line = f"\nRefund note: {body.refund_note}" if body.refund_note else ""
    db.add(
        OrderMessage(
            order_id=o.id,
            sender_role=SenderRole.system,
            body=f"⛔ Order force-cancelled by MediDoor admin.\nReason: {body.reason}{refund_line}",
            preset_key="admin_cancelled",
        )
    )
    await _audit(
        db, admin,
        action="order.cancel",
        target_type="order",
        target_id=str(o.id),
        reason=body.reason,
        details={"previous_status": prev, "refund_note": body.refund_note, "offers_revoked": len(offers)},
    )
    await db.commit()
    return {"ok": True, "previous_status": prev, "offers_revoked": len(offers)}


class ReassignIn(BaseModel):
    reason: str = Field(..., min_length=1, max_length=300)


@router.post("/orders/{order_id}/reassign-rider")
async def reassign_rider(
    order_id: UUID,
    body: ReassignIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Release the currently-accepted rider and re-broadcast offers within 5 km.

    Restores the order to ``ready`` so the pharmacy can dispatch again, and
    detaches the rider from the linked conversation (so the rider loses
    visibility per the standard 3-party visibility rules).
    """
    o = (
        await db.execute(
            select(Order).options(selectinload(Order.rider_offers)).where(Order.id == order_id)
        )
    ).scalar_one_or_none()
    if not o:
        raise HTTPException(404, "Order not found")
    if o.status in TERMINAL_STATUSES:
        raise HTTPException(409, f"Order already {o.status.value}")

    prev_rider = str(o.accepted_rider_id) if o.accepted_rider_id else None
    pharmacy = (
        await db.execute(select(PharmacyProfile).where(PharmacyProfile.id == o.pharmacy_id))
    ).scalar_one_or_none()
    if not pharmacy or pharmacy.lat is None or pharmacy.lng is None:
        raise HTTPException(400, "Pharmacy has no location set — cannot re-broadcast")

    # Detach current rider.
    o.accepted_rider_id = None
    o.status = OrderStatus.ready
    if o.conversation_id:
        conv = (
            await db.execute(select(Conversation).where(Conversation.id == o.conversation_id))
        ).scalar_one_or_none()
        if conv:
            conv.rider_id = None

    # Mark all existing offers as expired so they don't haunt the rider apps.
    now = datetime.now(timezone.utc)
    for ro in o.rider_offers or []:
        if ro.status.value in ("offered", "accepted"):
            ro.status = ro.status.__class__("expired")
            ro.responded_at = now

    # Re-broadcast — shared rules (verified + fresh ping + 5 km) in
    # app/services/dispatch.py.
    new_offers = len(await broadcast_rider_offers(db, o, pharmacy))

    db.add(
        OrderMessage(
            order_id=o.id, sender_role=SenderRole.system,
            body=(
                f"🔁 Rider re-assigned by MediDoor admin. {new_offers} rider(s) "
                f"re-notified within {RIDER_BROADCAST_RADIUS_KM:.0f} km.\nReason: {body.reason}"
            ),
            preset_key="admin_reassigned",
        )
    )
    await _audit(
        db, admin,
        action="order.reassign_rider",
        target_type="order",
        target_id=str(o.id),
        reason=body.reason,
        details={"previous_rider_id": prev_rider, "new_offers": new_offers},
    )
    await db.commit()
    return {"ok": True, "previous_rider_id": prev_rider, "new_offers": new_offers}


class OrderEditIn(BaseModel):
    items: list[dict[str, Any]] | None = None  # full replacement list
    subtotal: float | None = Field(default=None, ge=0)
    delivery_fee: float | None = Field(default=None, ge=0)
    total: float | None = Field(default=None, ge=0)
    delivery_address: str | None = None
    delivery_lat: float | None = None
    delivery_lng: float | None = None
    pharmacy_id: UUID | None = None  # rare — reassign to a different pharmacy
    note: str | None = None
    reason: str = Field(..., min_length=1, max_length=300)


@router.patch("/orders/{order_id}")
async def edit_order(
    order_id: UUID,
    body: OrderEditIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    o = (await db.execute(select(Order).where(Order.id == order_id))).scalar_one_or_none()
    if not o:
        raise HTTPException(404, "Order not found")
    if o.status in TERMINAL_STATUSES:
        raise HTTPException(409, "Cannot edit a terminal-status order")

    before: Dict[str, Any] = {
        "items_count": sum(int(i.get("qty", 0) or 0) for i in _items(o)),
        "subtotal": o.subtotal,
        "delivery_fee": o.delivery_fee,
        "total": o.total,
        "delivery_address": o.delivery_address,
        "pharmacy_id": str(o.pharmacy_id),
    }

    changes: List[str] = []
    if body.items is not None:
        # Recompute item-level subtotal if caller didn't override.
        new_items_json = json.dumps(body.items, ensure_ascii=False)
        if new_items_json != (o.items_json or "[]"):
            o.items_json = new_items_json
            recomputed = round(
                sum(float(i.get("qty", 0) or 0) * float(i.get("price", 0) or 0) for i in body.items),
                2,
            )
            if body.subtotal is None:
                o.subtotal = recomputed
            changes.append(f"items ({len(body.items)})")
    if body.subtotal is not None:
        o.subtotal = round(float(body.subtotal), 2)
        changes.append("subtotal")
    if body.delivery_fee is not None:
        o.delivery_fee = round(float(body.delivery_fee), 2)
        changes.append("delivery_fee")
    if body.total is not None:
        o.total = round(float(body.total), 2)
        changes.append("total")
    else:
        o.total = round((o.subtotal or 0.0) + (o.delivery_fee or 0.0), 2)
    if body.delivery_address is not None:
        o.delivery_address = body.delivery_address.strip()
        changes.append("address")
    if body.delivery_lat is not None:
        o.delivery_lat = body.delivery_lat
    if body.delivery_lng is not None:
        o.delivery_lng = body.delivery_lng
    if body.note is not None:
        o.note = body.note
    if body.pharmacy_id is not None and body.pharmacy_id != o.pharmacy_id:
        target = (
            await db.execute(select(PharmacyProfile).where(PharmacyProfile.id == body.pharmacy_id))
        ).scalar_one_or_none()
        if not target:
            raise HTTPException(400, "Target pharmacy not found")
        o.pharmacy_id = body.pharmacy_id
        # Detach rider + force re-confirm at the new pharmacy.
        o.accepted_rider_id = None
        o.status = OrderStatus.pending
        changes.append(f"pharmacy → {target.pharmacy_name}")

    if not changes:
        raise HTTPException(400, "No fields changed")

    db.add(
        OrderMessage(
            order_id=o.id, sender_role=SenderRole.system,
            body=f"✏️ Order edited by MediDoor admin: {', '.join(changes)}.\nReason: {body.reason}",
            preset_key="admin_edited",
        )
    )
    await _audit(
        db, admin,
        action="order.edit",
        target_type="order",
        target_id=str(o.id),
        reason=body.reason,
        details={"before": before, "changes": changes},
    )
    await db.commit()
    return {"ok": True, "changes": changes}


class DeleteMsgIn(BaseModel):  # currently unused — DELETE uses a query string.
    reason: str = Field(..., min_length=1, max_length=300)


@router.delete("/conversations/{conv_id}/messages/{msg_id}")
async def delete_conversation_message(
    conv_id: UUID,
    msg_id: UUID,
    reason: str = Query(..., min_length=1, max_length=300),
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Soft-delete by overwriting body+attachment + tagging the row.

    Hard-delete would orphan replies/quotes and break the timeline. Instead
    we replace the visible body with a tombstone so participants still see
    the gap (and admin name in the audit log).
    """
    m = (
        await db.execute(
            select(ConversationMessage).where(
                and_(ConversationMessage.id == msg_id, ConversationMessage.conversation_id == conv_id)
            )
        )
    ).scalar_one_or_none()
    if not m:
        raise HTTPException(404, "Message not found")

    snapshot = {"body": m.body, "attachment_url": m.attachment_url, "preset_key": m.preset_key}
    m.body = "🗑️ This message was removed by MediDoor admin."
    m.attachment_url = None
    m.preset_key = "admin_deleted"
    m.was_blocked = True  # reuses existing styling on participant UIs.

    await _audit(
        db, admin,
        action="message.delete",
        target_type="conversation_message",
        target_id=str(m.id),
        reason=reason,
        details={"conversation_id": str(conv_id), "snapshot": snapshot},
    )
    await db.commit()
    return {"ok": True}


class PurgeIn(BaseModel):
    reason: str = Field(..., min_length=1, max_length=300)


def _try_unlink(url: str | None) -> bool:
    if not url:
        return False
    if not url.startswith("/uploads/"):
        return False
    p = UPLOAD_ROOT / url[len("/uploads/"):]
    try:
        p.unlink(missing_ok=True)
        return True
    except OSError:
        return False


@router.post("/orders/{order_id}/purge")
async def purge_order(
    order_id: UUID,
    body: PurgeIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    o = (
        await db.execute(
            select(Order).options(selectinload(Order.messages)).where(Order.id == order_id)
        )
    ).scalar_one_or_none()
    if not o:
        raise HTTPException(404, "Order not found")

    attachments = 0
    if _try_unlink(o.prescription_url):
        attachments += 1
    msg_count = len(o.messages or [])
    offer_count = (
        await db.execute(select(func.count()).select_from(
            select(RiderOffer).where(RiderOffer.order_id == o.id).subquery()
        ))
    ).scalar_one()

    await db.execute(delete(Order).where(Order.id == o.id))  # cascades to messages + offers
    db.add(
        DataPurgeLog(
            kind="manual",
            actor_gmail=(admin.gmail or "").lower(),
            orders_deleted=1,
            order_messages_deleted=int(msg_count),
            rider_offers_deleted=int(offer_count or 0),
            attachments_deleted=attachments,
            notes=f"manual order purge — {body.reason}",
        )
    )
    await _audit(
        db, admin,
        action="order.purge",
        target_type="order",
        target_id=str(order_id),
        reason=body.reason,
        details={"messages": int(msg_count), "offers": int(offer_count or 0)},
    )
    await db.commit()
    return {"ok": True, "messages_deleted": int(msg_count), "offers_deleted": int(offer_count or 0)}


@router.post("/conversations/{conv_id}/purge")
async def purge_conversation(
    conv_id: UUID,
    body: PurgeIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Delete every message row in the conversation but keep the conversation
    row itself (so existing FKs from Order.conversation_id remain valid)."""
    c = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "Conversation not found")

    msgs = (
        await db.execute(
            select(ConversationMessage).where(ConversationMessage.conversation_id == conv_id)
        )
    ).scalars().all()
    attachments = sum(1 for m in msgs if _try_unlink(m.attachment_url))
    count = len(msgs)
    await db.execute(delete(ConversationMessage).where(ConversationMessage.conversation_id == conv_id))

    c.flag_count = 0
    c.blocked_at = None
    c.block_reason = None
    c.block_category = None

    db.add(
        DataPurgeLog(
            kind="manual",
            actor_gmail=(admin.gmail or "").lower(),
            conv_messages_deleted=int(count),
            attachments_deleted=attachments,
            notes=f"manual conversation purge — {body.reason}",
        )
    )
    await _audit(
        db, admin,
        action="conversation.purge",
        target_type="conversation",
        target_id=str(conv_id),
        reason=body.reason,
        details={"messages": int(count), "attachments": int(attachments)},
    )
    await db.commit()
    return {"ok": True, "messages_deleted": int(count), "attachments_deleted": int(attachments)}


# ────────────────────────────────────────────────────────────────────────────
# AUDIT FEED
# ────────────────────────────────────────────────────────────────────────────


@router.get("/audit-log")
async def list_audit_log(
    action: str | None = None,
    target_id: str | None = None,
    limit: int = Query(200, ge=1, le=1000),
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    stmt = select(AdminAuditLog)
    if action:
        stmt = stmt.where(AdminAuditLog.action == action)
    if target_id:
        stmt = stmt.where(AdminAuditLog.target_id == target_id)
    rows = (
        await db.execute(stmt.order_by(desc(AdminAuditLog.created_at)).limit(limit))
    ).scalars().all()
    return [
        {
            "id": str(r.id),
            "actor_gmail": r.actor_gmail,
            "action": r.action,
            "target_type": r.target_type,
            "target_id": r.target_id,
            "reason": r.reason,
            "details": json.loads(r.details_json) if r.details_json else None,
            "created_at": _iso(r.created_at),
        }
        for r in rows
    ]


@router.get("/purge-log")
async def list_purge_log(
    limit: int = Query(100, ge=1, le=500),
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    rows = (
        await db.execute(select(DataPurgeLog).order_by(desc(DataPurgeLog.created_at)).limit(limit))
    ).scalars().all()
    return [
        {
            "id": str(r.id),
            "kind": r.kind,
            "actor_gmail": r.actor_gmail,
            "orders_deleted": int(r.orders_deleted or 0),
            "order_messages_deleted": int(r.order_messages_deleted or 0),
            "conv_messages_deleted": int(r.conv_messages_deleted or 0),
            "rider_offers_deleted": int(r.rider_offers_deleted or 0),
            "admin_messages_deleted": int(r.admin_messages_deleted or 0),
            "attachments_deleted": int(r.attachments_deleted or 0),
            "notes": r.notes,
            "created_at": _iso(r.created_at),
        }
        for r in rows
    ]
