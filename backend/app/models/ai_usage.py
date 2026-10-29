"""AI usage tracking — per-account, per-feature, per-month counters.

Used to enforce the free-tier quotas:
  - smart_prescription : 2 per calendar month
  - symptom_search     : 5 per calendar month

A new row is upserted the first time a customer uses a feature in a given
`year_month` (string `YYYY-MM`). Subsequent uses bump `count`.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class AiUsage(Base):
    __tablename__ = "ai_usage"
    __table_args__ = (
        UniqueConstraint("account_id", "feature", "year_month", name="uq_ai_usage_acct_feature_month"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("accounts.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # Feature key — keep short and stable. Known values:
    #   "smart_prescription", "symptom_search"
    feature: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    # Calendar bucket: "YYYY-MM" (UTC). Wraps over to a fresh row each month.
    year_month: Mapped[str] = mapped_column(String(7), nullable=False, index=True)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class GuestAiUsage(Base):
    """Per-IP, per-day counter for UNAUTHENTICATED medi-AI chat.

    The public chat bot (login page / landing) lets a visitor try medi AI a
    few times before signing in. Each call spends real Gemini money, so guests
    are capped at a small number per day per IP. Logged-in users are not
    tracked here (they're unlimited — every message is AI-moderated anyway).
    """
    __tablename__ = "guest_ai_usage"
    __table_args__ = (
        UniqueConstraint("ip", "day", name="uq_guest_ai_ip_day"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    # Real client IP (Cloudflare CF-Connecting-IP / X-Forwarded-For).
    ip: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # Calendar day bucket "YYYY-MM-DD" (UTC) — resets the allowance daily.
    day: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
