"""
Pharmacy verification orchestration — sits between the FastAPI routes and
the raw DGDA HTTP service in `services/dgda_verify.py`.

Responsibilities:
- License-uniqueness check (so two pharmacies can't claim the same license)
- Background task that runs the DGDA bot and persists the result
- Resubmit helper used by `POST /api/pharmacy/me/verify-resubmit`

The background task uses a fresh `AsyncSession` because the request-scoped
session has already been closed by the time it runs (FastAPI's
BackgroundTasks fire after the response is sent).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Iterable
from uuid import UUID

from fastapi import BackgroundTasks
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import AsyncSessionLocal
from app.models import AiNotification, PharmacyProfile
from app.services.dgda_verify import VerificationResult, verify_pharmacy

logger = logging.getLogger(__name__)


def _norm_license(s: str) -> str:
    return re.sub(r"\s+", "", (s or "").strip().lower())


async def license_already_taken(
    db: AsyncSession,
    license_no: str,
    *,
    exclude_pharmacy_id: UUID | None = None,
) -> bool:
    """Return True if another pharmacy already holds this license in a
    pending or verified state. Failed/not_found rows do NOT block (so a typo
    on someone else's account doesn't lock a real pharmacist out).
    """
    target = _norm_license(license_no)
    if not target:
        return False
    # SQLite has no easy LOWER+REPLACE chain that matches our normalisation,
    # so we filter in Python. The pharmacy table is tiny (one per account)
    # which keeps this trivially fast.
    rows = (
        await db.execute(
            select(PharmacyProfile).where(
                PharmacyProfile.verification_status.in_(("pending", "verified"))
            )
        )
    ).scalars().all()
    for row in rows:
        if exclude_pharmacy_id and row.id == exclude_pharmacy_id:
            continue
        if _norm_license(row.pharmacy_license_no) == target:
            return True
    return False


def _apply_result(p: PharmacyProfile, result: VerificationResult, db: AsyncSession) -> None:
    # N7 — on a transient DGDA outage ("error") during a re-check, never
    # downgrade an already-verified pharmacy. Just record the attempt and bail;
    # the background re-verify loop will try again later.
    if result.status == "error" and p.is_verified:
        p.verification_checked_at = datetime.now(timezone.utc)
        p.verification_attempts = (p.verification_attempts or 0) + 1
        return

    p.verification_status = result.status
    p.verification_message = result.message
    p.verification_mismatch_fields = (
        json.dumps(result.mismatch_fields) if result.mismatch_fields else None
    )
    p.verification_dgda_data = (
        json.dumps(result.dgda_record) if result.dgda_record else None
    )
    p.verification_checked_at = datetime.now(timezone.utc)
    p.verification_attempts = (p.verification_attempts or 0) + 1
    # Mirror into the existing legacy flag — verified pharmacies show on the
    # storefront and get the green badge.
    p.is_verified = result.status == "verified"

    # N7 — if a re-check finds the license definitively invalid (expired beyond
    # grace, identity mismatch, or no longer in the registry), pull the store
    # offline automatically. ("error" is transient and handled above.)
    if result.status in ("expired", "mismatch", "not_found"):
        p.is_published = False

    # N2 — verified-but-expired (within grace): keep them live, flag it, and
    # drop a one-time "please renew" notice into their MediAI inbox. Only post
    # the notice when the flag flips on (avoid spamming on every re-check).
    was_flagged = bool(getattr(p, "license_needs_renewal", False))
    p.license_needs_renewal = bool(result.needs_renewal)
    if result.needs_renewal and not was_flagged:
        db.add(AiNotification(
            pharmacy_id=p.id,
            kind="license_renewal",
            title="License renew করুন",
            body_bn=(
                "আপনার DGDA license-এর মেয়াদ শেষ হয়ে গেছে। আপনি আপাতত MediDoor-এ "
                "চালু থাকবেন, তবে অনুগ্রহ করে DGDA থেকে license renew করে নিন।"
            ),
        ))


async def run_verification_now(pharmacy_id: UUID) -> VerificationResult | None:
    """Run a single verification pass and persist the result. Returns the
    result for callers that want to act on it synchronously."""
    async with AsyncSessionLocal() as db:
        p = (
            await db.execute(
                select(PharmacyProfile).where(PharmacyProfile.id == pharmacy_id)
            )
        ).scalar_one_or_none()
        if p is None:
            logger.warning("pharmacy %s vanished before verification", pharmacy_id)
            return None
        result = await verify_pharmacy(
            license_no=p.pharmacy_license_no,
            owner_name=p.owner_name,
            pharmacy_name=p.pharmacy_name,
            pharmacist_name=p.pharmacist_name or "",
            pharmacist_reg_no=p.pharmacist_reg_no or "",
        )
        _apply_result(p, result, db)
        await db.commit()
        logger.info(
            "pharmacy %s verification: status=%s mismatch=%s",
            pharmacy_id, result.status, result.mismatch_fields,
        )
        return result


def schedule_pharmacy_verification(
    background: BackgroundTasks, pharmacy_id: UUID
) -> None:
    """Schedule the DGDA bot to run after the current request finishes."""
    background.add_task(run_verification_now, pharmacy_id)


# ---------------------------------------------------------------------------
# N7 — periodic re-verification. A "verified" pharmacy is never trusted
# forever: every REVERIFY_INTERVAL_DAYS we re-run the DGDA check. If the
# license is now expired-beyond-grace / mismatched / missing, _apply_result
# auto-unpublishes the store. A transient DGDA outage never downgrades it.
# ---------------------------------------------------------------------------

REVERIFY_INTERVAL_DAYS = 30
REVERIFY_BATCH = 8          # pharmacies per cycle — gentle on the DGDA server
REVERIFY_CYCLE_HOURS = 6    # how often the loop wakes


async def _due_for_reverification(db: AsyncSession) -> list[UUID]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=REVERIFY_INTERVAL_DAYS)
    rows = (
        await db.execute(
            select(PharmacyProfile.id).where(
                PharmacyProfile.verification_status == "verified",
                or_(
                    PharmacyProfile.verification_checked_at.is_(None),
                    PharmacyProfile.verification_checked_at < cutoff,
                ),
            ).limit(REVERIFY_BATCH)
        )
    ).scalars().all()
    return list(rows)


async def pharmacy_reverify_loop(stop_event: asyncio.Event) -> None:
    """Re-verify a small batch of stale-verified pharmacies on each cycle."""
    # Small startup delay so it doesn't pile onto boot.
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=120)
        return
    except asyncio.TimeoutError:
        pass

    while not stop_event.is_set():
        try:
            async with AsyncSessionLocal() as db:
                due = await _due_for_reverification(db)
            for pid in due:
                if stop_event.is_set():
                    break
                try:
                    await run_verification_now(pid)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("re-verify failed for %s: %r", pid, exc)
                # Pace the DGDA calls so we don't hammer their server.
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=3)
                    break
                except asyncio.TimeoutError:
                    pass
            if due:
                logger.info("[reverify] re-checked %d pharmacy(ies)", len(due))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[reverify] cycle failed: %r", exc)

        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=REVERIFY_CYCLE_HOURS * 3600
            )
        except asyncio.TimeoutError:
            continue


def parse_mismatch_fields(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(x) for x in parsed if isinstance(x, str)]


def parse_dgda_record(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed
