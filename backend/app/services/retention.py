"""
90-day data-retention sweep — runs in the background, wired in `main.py`.

Policy (decided in the admin cockpit spec — see ``admin.py`` / cockpit tab):

  • Orders in a *terminal* status (delivered / rejected / cancelled) whose
    ``updated_at`` is older than 90 days are hard-deleted. Cascades take care
    of the linked ``order_messages`` and ``rider_offers`` rows.

  • For every Conversation that no longer has *any* non-terminal Order
    pointing at it, every ``conversation_messages`` row older than 90 days is
    deleted. The conversation row itself is preserved so participants don't
    suddenly lose their thread shell, and so ``Order.conversation_id`` FKs
    remain valid for any still-living orders.

  • Per-role admin support threads (``customer_admin_messages``,
    ``pharmacy_admin_messages``, ``rider_admin_messages``): rows older than
    90 days are deleted **only if** ``is_read = 1``. Unread admin replies
    are preserved indefinitely so users never miss a notice.

  • Attachment files under ``backend/uploads/`` referenced by any deleted
    row are removed from disk.

Every sweep appends one summary row to ``data_purge_log`` for accountability.

The loop sleeps until 03:00 Asia/Dhaka local time each day. The very first
sweep happens 60s after startup so devs see the path execute without waiting
24h. Failures are swallowed (and printed) so a bad sweep can't crash the API.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import AsyncSessionLocal
from app.models import (
    Conversation,
    ConversationMessage,
    CustomerAdminMessage,
    DataPurgeLog,
    Order,
    OrderStatus,
    PharmacyAdminMessage,
    RiderAdminMessage,
)


RETENTION_DAYS = 90
DHAKA_OFFSET = timedelta(hours=6)
SWEEP_HOUR_LOCAL = 3  # 03:00 Asia/Dhaka

UPLOAD_ROOT = Path(__file__).resolve().parents[2] / "uploads"

TERMINAL_STATUSES = (OrderStatus.delivered, OrderStatus.rejected, OrderStatus.cancelled)


def _seconds_until_next_3am_dhaka() -> float:
    """How many seconds to sleep so the next wake-up lands on 03:00 BD time."""
    now_utc = datetime.now(timezone.utc)
    now_local = now_utc + DHAKA_OFFSET
    target_local = now_local.replace(hour=SWEEP_HOUR_LOCAL, minute=0, second=0, microsecond=0)
    if target_local <= now_local:
        target_local = target_local + timedelta(days=1)
    return (target_local - now_local).total_seconds()


def _unlink_many(urls: Iterable[str | None]) -> int:
    n = 0
    for url in urls:
        if not url:
            continue
        if not url.startswith("/uploads/"):
            continue
        p = UPLOAD_ROOT / url[len("/uploads/"):]
        try:
            if p.exists():
                p.unlink()
                n += 1
        except OSError:
            pass
    return n


# N12 — if a scheduled sweep already ran within this window, skip. This keeps
# multiple workers (or rapid restarts) from running the daily cleanup several
# times at once.
SWEEP_DEDUPE_HOURS = 18


async def _recent_scheduled_sweep_exists(db: AsyncSession) -> bool:
    since = datetime.now(timezone.utc) - timedelta(hours=SWEEP_DEDUPE_HOURS)
    row = (
        await db.execute(
            select(DataPurgeLog.id).where(
                DataPurgeLog.kind == "scheduled",
                DataPurgeLog.created_at >= since,
            ).limit(1)
        )
    ).first()
    return row is not None


async def run_retention_sweep(db: AsyncSession, *, force: bool = False) -> DataPurgeLog | None:
    """Execute one sweep. Caller commits. Returns None if skipped (N12 dedupe)."""
    if not force and await _recent_scheduled_sweep_exists(db):
        return None
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)

    # ─── 1. Terminal orders > 90d ───────────────────────────────────────
    stale_orders = (
        await db.execute(
            select(Order).where(
                Order.status.in_(TERMINAL_STATUSES),
                Order.updated_at < cutoff,
            )
        )
    ).scalars().all()

    attachments_removed = 0
    order_msg_count_estimate = 0
    rider_offer_count_estimate = 0
    affected_conv_ids: set = set()

    if stale_orders:
        attachments_removed += _unlink_many(o.prescription_url for o in stale_orders)
        for o in stale_orders:
            if o.conversation_id:
                affected_conv_ids.add(o.conversation_id)
            order_msg_count_estimate += len(o.messages or [])
            rider_offer_count_estimate += len(o.rider_offers or [])
        # Cascading FK delete handles order_messages + rider_offers.
        await db.execute(delete(Order).where(Order.id.in_([o.id for o in stale_orders])))

    # ─── 2. Conversation messages > 90d for conversations with no live order ──
    conv_msgs_deleted = 0
    if affected_conv_ids:
        # Re-confirm each conv has no remaining non-terminal order; if it does,
        # we leave the chat untouched so participants keep their context.
        for cid in list(affected_conv_ids):
            still_live = (
                await db.execute(
                    select(Order.id).where(
                        Order.conversation_id == cid,
                        Order.status.notin_(TERMINAL_STATUSES),
                    ).limit(1)
                )
            ).first()
            if still_live is not None:
                affected_conv_ids.discard(cid)

    if affected_conv_ids:
        old_msgs = (
            await db.execute(
                select(ConversationMessage).where(
                    ConversationMessage.conversation_id.in_(affected_conv_ids),
                    ConversationMessage.created_at < cutoff,
                )
            )
        ).scalars().all()
        if old_msgs:
            attachments_removed += _unlink_many(m.attachment_url for m in old_msgs)
            conv_msgs_deleted = len(old_msgs)
            await db.execute(
                delete(ConversationMessage).where(
                    ConversationMessage.id.in_([m.id for m in old_msgs])
                )
            )
            # N9 — a moderation BLOCK is permanent. We must NOT lift it just
            # because the offending messages aged out of the 90-day window
            # (otherwise a bad chat silently re-opens). Only reset the soft
            # `flag_count` warning counter, and ONLY for conversations that are
            # not blocked. Blocked conversations keep blocked_at/reason/category.
            convs = (
                await db.execute(
                    select(Conversation).where(Conversation.id.in_(affected_conv_ids))
                )
            ).scalars().all()
            for c in convs:
                if c.blocked_at is None:
                    c.flag_count = 0

    # ─── 3. Read-only admin support threads > 90d ───────────────────────
    admin_msgs_deleted = 0
    for Model in (CustomerAdminMessage, PharmacyAdminMessage, RiderAdminMessage):
        stale = (
            await db.execute(
                select(Model).where(
                    Model.is_read.is_(True),
                    Model.created_at < cutoff,
                )
            )
        ).scalars().all()
        if not stale:
            continue
        attachments_removed += _unlink_many(getattr(m, "attachment_url", None) for m in stale)
        admin_msgs_deleted += len(stale)
        await db.execute(delete(Model).where(Model.id.in_([m.id for m in stale])))

    # ─── 4. Append summary row ──────────────────────────────────────────
    log_row = DataPurgeLog(
        kind="scheduled",
        actor_gmail=None,
        orders_deleted=len(stale_orders),
        order_messages_deleted=order_msg_count_estimate,
        conv_messages_deleted=conv_msgs_deleted,
        rider_offers_deleted=rider_offer_count_estimate,
        admin_messages_deleted=admin_msgs_deleted,
        attachments_deleted=attachments_removed,
        notes=f"cutoff={cutoff.isoformat()}",
    )
    db.add(log_row)
    return log_row


async def retention_loop(stop_event: asyncio.Event) -> None:
    """Run forever until `stop_event` is set. One sweep per day at 03:00 BD."""
    # First sweep shortly after startup so the path is exercised in dev.
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=60)
        return
    except asyncio.TimeoutError:
        pass

    while not stop_event.is_set():
        try:
            async with AsyncSessionLocal() as db:
                summary = await run_retention_sweep(db)
                await db.commit()
                if summary is None:
                    print(
                        "[retention] skipped — another sweep ran recently "
                        f"(within {SWEEP_DEDUPE_HOURS}h)",
                        flush=True,
                    )
                else:
                    print(
                        f"[retention] swept @ {datetime.now(timezone.utc).isoformat()} — "
                        f"orders={summary.orders_deleted} "
                        f"order_msgs={summary.order_messages_deleted} "
                        f"conv_msgs={summary.conv_messages_deleted} "
                        f"offers={summary.rider_offers_deleted} "
                        f"admin_msgs={summary.admin_messages_deleted} "
                        f"files={summary.attachments_deleted}",
                        flush=True,
                    )
        except Exception as exc:  # noqa: BLE001
            print(f"[retention] sweep failed: {exc!r}", flush=True)

        # Sleep until tomorrow 03:00 BD, but wake early if stop is signalled.
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=_seconds_until_next_3am_dhaka())
        except asyncio.TimeoutError:
            continue
