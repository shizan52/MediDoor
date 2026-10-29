"""AI usage quotas — per-customer, per-feature, per-month."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AiUsage, GuestAiUsage

Feature = Literal["smart_prescription", "symptom_search"]

LIMITS: dict[str, int] = {
    "smart_prescription": 2,
    "symptom_search": 5,
}

# Unauthenticated visitors may try the public medi-AI chat this many times per
# day (per IP) before being asked to log in. Keeps Gemini cost bounded while
# still letting people sample the bot on the login/landing page.
GUEST_CHAT_DAILY_LIMIT = 3


def current_month() -> str:
    """Return the current calendar month bucket as `YYYY-MM` (UTC)."""
    now = datetime.now(timezone.utc)
    return f"{now.year:04d}-{now.month:02d}"


def current_day() -> str:
    """Return the current calendar day bucket as `YYYY-MM-DD` (UTC)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def check_and_bump_guest_chat(db: AsyncSession, ip: str) -> dict:
    """Gate an UNAUTHENTICATED medi-AI chat call for this IP.

    Raises HTTP 401 (code `login_required`) once the guest has used up the
    day's free allowance. Otherwise records this use (in-session; caller
    commits) and returns the running tally. Logged-in users never call this.
    """
    day = current_day()
    ip = (ip or "unknown")[:64]
    row = (
        await db.execute(
            select(GuestAiUsage).where(
                GuestAiUsage.ip == ip, GuestAiUsage.day == day
            )
        )
    ).scalar_one_or_none()
    used = int(row.count) if row else 0
    if used >= GUEST_CHAT_DAILY_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "login_required",
                "used": used,
                "limit": GUEST_CHAT_DAILY_LIMIT,
                "message": (
                    "Free medi AI chat শেষ — আরও chat করতে অনুগ্রহ করে login করুন। "
                    "Login করলে কোনো limit থাকবে না।"
                ),
            },
        )
    if row is None:
        row = GuestAiUsage(ip=ip, day=day, count=0)
        db.add(row)
        await db.flush()
    row.count = used + 1
    await db.flush()
    return {"used": row.count, "limit": GUEST_CHAT_DAILY_LIMIT}


async def _get_or_create_row(
    db: AsyncSession, account_id: uuid.UUID, feature: str, year_month: str
) -> AiUsage:
    row = (
        await db.execute(
            select(AiUsage).where(
                AiUsage.account_id == account_id,
                AiUsage.feature == feature,
                AiUsage.year_month == year_month,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = AiUsage(
            account_id=account_id, feature=feature, year_month=year_month, count=0
        )
        db.add(row)
        await db.flush()
    return row


async def get_usage_summary(db: AsyncSession, account_id: uuid.UUID) -> dict:
    """Return `{feature: {used, limit, remaining, month}}` for all known features."""
    ym = current_month()
    out: dict[str, dict] = {}
    for feat, lim in LIMITS.items():
        row = (
            await db.execute(
                select(AiUsage).where(
                    AiUsage.account_id == account_id,
                    AiUsage.feature == feat,
                    AiUsage.year_month == ym,
                )
            )
        ).scalar_one_or_none()
        used = int(row.count) if row else 0
        out[feat] = {
            "used": used,
            "limit": lim,
            "remaining": max(0, lim - used),
            "month": ym,
        }
    return out


async def check_quota(
    db: AsyncSession, account_id: uuid.UUID, feature: Feature
) -> dict:
    """Raise HTTP 429 if the customer has exhausted this month's quota.

    Returns the current-state dict so the caller may include it in the response.
    """
    lim = LIMITS[feature]
    ym = current_month()
    row = (
        await db.execute(
            select(AiUsage).where(
                AiUsage.account_id == account_id,
                AiUsage.feature == feature,
                AiUsage.year_month == ym,
            )
        )
    ).scalar_one_or_none()
    used = int(row.count) if row else 0
    if used >= lim:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "quota_exceeded",
                "feature": feature,
                "used": used,
                "limit": lim,
                "month": ym,
                "message": (
                    f"You've used your {lim} free {feature.replace('_', ' ')} "
                    f"requests for this month. Upgrade to continue."
                ),
            },
        )
    return {"used": used, "limit": lim, "remaining": lim - used, "month": ym}


async def increment(
    db: AsyncSession, account_id: uuid.UUID, feature: Feature
) -> dict:
    """Bump the counter for this month. Caller commits."""
    ym = current_month()
    row = await _get_or_create_row(db, account_id, feature, ym)
    row.count = int(row.count) + 1
    await db.flush()
    lim = LIMITS[feature]
    return {
        "used": int(row.count),
        "limit": lim,
        "remaining": max(0, lim - int(row.count)),
        "month": ym,
    }


async def reset_current_month(db: AsyncSession, account_id: uuid.UUID) -> dict:
    """Reset all free AI counters for this account in the current month."""
    ym = current_month()
    for feature in LIMITS:
        row = await _get_or_create_row(db, account_id, feature, ym)
        row.count = 0
    await db.flush()
    return await get_usage_summary(db, account_id)
