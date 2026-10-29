"""Stock reservation / restoration — keep inventory counts honest.

Every order path that takes medicine off the shelf must reserve stock when the
order is created and return it if the order is cancelled / rejected, so the
displayed stock never drifts away from reality.

Helpers:
  * reserve_items_stock  — decrement stock for a new order's items (with a
                           sufficient-stock check to stop overselling).
  * adjust_reservation   — re-sync a held reservation to a modified item list
                           (applies only the delta: increases take more stock,
                           decreases/removals give it back).
  * restore_order_stock  — give a held reservation back in full (cancel/reject).

All are idempotent around the order's `stock_reserved` flag so stock can never
be double-charged or double-credited. Chat orders that never reserved keep
`stock_reserved=False`, so restore is a safe no-op for them.
"""
from __future__ import annotations

import json
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Medicine, Order


def _quantities_from_items(items) -> dict[str, int]:
    qty_by_id: dict[str, int] = {}
    if not isinstance(items, list):
        return qty_by_id
    for it in items:
        if not isinstance(it, dict):
            continue
        mid = it.get("medicine_id")
        if not mid:
            continue
        try:
            qty = int(it.get("qty", 0) or 0)
        except Exception:
            qty = 0
        if qty <= 0:
            continue
        key = str(mid)
        qty_by_id[key] = qty_by_id.get(key, 0) + qty
    return qty_by_id


def _quantities(order: Order) -> dict[str, int]:
    try:
        items = json.loads(order.items_json or "[]")
    except Exception:
        items = []
    return _quantities_from_items(items)


async def _fetch_medicines(db: AsyncSession, ids: set[str]) -> dict[str, Medicine]:
    id_objs: list[UUID] = []
    for k in ids:
        try:
            id_objs.append(UUID(k))
        except Exception:
            continue
    if not id_objs:
        return {}
    rows = (await db.execute(
        select(Medicine).where(Medicine.id.in_(id_objs))
    )).scalars().all()
    return {str(m.id): m for m in rows}


async def reserve_items_stock(db: AsyncSession, items) -> None:
    """Decrement stock for a list of order items.

    Raises HTTPException(409) if any medicine is missing or short on stock
    (overselling guard). Caller marks the order stock_reserved and commits.
    """
    qty_by_id = _quantities_from_items(items)
    if not qty_by_id:
        return
    found = await _fetch_medicines(db, set(qty_by_id))
    for k, need in qty_by_id.items():
        m = found.get(k)
        if m is None:
            raise HTTPException(409, f"Medicine {k} is no longer available")
        if int(m.stock or 0) < need:
            raise HTTPException(409, f"{m.name}: only {int(m.stock or 0)} in stock")
    for k, need in qty_by_id.items():
        found[k].stock = int(found[k].stock or 0) - need


async def adjust_reservation(db: AsyncSession, order: Order, new_items) -> None:
    """Re-sync a held reservation so it matches `new_items` (an order modify).

    Applies just the delta vs the order's current held quantities: an increase
    takes more stock (checked), a decrease/removal returns stock. Updates
    `order.stock_reserved`. Raises HTTPException(409) if an increase exceeds
    available stock.
    """
    old = _quantities(order) if getattr(order, "stock_reserved", False) else {}
    new = _quantities_from_items(new_items)
    all_ids = set(old) | set(new)
    if not all_ids:
        order.stock_reserved = False
        return
    found = await _fetch_medicines(db, all_ids)
    for k in all_ids:
        delta = new.get(k, 0) - old.get(k, 0)
        if delta > 0:
            m = found.get(k)
            if m is None:
                raise HTTPException(409, f"Medicine {k} is no longer available")
            if int(m.stock or 0) < delta:
                raise HTTPException(409, f"{m.name}: only {int(m.stock or 0)} in stock")
    for k in all_ids:
        delta = new.get(k, 0) - old.get(k, 0)
        m = found.get(k)
        if m is not None and delta != 0:
            m.stock = int(m.stock or 0) - delta  # delta<0 returns stock
    order.stock_reserved = bool(new)


async def restore_order_stock(db: AsyncSession, order: Order) -> bool:
    """Return reserved stock to inventory for a cancelled/rejected order.

    Returns True if stock was restored, False if nothing to do.
    """
    if not getattr(order, "stock_reserved", False):
        return False

    qty_by_id = _quantities(order)
    if qty_by_id:
        found = await _fetch_medicines(db, set(qty_by_id))
        for k, add in qty_by_id.items():
            m = found.get(k)
            if m is not None and add:
                m.stock = int(m.stock or 0) + add

    order.stock_reserved = False
    return True
