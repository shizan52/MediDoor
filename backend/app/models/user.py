"""
MediDoor user/account models.

Design:
- `Account` represents one signed-in identity. **One Gmail = one Account = one
  Role**, chosen at first signup. Re-logging in with the same Gmail always
  returns the existing role (the role tab on the login screen is only used
  for brand-new accounts).
- Profile tables (CustomerProfile, PharmacyProfile, RiderProfile) hold
  role-specific fields and link 1:1 to their `Account`.
"""
from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class RoleEnum(str, enum.Enum):
    customer = "customer"
    pharmacy = "pharmacy"
    rider = "rider"


class GenderEnum(str, enum.Enum):
    male = "male"
    female = "female"
    other = "other"


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        # One Gmail = one Account total (one role for life).
        UniqueConstraint("gmail", name="uq_account_gmail"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    gmail: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    google_sub: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    role: Mapped[RoleEnum] = mapped_column(SAEnum(RoleEnum, name="role_enum"), nullable=False)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_registered: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    customer: Mapped["CustomerProfile | None"] = relationship(
        back_populates="account", uselist=False, cascade="all, delete-orphan"
    )
    pharmacy: Mapped["PharmacyProfile | None"] = relationship(
        back_populates="account", uselist=False, cascade="all, delete-orphan"
    )
    rider: Mapped["RiderProfile | None"] = relationship(
        back_populates="account", uselist=False, cascade="all, delete-orphan"
    )


class CustomerProfile(Base):
    __tablename__ = "customer_profiles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("accounts.id", ondelete="CASCADE"), unique=True
    )

    first_name: Mapped[str] = mapped_column(String(80), nullable=False)
    last_name: Mapped[str] = mapped_column(String(80), nullable=False)
    phone_number: Mapped[str] = mapped_column(String(20), nullable=False)
    date_of_birth: Mapped[date | None] = mapped_column(Date, nullable=True)
    gender: Mapped[GenderEnum | None] = mapped_column(
        SAEnum(GenderEnum, name="gender_enum"), nullable=True
    )
    profile_photo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_banned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    ban_notice: Mapped[str | None] = mapped_column(Text, nullable=True)
    banned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    banned_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Last saved location (set whenever a GPS-capable device — usually the
    # customer's phone — runs Locate-me while logged in). GPS-less devices
    # (desktop browsers) reuse it via GET /api/geo/me/location until a newer
    # save replaces it.
    last_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_location_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_location_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    account: Mapped[Account] = relationship(back_populates="customer")


class PharmacyProfile(Base):
    __tablename__ = "pharmacy_profiles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("accounts.id", ondelete="CASCADE"), unique=True
    )

    pharmacy_name: Mapped[str] = mapped_column(String(160), nullable=False)
    owner_name: Mapped[str] = mapped_column(String(160), nullable=False)
    business_name: Mapped[str] = mapped_column(String(160), nullable=False)
    pharmacy_license_no: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    pharmacy_license_doc_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    banner_photo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Registered pharmacist (“drug seller” in DGDA terminology). Required by
    # Bangladesh law for any model pharmacy / medicine shop. Verified against
    # the DGDA registry's drug_seller_name + drug_seller_code (e.g. "B-00270").
    pharmacist_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    pharmacist_reg_no: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # Location + storefront extras (added for customer landing storefront).
    address: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    rating: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rating_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    delivery_base_fee: Mapped[float] = mapped_column(Float, default=30.0, nullable=False)
    delivery_per_km_fee: Mapped[float] = mapped_column(Float, default=15.0, nullable=False)

    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Pharmacy dashboard fields (store details, schedule, publishing, plan).
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # opening_hours JSON: {"mon":{"open":"09:00","close":"22:00","closed":false}, ...}
    opening_hours_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_published: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_blocked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    block_notice: Mapped[str | None] = mapped_column(Text, nullable=True)
    blocked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    blocked_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Manual close override — when set in the future the shop is treated as closed.
    closed_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Subscription tier: "A" (premium), "B" (pro), "C" (basic, default for new pharmacies).
    subscription_tier: Mapped[str] = mapped_column(String(1), default="C", nullable=False)

    # ---------- DGDA automated verification ----------
    # Status: "pending" (awaiting bot), "verified" (license + owner + name +
    # pharmacist match the DGDA registry AND license still valid), "expired"
    # (data matches but license validity date is in the past — cannot legally
    # sell), "mismatch" (license found but some fields don't match — pharmacy
    # can edit & resubmit), "not_found" (license not in registry), "error"
    # (transient failure — bot will retry).
    verification_status: Mapped[str] = mapped_column(
        String(20), default="pending", nullable=False, index=True
    )
    # Bengali user-facing message describing the latest verification result.
    verification_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON list of fields that didn't match (e.g. ["owner_name", "pharmacy_name"]).
    verification_mismatch_fields: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON snapshot of the matched DGDA row (license, owner, drug_seller, address,
    # valid_until, district, upazila …) for audit + admin display.
    verification_dgda_data: Mapped[str | None] = mapped_column(Text, nullable=True)
    verification_checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    verification_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # N2 — verified but the DGDA license expired (within the grace window). The
    # pharmacy stays live but is nudged (notification) to renew its license.
    license_needs_renewal: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )

    account: Mapped[Account] = relationship(back_populates="pharmacy")
    medicines: Mapped[list["Medicine"]] = relationship(
        back_populates="pharmacy", cascade="all, delete-orphan"
    )
    categories: Mapped[list["MedicineCategory"]] = relationship(
        back_populates="pharmacy", cascade="all, delete-orphan"
    )


