"""
Customer-facing order routes.

  POST /api/orders                 -> place a new order (auth optional but recommended)
  GET  /api/orders/me              -> list the logged-in customer's orders
  GET  /api/orders/{id}            -> read an order (owner: customer or pharmacy)
  POST /api/orders/{id}/cancel     -> customer cancels (only while pending/confirmed)
  POST /api/orders/{id}/messages   -> customer message in the order DM
"""
from __future__ import annotations

import json
from typing import Any, Dict, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_account, get_db
from app.api.routes.pharmacy import _serialize_order
from app.models import (
    Account,
    ConversationMessage,
    Medicine,
    Order,
    OrderMessage,
    OrderStatus,
    PharmacyProfile,
    RoleEnum,
    SenderRole,
)
from app.services.pharmacy_ops import is_open_now
from app.services.customer_policy import ensure_customer_not_banned
from app.services.delivery import delivery_fee_for_distance, haversine_km
from app.services.geo_policy import ensure_within_connect_radius
from app.services.stock import reserve_items_stock, restore_order_stock

router = APIRouter(prefix="/api/orders", tags=["orders"])


class OrderItemIn(BaseModel):
    medicine_id: UUID
    qty: int = Field(ge=1, le=200)


class OrderCreate(BaseModel):
    pharmacy_id: UUID
    items: List[OrderItemIn] = Field(min_length=1)
    customer_name: str = Field(min_length=1, max_length=160)
    customer_phone: str = Field(min_length=4, max_length=40)
    delivery_address: str = Field(min_length=4, max_length=500)
    delivery_lat: float | None = None
    delivery_lng: float | None = None
    prescription_url: str | None = None
    note: str | None = Field(default=None, max_length=1000)


