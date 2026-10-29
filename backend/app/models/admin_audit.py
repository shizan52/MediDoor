"""
AdminAuditLog + DataPurgeLog — admin accountability tables.

`admin_audit_log` records every privileged write performed via the
`/api/admin/orders/...` cockpit (force-cancel, reassign rider, edit order,
delete message, manual purge, etc.). Cheap, append-only, surfaced read-only
in the Tk admin tool.

`data_purge_log` records every automated 90-day retention run so we can
prove what was deleted and when. One row per scheduled sweep.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class AdminAuditLog(Base):
    """Append-only log of admin actions performed through the cockpit."""

    __tablename__ = "admin_audit_log"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    # Admin gmail (e.g. "admin@medidoor.app"). Free-form so future SSO is fine.
    actor_gmail: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    # Short verb: "order.cancel", "order.reassign_rider", "order.edit",
    # "order.purge", "message.delete", "conversation.purge", ...
    action: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    # Free-form target identifier — usually an order_id / conversation_id /
    # message_id (UUID hex). Lookup-friendly without forcing a FK.
    target_type: Mapped[str] = mapped_column(String(40), nullable=False)
    target_id: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    # Human-readable reason / admin note shown back in the audit feed.
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON-encoded snapshot of the before/after diff (or any extra context).
    # Kept as Text so we never lock the column shape.
    details_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class DataPurgeLog(Base):
    """One row per 90-day retention sweep — summary of what was deleted."""

    __tablename__ = "data_purge_log"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    # "scheduled" (background task) | "manual" (admin clicked Purge).
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="scheduled")
    actor_gmail: Mapped[str | None] = mapped_column(String(160), nullable=True)
    # Counts.
    orders_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    order_messages_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    conv_messages_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    rider_offers_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    admin_messages_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    attachments_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
