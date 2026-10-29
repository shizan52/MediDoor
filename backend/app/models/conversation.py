"""
Conversation + ConversationMessage — direct customer↔pharmacy chat.

Distinct from OrderMessage (which is scoped to a single order). A Conversation
exists once per (pharmacy_id, customer_account_id) pair so customers can chat
with a pharmacy *before* placing an order (e.g. "do you stock X?").
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.order import SenderRole  # reuse customer/pharmacy/rider/system enum


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        UniqueConstraint("pharmacy_id", "customer_account_id", name="uq_conv_pair"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    pharmacy_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("pharmacy_profiles.id", ondelete="CASCADE"), index=True
    )
    customer_account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    # Rider becomes the 3rd participant after they accept the delivery offer
    # for an order tied to this conversation. Null until then.
    rider_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("rider_profiles.id", ondelete="SET NULL"), nullable=True, index=True
    )
    customer_name: Mapped[str] = mapped_column(String(160), nullable=False, default="Customer")
    last_message_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    customer_last_read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    pharmacy_last_read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    rider_last_read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # ── AI moderation block state ───────────────────────────────────────
    # Set when a HIGH-risk message arrives; cleared when admin unblocks.
    blocked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    block_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    block_category: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # Counter incremented every time a MEDIUM/HIGH risk message is logged
    # — used to surface "needs attention" conversations in the admin panel
    # even after a block has been resolved.
    flag_count: Mapped[int] = mapped_column(
        nullable=False, server_default="0", default=0
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    messages: Mapped[list["ConversationMessage"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="ConversationMessage.created_at",
    )


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    sender_role: Mapped[SenderRole] = mapped_column(
        SAEnum(SenderRole, name="msg_sender_enum", create_constraint=False),
        nullable=False,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    attachment_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    preset_key: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # JSON-encoded structured payload for itemized presets like
    # `order_request` and `pharmacy_quote`. Shape:
    #   {"items":[{"medicine_id","name","qty","unit_price","image_url"}],
    #    "subtotal","delivery_fee","total","note"}
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Visibility filter. "all" = visible to every participant (default).
    # "customer_rider" = visible only to customer + rider (pharmacy hidden).
    # "pharmacy_rider" = visible only to pharmacy + rider (customer hidden).
    visibility: Mapped[str] = mapped_column(String(20), nullable=False, server_default="all", default="all")
    # ── AI moderation outcome (only set on user-typed messages) ─────────
    # Risk: "none" | "low" | "medium" | "high". Reason is shown to admin.
    moderation_risk: Mapped[str | None] = mapped_column(String(10), nullable=True, index=True)
    moderation_category: Mapped[str | None] = mapped_column(String(40), nullable=True)
    moderation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # True when the message was auto-blocked (HIGH risk) — kept in DB but
    # the conversation is locked until admin reviews.
    was_blocked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="0", default=False
    )
    # Set after an admin marks a flagged message as reviewed.
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    conversation: Mapped[Conversation] = relationship(back_populates="messages")
