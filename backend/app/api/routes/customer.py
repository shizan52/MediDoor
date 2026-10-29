"""Customer-facing routes — order history, profile bits.

Customer auth/profile basics live in `auth.py`; this file holds the customer
dashboard pages that need joined data (orders + pharmacy info, AI usage etc.)
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional
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
    Medicine,
    Order,
    OrderMessage,
    OrderStatus,
    PharmacyProfile,
    RoleEnum,
    SenderRole,
)
from app.models.customer_admin_message import CustomerAdminMessage
from app.services.notify import notify as user_notify
from app.services.customer_policy import ensure_customer_not_banned
from app.services.stock import adjust_reservation

router = APIRouter(prefix="/api/customer", tags=["customer"])


def _require_customer(account: Account) -> None:
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers can access this endpoint")


def _serialize_admin_msg(m: CustomerAdminMessage) -> Dict[str, Any]:
    return {
        "id": str(m.id),
        "direction": m.direction,
        "body": m.body,
        "attachment_url": m.attachment_url,
        "attachment_mime": m.attachment_mime,
        "is_read": bool(m.is_read),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _safe_items(raw: str | None) -> List[Dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)][:60]
    except Exception:
        pass
    return []


class CustomerAdminReplyIn(BaseModel):
    body: str = Field(default="", max_length=4000)
    attachment_url: Optional[str] = Field(default=None, max_length=500)
    attachment_mime: Optional[str] = Field(default=None, max_length=120)


@router.get("/me/admin-thread")
async def get_admin_thread(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    _require_customer(account)
    rows = (
        await db.execute(
            select(CustomerAdminMessage)
            .where(CustomerAdminMessage.customer_account_id == account.id)
            .order_by(CustomerAdminMessage.created_at.asc())
        )
    ).scalars().all()
    unread = [m for m in rows if m.direction == "admin_to_customer" and not m.is_read]
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
    _require_customer(account)
    n = (
        await db.execute(
            select(func.count(CustomerAdminMessage.id))
            .where(CustomerAdminMessage.customer_account_id == account.id)
            .where(CustomerAdminMessage.direction == "admin_to_customer")
            .where(CustomerAdminMessage.is_read.is_(False))
        )
    ).scalar() or 0
    return {"unread": int(n)}


@router.post("/me/admin-thread")
async def reply_to_admin(
    payload: CustomerAdminReplyIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    _require_customer(account)
    body = (payload.body or "").strip()
    attachment_url = (payload.attachment_url or "").strip() or None
    attachment_mime = (payload.attachment_mime or "").strip() or None
    if not body and not attachment_url:
        raise HTTPException(400, "Message body or attachment required")
    msg = CustomerAdminMessage(
        customer_account_id=account.id,
        direction="customer_to_admin",
        body=body,
        attachment_url=attachment_url,
        attachment_mime=attachment_mime,
        is_read=False,
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    return _serialize_admin_msg(msg)


@router.get("/me/orders")
async def my_orders(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Returns this customer's order history newest-first, joined with
    pharmacy info + the conversation_id (so the frontend can open the
    messenger pinned to the same pharmacy thread).

    Scope: only orders that belong to this account_id. Includes ALL statuses
    so the customer can see in-flight + completed + cancelled in one list.
    Frontend can filter further (e.g. delivered-only spend totals).
    """
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers have an order history")

    rows = (
        await db.execute(
            select(Order)
            .where(Order.customer_account_id == account.id)
            .order_by(Order.created_at.desc())
            .limit(200)
        )
    ).scalars().all()

    if not rows:
        return {"orders": [], "totals": {"spent_delivered": 0.0, "delivered_count": 0}}

    pharm_ids = list({r.pharmacy_id for r in rows})
    pharms = (
        await db.execute(
            select(PharmacyProfile).where(PharmacyProfile.id.in_(pharm_ids))
        )
    ).scalars().all()
    pharm_map = {p.id: p for p in pharms}

    # Map pharmacy_id -> conversation_id for this customer (for the
    # "Message pharmacy" button next to each order).
    convs = (
        await db.execute(
            select(Conversation).where(
                Conversation.customer_account_id == account.id,
                Conversation.pharmacy_id.in_(pharm_ids),
            )
        )
    ).scalars().all()
    conv_map = {c.pharmacy_id: c for c in convs}

    out_orders: List[Dict[str, Any]] = []
    spent_delivered = 0.0
    delivered_count = 0
    for o in rows:
        p = pharm_map.get(o.pharmacy_id)
        items = _safe_items(o.items_json)
        is_delivered = o.status == OrderStatus.delivered
        if is_delivered:
            spent_delivered += float(o.total or 0)
            delivered_count += 1
        # Prefer the conversation_id stamped on the order; otherwise fall
        # back to the (customer, pharmacy) thread we found above.
        conv_id = o.conversation_id
        if not conv_id and p is not None:
            c = conv_map.get(p.id)
            if c is not None:
                conv_id = c.id
        out_orders.append({
            "id": str(o.id),
            "status": o.status.value if hasattr(o.status, "value") else str(o.status),
            "items": items,
            "item_count": len(items),
            "subtotal": float(o.subtotal or 0),
            "delivery_fee": float(o.delivery_fee or 0),
            "total": float(o.total or 0),
            "created_at": o.created_at.isoformat() if o.created_at else None,
            "pharmacy": {
                "id": str(p.id) if p else str(o.pharmacy_id),
                "name": p.pharmacy_name if p else "Pharmacy",
                "banner_photo_url": p.banner_photo_url if p else None,
                "rating": round(p.rating, 1) if p else None,
                "address": p.address if p else None,
            },
            "conversation_id": str(conv_id) if conv_id else None,
        })

    return {
        "orders": out_orders,
        "totals": {
            "spent_delivered": round(spent_delivered, 2),
            "delivered_count": delivered_count,
            "order_count": len(out_orders),
        },
    }


