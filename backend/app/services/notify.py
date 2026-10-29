"""
Tiny helper to fire-and-forget per-account notifications.

Usage:
    from app.services.notify import notify
    await notify(db, account_id, kind="order_status",
                 title="Order accepted",
                 body_bn="\u0986\u09aa\u09a8\u09be\u09b0 order pharmacy accept \u0995\u09b0\u09c7\u099b\u09c7\u0964",
                 payload={"order_id": str(order.id)})

Caller is responsible for committing the surrounding transaction.
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Mapping, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import UserNotification


async def notify(
    db: AsyncSession,
    account_id: uuid.UUID,
    *,
    kind: str,
    title: str,
    body_bn: str,
    payload: Optional[Mapping[str, Any]] = None,
) -> UserNotification:
    payload_json = None
    if payload:
        try:
            payload_json = json.dumps(payload, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            payload_json = None
    n = UserNotification(
        account_id=account_id,
        kind=kind,
        title=title[:160],
        body_bn=body_bn,
        payload_json=payload_json,
    )
    db.add(n)
    return n