class MedicineCategory(Base):
    """Pharmacy-defined product category (e.g. 'Pain & Fever').

    Created by the pharmacy from a preset list or custom. Custom categories
    need a short description so customers know what's inside. A category has
    NO image / price / stock — those live on the medicines that belong to it.
    """
    __tablename__ = "medicine_categories"
    __table_args__ = (
        UniqueConstraint("pharmacy_id", "name", name="uq_category_pharmacy_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    pharmacy_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("pharmacy_profiles.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    short_description: Mapped[str | None] = mapped_column(String(280), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    pharmacy: Mapped["PharmacyProfile"] = relationship(back_populates="categories")


class Medicine(Base):
    __tablename__ = "medicines"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    pharmacy_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("pharmacy_profiles.id", ondelete="CASCADE"), index=True
    )

    name: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    short_description: Mapped[str | None] = mapped_column(String(280), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Primary AI-assigned category (kept for indexes / legacy filters).
    category: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    # Full set of AI-assigned categories — JSON list of strings.
    # A medicine can belong to multiple buckets (e.g. Paracetamol →
    # ["Pain & Fever", "Body Pain"]). The first entry mirrors `category`.
    # Nullable for backward-compat with legacy rows; readers must fall back
    # to `[category]` when null/empty.
    categories_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    price: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    stock: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # ---- Platform AI product moderation ----
    # AI auto-classifies new/edited products into approved | rejected | pending.
    # "pending" = AI was unsure (or unavailable) → admin must review.
    # Existing rows get backfilled to "approved" via autopatch DEFAULT.
    approval_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="approved", index=True
    )
    approval_category: Mapped[str | None] = mapped_column(String(40), nullable=True)
    approval_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    approval_reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    approval_reviewed_by_admin: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )

    # Pharmacy-set flag: does the customer need to upload a prescription to
    # order this item? AI MUST NOT decide this — it's the pharmacy's call,
    # because not every medicine actually needs an Rx.
    prescription_required: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    pharmacy: Mapped["PharmacyProfile"] = relationship(back_populates="medicines")


class RiderProfile(Base):
    __tablename__ = "rider_profiles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=_uuid)
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("accounts.id", ondelete="CASCADE"), unique=True
    )

    full_name: Mapped[str] = mapped_column(String(160), nullable=False)
    nick_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # Stored under `phone_number` for backwards-compat — UI labels it as
    # WhatsApp number (it's the contact channel pharmacies/customers use).
    phone_number: Mapped[str] = mapped_column(String(20), nullable=False)
    age: Mapped[int] = mapped_column(Integer, nullable=False)

    # Documents — rider must submit EITHER a NID OR a (birth-certificate +
    # student-ID) bundle. The schema validator enforces the rule; both
    # column groups stay nullable so legacy rows / partial drafts don't crash.
    nid_number: Mapped[str | None] = mapped_column(String(40), nullable=True, unique=True)
    nid_front_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    nid_back_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    birth_certificate_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    student_id_card_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    profile_photo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Manual admin verification workflow (admin.py Users → Riders tab).
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    verification_status: Mapped[str] = mapped_column(
        String(20), default="pending", nullable=False
    )  # pending | verified | rejected
    verification_note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    verification_reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    verification_reviewed_by: Mapped[str | None] = mapped_column(String(160), nullable=True)

    # Customer rating (running average), set after delivered orders.
    rating: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rating_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Last-known location for the 5 km rider broadcast (geo_policy).
    last_lat: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    last_lng: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    account: Mapped[Account] = relationship(back_populates="rider")
