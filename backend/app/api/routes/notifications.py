"""
Generic per-account notification inbox.

Used by the bell / inbox tab on the customer and rider mobile apps. Pharmacy
has its own legacy AiNotification feed at /api/pharmacy/me/notifications.

Endpoints
---------
GET    /api/notifications/me                  → {items, unread}
POST   /api/notifications/me/{nid}/read       → mark one read
POST   /api/notifications/me/read-all         → mark all read
"""
from __future__ import annotations

import json
from typing import Any, Dict
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_account, get_db
from app.models import Account, UserNotification

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _serialize(n: UserNotification) -> Dict[str, Any]:
    payload: Any = None
    if n.payload_json:
        try:
            payload = json.loads(n.payload_json)
        except (ValueError, TypeError):
            payload = None
    return {
        "id": str(n.id),
        "kind": n.kind,
        "title": n.title,
        "body_bn": n.body_bn,
        "payload": payload,
        "is_read": bool(n.is_read),
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


@router.get("/me")
async def list_my_notifications(
    limit: int = Query(default=50, ge=1, le=200),
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    rows = (
        await db.execute(
            select(UserNotification)
            .where(UserNotification.account_id == account.id)
            .order_by(UserNotification.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    unread = (
        await db.execute(
            select(func.count(UserNotification.id)).where(
                UserNotification.account_id == account.id,
                UserNotification.is_read == False,  # noqa: E712
            )
        )
    ).scalar_one()
    return {
        "items": [_serialize(n) for n in rows],
        "unread": int(unread or 0),
    }


@router.post("/me/{nid}/read")
async def mark_read(
    nid: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    n = (
        await db.execute(
            select(UserNotification).where(
                UserNotification.id == nid,
                UserNotification.account_id == account.id,
            )
        )
    ).scalar_one_or_none()
    if n is None:
        raise HTTPException(404, "Notification not found")
    if not n.is_read:
        n.is_read = True
        await db.commit()
    return {"ok": True}


@router.post("/me/read-all")
async def mark_all_read(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    await db.execute(
        UserNotification.__table__.update()
        .where(
            UserNotification.account_id == account.id,
            UserNotification.is_read == False,  # noqa: E712
        )
        .values(is_read=True)
    )
    await db.commit()
    return {"ok": True}
