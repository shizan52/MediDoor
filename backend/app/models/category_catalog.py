"""
Global medicine-category catalogue.

A pharmacy-agnostic pool of healthcare categories curated by AI + the
platform team. Pharmacies pick from this catalogue (searchable typeahead)
when listing a medicine — they don't hard-code their own list any more.

If a pharmacy types a brand-new category that doesn't yet exist here, the
backend auto-inserts it (so the pool grows organically) and the AI
classifier may suggest it on future product reviews.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class CategoryCatalog(Base):
    __tablename__ = "category_catalog"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    # Display name — case-preserved. Lookups are case-insensitive.
    name: Mapped[str] = mapped_column(String(80), nullable=False, unique=True, index=True)
    short_description: Mapped[str | None] = mapped_column(String(280), nullable=True)
    # Optional grouping label used by the picker UI ("Medicines", "Devices",
    # "Personal care", etc.). Helps customers and pharmacies scan faster.
    group_label: Mapped[str | None] = mapped_column(String(60), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    # True for entries seeded by the platform; false for user-created ones.
    is_seed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # How many medicines currently reference this name (best-effort, refreshed
    # by the API on read so we never have stale numbers in the picker).
    use_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
