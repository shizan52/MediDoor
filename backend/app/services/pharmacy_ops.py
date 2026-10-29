"""Pharmacy operational helpers — opening-hours / publish / subscription tier."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from app.models import PharmacyProfile

# Bangladesh standard time = UTC+6 (no DST).
BD_TZ = timezone(timedelta(hours=6))

# Default schedule used if a pharmacy has no opening_hours configured yet.
DEFAULT_HOURS: Dict[str, Dict[str, Any]] = {
    d: {"open": "09:00", "close": "22:00", "closed": False}
    for d in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
}

# Subscription tier capabilities (impressions out of every 50 listing slots,
# prescription-offer share out of 4, and verification badge text).
TIER_RULES: Dict[str, Dict[str, Any]] = {
    "C": {"impressions_per_50": 10, "rx_offers_out_of_4": 1, "badge": "Verified",        "label": "C — Basic"},
    "B": {"impressions_per_50": 20, "rx_offers_out_of_4": 2, "badge": "Verified Pro",    "label": "B — Pro"},
    "A": {"impressions_per_50": 30, "rx_offers_out_of_4": 3, "badge": "Verified Pro+",   "label": "A — Premium"},
}


def parse_hours(raw: str | None) -> Dict[str, Dict[str, Any]]:
    """Decode opening_hours_json with safe fallback to DEFAULT_HOURS."""
    if not raw:
        return DEFAULT_HOURS
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            return DEFAULT_HOURS
        return data
    except (json.JSONDecodeError, TypeError):
        return DEFAULT_HOURS


def serialize_hours(data: Dict[str, Dict[str, Any]]) -> str:
    return json.dumps(data, ensure_ascii=False)


def is_open_now(p: PharmacyProfile, *, when: datetime | None = None) -> bool:
    """True iff the pharmacy is published, not manually closed, and inside today's window."""
    if not p.is_published:
        return False
    now = (when or datetime.now(timezone.utc)).astimezone(BD_TZ)
    if p.closed_until is not None:
        cu = p.closed_until
        if cu.tzinfo is None:
            cu = cu.replace(tzinfo=timezone.utc)
        if cu > now.astimezone(timezone.utc):
            return False

    hours = parse_hours(p.opening_hours_json)
    day_key = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][now.weekday()]
    today = hours.get(day_key) or {}
    if today.get("closed"):
        return False
    open_t = today.get("open") or "00:00"
    close_t = today.get("close") or "23:59"
    cur = now.strftime("%H:%M")
    # Handle wrap-around (e.g. 22:00 -> 02:00) by treating close <= open as next-day close.
    if close_t <= open_t:
        return cur >= open_t or cur < close_t
    return open_t <= cur < close_t


def tier_rules(tier: str | None) -> Dict[str, Any]:
    return TIER_RULES.get((tier or "C").upper(), TIER_RULES["C"])


def end_of_today_bd_utc(now: datetime | None = None) -> datetime:
    """Return next BD-midnight as a UTC datetime (used for 'close for today')."""
    bd_now = (now or datetime.now(timezone.utc)).astimezone(BD_TZ)
    bd_midnight = (bd_now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return bd_midnight.astimezone(timezone.utc)
