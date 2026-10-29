"""
Order, OrderMessage, RiderOffer — pharmacy order workflow.

Order lifecycle:
    pending (placed by customer)
        -> confirmed       (pharmacy accepted)
        -> packaging       (pharmacy preparing)
        -> ready           (packaging done, awaiting rider)
        -> dispatched      (rider accepted offer / on the way)
        -> delivered       (rider marked delivered)
    pending  -> rejected   (pharmacy declined)
    *        -> cancelled  (customer cancelled before confirmed)
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class OrderStatus(str, enum.Enum):
    pending = "pending"
    confirmed = "confirmed"
    packaging = "packaging"
    ready = "ready"
    dispatched = "dispatched"
    delivered = "delivered"
    rejected = "rejected"
    cancelled = "cancelled"


class SenderRole(str, enum.Enum):
    customer = "customer"
    pharmacy = "pharmacy"
    rider = "rider"
    system = "system"


class RiderOfferStatus(str, enum.Enum):
    offered = "offered"
    accepted = "accepted"
    declined = "declined"
    expired = "expired"


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    pharmacy_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("pharmacy_profiles.id", ondelete="CASCADE"), index=True
    )
    # customer_account_id — nullable so guest orders work too.
    customer_account_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )

    customer_name: Mapped[str] = mapped_column(String(160), nullable=False)
    customer_phone: Mapped[str] = mapped_column(String(40), nullable=False)
    delivery_address: Mapped[str] = mapped_column(String(500), nullable=False)
    delivery_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    delivery_lng: Mapped[float | None] = mapped_column(Float, nullable=True)

    # JSON-encoded list[{medicine_id, name, qty, price, image_url}]
    items_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    prescription_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    subtotal: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    delivery_fee: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    total: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    # True once this order has decremented medicine stock (manual + AI orders
    # reserve immediately). Used so cancel/reject can return stock exactly once.
    # Chat orders don't reserve stock, so they keep this False.
    stock_reserved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Customer's post-delivery ratings (1-5). Set once, only by the customer who
    # owns the delivered order — prevents repeat / fake rating of pharmacies.
    pharmacy_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rider_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[OrderStatus] = mapped_column(
        SAEnum(OrderStatus, name="order_status_enum"),
        default=OrderStatus.pending, nullable=False, index=True,
    )
    rejection_reason: Mapped[str | None] = mapped_column(String(280), nullable=True)
    accepted_rider_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("rider_profiles.id", ondelete="SET NULL"), nullable=True
    )
    # Link back to the chat-first conversation that created this order (if any).
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True, index=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    messages: Mapped[list["OrderMessage"]] = relationship(
        back_populates="order", cascade="all, delete-orphan",
        order_by="OrderMessage.created_at",
    )
    rider_offers: Mapped[list["RiderOffer"]] = relationship(
        back_populates="order", cascade="all, delete-orphan",
    )


class OrderMessage(Base):
    __tablename__ = "order_messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    order_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("orders.id", ondelete="CASCADE"), index=True
    )
    sender_role: Mapped[SenderRole] = mapped_column(
        SAEnum(SenderRole, name="msg_sender_enum"), nullable=False
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    preset_key: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    order: Mapped[Order] = relationship(back_populates="messages")


class RiderOffer(Base):
    __tablename__ = "rider_offers"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    order_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("orders.id", ondelete="CASCADE"), index=True
    )
    rider_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("rider_profiles.id", ondelete="CASCADE"), index=True
    )
    payout_amount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    distance_km: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    status: Mapped[RiderOfferStatus] = mapped_column(
        SAEnum(RiderOfferStatus, name="rider_offer_status_enum"),
        default=RiderOfferStatus.offered, nullable=False,
    )
    offered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    responded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    order: Mapped[Order] = relationship(back_populates="rider_offers")
