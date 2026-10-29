"""
Two-way message thread between MediDoor admin (admin.py) and a single rider.

Used for verification follow-up: admin can ask "NID-এর back side পড়া যাচ্ছে না,
আবার upload করুন।", rider can reply, and the conversation lives in one table
indexed by `rider_account_id`.

Each row is one message. `direction` indicates the sender:
  - "admin_to_rider" — written from admin.py
  - "rider_to_admin" — written from the rider's mobile-rider PWA

The receiver-side `is_read` flag drives the unread-counter badge for the
opposite party.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class RiderAdminMessage(Base):
    __tablename__ = "rider_admin_messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    rider_account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # "admin_to_rider" | "rider_to_admin"
    direction: Mapped[str] = mapped_column(String(20), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    attachment_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    attachment_mime: Mapped[str | None] = mapped_column(String(120), nullable=True)
    is_read: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
