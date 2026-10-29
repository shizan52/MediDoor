"""
Two-way support thread between MediDoor admin (admin.py) and a pharmacy.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class PharmacyAdminMessage(Base):
    __tablename__ = "pharmacy_admin_messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    pharmacy_account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # "admin_to_pharmacy" | "pharmacy_to_admin"
    direction: Mapped[str] = mapped_column(String(24), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    attachment_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    attachment_mime: Mapped[str | None] = mapped_column(String(120), nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)