@router.post("", status_code=201)
async def place_order(
    payload: OrderCreate,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    ensure_customer_not_banned(account)
    p = (await db.execute(
        select(PharmacyProfile).where(PharmacyProfile.id == payload.pharmacy_id)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(404, "Pharmacy not found")
    if getattr(p, "is_blocked", False):
        raise HTTPException(status.HTTP_423_LOCKED, detail={
            "code": "pharmacy_blocked",
            "message": "এই pharmacy আপাতত MediDoor-এ available নয়।",
        })
    if not p.is_published:
        raise HTTPException(409, "This pharmacy is not accepting orders")
    if not is_open_now(p):
        raise HTTPException(409, "Pharmacy is currently closed")

    # Delivery location is mandatory — the fee is 10 BDT/km from the pharmacy
    # to the customer, so we cannot price the order without it.
    if payload.delivery_lat is None or payload.delivery_lng is None:
        raise HTTPException(
            400,
            "Delivery location প্রয়োজন — location ছাড়া delivery charge হিসাব করা যাবে না।",
        )
    # 5 km connect gate — customers order only from pharmacies within their
    # connect radius (400 location_required / 403 out_of_range).
    ensure_within_connect_radius(payload.delivery_lat, payload.delivery_lng, p)

    # Resolve and validate every item.
    med_ids = [it.medicine_id for it in payload.items]
    rows = (await db.execute(
        select(Medicine).where(Medicine.id.in_(med_ids), Medicine.pharmacy_id == p.id)
    )).scalars().all()
    by_id = {m.id: m for m in rows}
    items_payload: List[Dict[str, Any]] = []
    subtotal = 0.0
    needs_prescription = False
    rx_item_names: List[str] = []
    for it in payload.items:
        m = by_id.get(it.medicine_id)
        if not m or not m.is_active:
            raise HTTPException(400, f"Item {it.medicine_id} unavailable")
        if (getattr(m, "approval_status", "approved") or "approved") != "approved":
            raise HTTPException(
                409,
                f"{m.name}: এই product বর্তমানে storefront-এ available নয়।",
            )
        if getattr(m, "prescription_required", False):
            needs_prescription = True
            rx_item_names.append(m.name)
        items_payload.append({
            "medicine_id": str(m.id),
            "name": m.name,
            "qty": it.qty,
            "price": m.price,
            "image_url": m.image_url,
            "prescription_required": bool(getattr(m, "prescription_required", False)),
        })
        subtotal += m.price * it.qty

    if needs_prescription and not (payload.prescription_url and payload.prescription_url.strip()):
        names = ", ".join(rx_item_names[:3])
        more = "" if len(rx_item_names) <= 3 else f" সহ {len(rx_item_names) - 3} টি অতিরিক্ত item"
        raise HTTPException(
            400,
            f"এই order-এ prescription আবশ্যক ({names}{more})। "
            "Order place করার আগে prescription upload করুন।",
        )

    # Centralized stock reservation (availability check + decrement live in
    # app/services/stock.py so every order path behaves identically).
    await reserve_items_stock(db, items_payload)

    # Distance-based delivery fee (10 BDT/km), matching the storefront display.
    distance_km: float | None = None
    if p.lat is not None and p.lng is not None:
        distance_km = haversine_km(
            payload.delivery_lat, payload.delivery_lng, p.lat, p.lng
        )
    delivery_fee = delivery_fee_for_distance(distance_km)
    total = round(subtotal + delivery_fee, 0)

    order = Order(
        pharmacy_id=p.id,
        customer_account_id=account.id,
        customer_name=payload.customer_name,
        customer_phone=payload.customer_phone,
        delivery_address=payload.delivery_address,
        delivery_lat=payload.delivery_lat,
        delivery_lng=payload.delivery_lng,
        items_json=json.dumps(items_payload, ensure_ascii=False),
        prescription_url=payload.prescription_url,
        note=payload.note,
        subtotal=round(subtotal, 0),
        delivery_fee=delivery_fee,
        total=total,
        status=OrderStatus.pending,
        stock_reserved=True,  # stock was decremented above — restore on cancel/reject
    )
    db.add(order)
    await db.flush()
    db.add(OrderMessage(
        order_id=order.id, sender_role=SenderRole.system,
        body=f"নতুন order #{str(order.id)[:8]} — pharmacy এর confirmation এর অপেক্ষায়।",
        preset_key="placed",
    ))
    await db.commit()
    await db.refresh(order)
    return _serialize_order(order)


@router.get("/me")
async def my_orders(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    rows = (await db.execute(
        select(Order)
        .options(selectinload(Order.messages))
        .where(Order.customer_account_id == account.id)
        .order_by(Order.created_at.desc())
        .limit(50)
    )).scalars().all()
    return {"items": [_serialize_order(o, include_messages=True) for o in rows]}


async def _get_visible_order(order_id: UUID, account: Account, db: AsyncSession) -> Order:
    o = (await db.execute(
        select(Order).options(selectinload(Order.messages))
        .where(Order.id == order_id)
    )).scalar_one_or_none()
    if not o:
        raise HTTPException(404, "Order not found")
    if account.role == RoleEnum.customer and o.customer_account_id != account.id:
        raise HTTPException(403, "Not your order")
    if account.role == RoleEnum.pharmacy:
        if not account.pharmacy or o.pharmacy_id != account.pharmacy.id:
            raise HTTPException(403, "Not your order")
    return o


@router.get("/{order_id}")
async def get_order(
    order_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    o = await _get_visible_order(order_id, account, db)
    return _serialize_order(o, include_messages=True)


@router.post("/{order_id}/cancel")
async def cancel_order(
    order_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    o = await _get_visible_order(order_id, account, db)
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only the customer can cancel")
    if o.status not in (OrderStatus.pending, OrderStatus.confirmed):
        raise HTTPException(409, f"Cannot cancel order in status '{o.status.value}'")
    o.status = OrderStatus.cancelled
    # Return any reserved stock to inventory (idempotent; no-op for chat orders).
    await restore_order_stock(db, o)
    db.add(OrderMessage(
        order_id=o.id, sender_role=SenderRole.customer,
        body="Customer cancelled the order.", preset_key="cancelled",
    ))
    # Bug #10 — also surface the cancellation in the linked chat so the
    # pharmacy sees it as a chat pill, not just a hidden order status flip.
    if o.conversation_id:
        import json as _json
        db.add(ConversationMessage(
            conversation_id=o.conversation_id,
            sender_role=SenderRole.system,
            body=f"🚫 Customer cancelled order #{str(o.id)[:8]}.",
            preset_key="ai_handshake_cancelled",
            payload_json=_json.dumps({"order_id": str(o.id)}),
            visibility="all",
        ))
    await db.commit()
    await db.refresh(o)
    return _serialize_order(o, include_messages=True)


class CustomerMessageIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    preset_key: str | None = None


@router.post("/{order_id}/messages")
async def customer_message(
    order_id: UUID,
    payload: CustomerMessageIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    ensure_customer_not_banned(account)
    o = await _get_visible_order(order_id, account, db)
    role = SenderRole.customer if account.role == RoleEnum.customer else SenderRole.pharmacy
    db.add(OrderMessage(
        order_id=o.id, sender_role=role,
        body=payload.body, preset_key=payload.preset_key,
    ))
    await db.commit()
    await db.refresh(o)
    return _serialize_order(o, include_messages=True)
