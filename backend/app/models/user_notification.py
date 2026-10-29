"""
Generic per-account notification feed for customers and riders.

Mirrors the pharmacy AiNotification model but keyed by account_id so it
works for any role. Producers (orders, chat, AI) call
`UserNotification(account_id=..., kind=..., title=..., body_bn=...,
payload_json=...)` and the bell dropdown / inbox tab on each mobile app
reads via `/api/notifications/me`.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class UserNotification(Base):
    __tablename__ = "user_notifications"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # e.g. "order_status", "chat_message", "ai_alert", "rider_offer", "review".
    kind: Mapped[str] = mapped_column(String(40), nullable=False, default="generic")
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    body_bn: Mapped[str] = mapped_column(Text, nullable=False)
    # Free-form JSON payload (order_id, conversation_id, deep_link, etc.).
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_read: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