# ─────────────────────────────────────────────────────────────────────
# Phase 4 — pre-packaging order modify window.
# Customer may add / remove / change qty for items while the order is in
# `confirmed` status (after pharmacy accepted, before packaging starts).
# Once status moves to packaging or later, this endpoint returns 409.
# ─────────────────────────────────────────────────────────────────────


class ModifyItemIn(BaseModel):
    medicine_id: str = Field(min_length=1, max_length=80)
    qty: int = Field(ge=1, le=200)


class OrderModifyIn(BaseModel):
    items: List[ModifyItemIn] = Field(min_length=1, max_length=40)
    note: str | None = Field(default=None, max_length=400)


@router.post("/me/orders/{order_id}/modify")
async def modify_order(
    order_id: UUID,
    payload: OrderModifyIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    ensure_customer_not_banned(account)
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers can modify their own orders")
    o = (await db.execute(
        select(Order).where(
            Order.id == order_id,
            Order.customer_account_id == account.id,
        )
    )).scalar_one_or_none()
    if not o:
        raise HTTPException(404, "Order not found")
    if o.status != OrderStatus.confirmed:
        raise HTTPException(
            409,
            f"Modify window closed — order is now '{o.status.value}'. "
            "Customer can only modify while status is 'confirmed' (after pharmacy "
            "accepts, before packaging starts).",
        )

    # Validate every medicine belongs to this pharmacy + is currently
    # purchasable. Build the new items list with current prices/images.
    med_ids: list[UUID] = []
    for it in payload.items:
        try:
            med_ids.append(UUID(it.medicine_id))
        except Exception:
            raise HTTPException(400, f"Invalid medicine_id: {it.medicine_id}")
    meds = (await db.execute(
        select(Medicine).where(Medicine.id.in_(med_ids))
    )).scalars().all()
    by_id = {m.id: m for m in meds}
    new_items: list[dict] = []
    subtotal = 0.0
    for it in payload.items:
        m = by_id.get(UUID(it.medicine_id))
        if m is None:
            raise HTTPException(400, f"Medicine not found: {it.medicine_id}")
        if m.pharmacy_id != o.pharmacy_id:
            raise HTTPException(
                400,
                f"Medicine '{m.name}' belongs to a different pharmacy — cannot add to this order.",
            )
        if not getattr(m, "is_active", True):
            raise HTTPException(400, f"Medicine '{m.name}' is inactive.")
        # NOTE: do NOT compare against raw stock here — this order already
        # holds a reservation, so the available headroom is checked as a delta
        # by `adjust_reservation` below (which also applies the stock change).
        unit_price = float(m.price or 0)
        new_items.append({
            "medicine_id": str(m.id),
            "name": m.name,
            "qty": int(it.qty),
            "unit_price": unit_price,
            "image_url": getattr(m, "image_url", None),
        })
        subtotal += unit_price * it.qty

    # Diff vs prior items (best-effort, for the chat card payload).
    try:
        prior_raw = json.loads(o.items_json or "[]")
        prior = prior_raw if isinstance(prior_raw, list) else []
    except Exception:
        prior = []
    prior_by_id = {str(x.get("medicine_id")): x for x in prior if isinstance(x, dict)}
    new_by_id = {x["medicine_id"]: x for x in new_items}
    added = [x for k, x in new_by_id.items() if k not in prior_by_id]
    removed = [x for k, x in prior_by_id.items() if k not in new_by_id]
    changed: list[dict] = []
    for k, new in new_by_id.items():
        old = prior_by_id.get(k)
        if old and int(old.get("qty") or 0) != int(new["qty"]):
            changed.append({
                "medicine_id": k,
                "name": new["name"],
                "old_qty": int(old.get("qty") or 0),
                "new_qty": int(new["qty"]),
            })

    # Re-sync the stock reservation to the new item list BEFORE we overwrite
    # items_json (adjust_reservation reads the order's current/old items to
    # compute the delta). Increases are stock-checked; decreases give stock back.
    await adjust_reservation(db, o, new_items)

    delivery_fee = float(o.delivery_fee or 0)
    new_total = round(subtotal + delivery_fee, 2)
    o.items_json = json.dumps(new_items)
    o.subtotal = round(subtotal, 2)
    o.total = new_total
    if payload.note:
        o.note = (o.note or "") + ("\n" if o.note else "") + f"[modify] {payload.note}"

    # Audit message on the order itself (pharmacy dashboard).
    summary_bits: list[str] = []
    if added: summary_bits.append(f"+{len(added)} নতুন")
    if removed: summary_bits.append(f"-{len(removed)} বাদ")
    if changed: summary_bits.append(f"{len(changed)}টি qty change")
    summary = ", ".join(summary_bits) or "qty/note update"
    db.add(OrderMessage(
        order_id=o.id, sender_role=SenderRole.customer,
        body=f"✏️ Customer modified order — {summary}. নতুন total ৳{new_total:.0f}",
        preset_key="order_modified",
    ))

    # Chat-side card (visible to both customer and pharmacy).
    if o.conversation_id:
        db.add(ConversationMessage(
            conversation_id=o.conversation_id,
            sender_role=SenderRole.system,
            body=f"✏️ Customer order modify করেছেন — {summary}. নতুন total ৳{new_total:.0f}",
            preset_key="ai_order_modified",
            payload_json=json.dumps({
                "order_id": str(o.id),
                "items": new_items,
                "subtotal": round(subtotal, 2),
                "delivery_fee": delivery_fee,
                "total": new_total,
                "added": added,
                "removed": removed,
                "changed": changed,
            }),
            visibility="all",
        ))

    # Tell the pharmacy.
    pharm = (await db.execute(
        select(PharmacyProfile).where(PharmacyProfile.id == o.pharmacy_id)
    )).scalar_one_or_none()
    if pharm and pharm.account_id:
        await user_notify(
            db, pharm.account_id,
            kind="order_status",
            title="Customer modified order",
            body_bn=f"Order #{str(o.id)[:8]} modify হয়েছে — {summary}.",
            payload={"order_id": str(o.id), "status": "modified"},
        )

    await db.commit()
    await db.refresh(o)
    return {
        "ok": True,
        "order_id": str(o.id),
        "items": new_items,
        "subtotal": round(subtotal, 2),
        "delivery_fee": delivery_fee,
        "total": new_total,
        "added": added,
        "removed": removed,
        "changed": changed,
    }