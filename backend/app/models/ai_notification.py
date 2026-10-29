"""
Platform → pharmacy notification feed.

Used by MediAI to leave advice messages on a pharmacy when, for example,
they publish a medicine whose user-supplied category or short description
doesn't match what the AI sees in the product image. Renders as a bell
dropdown in the pharmacy dashboard navbar.

Pharmacy → MediAI replies are NOT supported here (this is one-way).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class AiNotification(Base):
    __tablename__ = "ai_notifications"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    pharmacy_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(),
        ForeignKey("pharmacy_profiles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # e.g. "publish_advice" — extensible for future use cases.
    kind: Mapped[str] = mapped_column(String(40), nullable=False, default="publish_advice")
    title: Mapped[str] = mapped_column(String(140), nullable=False)
    # Bengali advice body shown verbatim in the dropdown.
    body_bn: Mapped[str] = mapped_column(Text, nullable=False)
    # Free-form JSON payload (medicine_id, suggested_categories, etc.) so the
    # frontend can deep-link to the medicine the advice is about.
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
