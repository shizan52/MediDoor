"""
Global category catalogue lifecycle.

**Design change (Nov 2025)**: Categories are no longer pre-seeded.
The 36-row hand-curated list was removed because the marketplace is now
fully AI-driven — each pharmacy's medicine upload is vision-classified
and the AI picks (or invents) the category. This keeps the customer-facing
taxonomy organic and free of empty buckets.

What this module still does on startup:
1. Removes any leftover `is_seed=True` rows that may exist in upgraded
   databases (one-time cleanup so old hand-curated buckets disappear).
2. Returns the (negative) count of rows deleted so the boot log still
   has a number to print. New AI-organic categories are NOT touched.

The `vision_classify_product` helper is given the live `category_catalog`
names every time it runs, so once an organic category exists, the AI
prefers reusing it over inventing a new synonym.
"""
from __future__ import annotations

from typing import Iterable

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category_catalog import CategoryCatalog


async def seed_category_catalog(db: AsyncSession) -> int:
    """One-time cleanup: drop any pre-seeded rows from older builds."""
    res = await db.execute(
        delete(CategoryCatalog).where(CategoryCatalog.is_seed.is_(True))
    )
    removed = res.rowcount or 0
    if removed:
        await db.commit()
    return -removed if removed else 0


def category_names() -> Iterable[str]:
    """Plain helper kept for any non-async callers that may import it."""
    return []
