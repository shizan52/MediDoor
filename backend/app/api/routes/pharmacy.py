"""
Pharmacy dashboard routes — auth required, role=pharmacy.

Endpoints (all under /api/pharmacy):

  GET    /me                    -> profile + tier_rules + computed `is_open_now`
  PATCH  /me                    -> update store details (name, description, phone,
                                    address, lat/lng, opening_hours, banner,
                                    delivery fees, subscription_tier, is_published)
  POST   /me/close-today        -> set closed_until = next BD midnight
  POST   /me/open-now           -> clear closed_until

  GET    /me/medicines          -> list (all, including out-of-stock)
  POST   /me/medicines          -> create
  PATCH  /me/medicines/{id}     -> update
  DELETE /me/medicines/{id}     -> hard delete

  GET    /me/orders             -> list orders (?status=…&limit=…)
  POST   /me/orders/{id}/confirm
  POST   /me/orders/{id}/reject  body: {reason?}
  POST   /me/orders/{id}/status  body: {status}    -- packaging|ready|delivered
  POST   /me/orders/{id}/messages body: {body, preset_key?}
  POST   /me/orders/{id}/dispatch -> create RiderOffers for riders within 5 km

  GET    /me/analytics          -> totals + monthly + breakdowns
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_account, get_db
from app.models import (
    Account,
    AiNotification,
    CategoryCatalog,
    ConversationMessage,
    Medicine,
    MedicineCategory,
    Order,
    OrderMessage,
    OrderStatus,
    PharmacyAdminMessage,
    PharmacyProfile,
    RiderOffer,
    RiderOfferStatus,
    RiderProfile,
    RoleEnum,
    SenderRole,
)
from app.services.pharmacy_policy import ensure_pharmacy_not_blocked
from app.services.pharmacy_ops import (
    DEFAULT_HOURS,
    end_of_today_bd_utc,
    is_open_now,
    parse_hours,
    serialize_hours,
    tier_rules,
)
from app.services.pharmacy_verify import (
    license_already_taken,
    parse_dgda_record,
    parse_mismatch_fields,
    schedule_pharmacy_verification,
)
from app.services.notify import notify as user_notify
from app.services.stock import restore_order_stock
from app.services.dispatch import broadcast_rider_offers
from app.services.geo_policy import RIDER_BROADCAST_RADIUS_KM

router = APIRouter(prefix="/api/pharmacy", tags=["pharmacy"])

EARTH_KM = 6371.0


def _km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(a))


def _require_pharmacy(account: Account) -> PharmacyProfile:
    if account.role != RoleEnum.pharmacy:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Pharmacy role required")
    if not account.pharmacy:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pharmacy profile not found")
    return account.pharmacy


def _require_operational_pharmacy(account: Account) -> PharmacyProfile:
    p = _require_pharmacy(account)
    ensure_pharmacy_not_blocked(account)
    return p


def medicine_categories(m: Medicine) -> List[str]:
    """Parse Medicine.categories_json → list of category names.

    Falls back to `[m.category]` for legacy rows where the JSON field is
    null/empty. Always returns at least one entry when the medicine itself
    has a category set; returns [] only if both are absent.
    """
    raw = getattr(m, "categories_json", None)
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                cleaned = [str(x).strip() for x in parsed if isinstance(x, (str,)) and str(x).strip()]
                if cleaned:
                    return cleaned
        except (ValueError, TypeError):
            pass
    if m.category:
        return [m.category]
    return []


def _serialize_medicine_admin(m: Medicine) -> Dict[str, Any]:
    cats = medicine_categories(m)
    return {
        "id": str(m.id),
        "name": m.name,
        "short_description": m.short_description,
        "description": m.description,
        "category": m.category,
        "categories": cats,
        "image_url": m.image_url,
        "price": m.price,
        "stock": m.stock,
        "is_active": m.is_active,
        "prescription_required": bool(getattr(m, "prescription_required", False)),
        "approval_status": getattr(m, "approval_status", "approved") or "approved",
        "approval_category": getattr(m, "approval_category", None),
        "approval_reason": getattr(m, "approval_reason", None),
        "approval_reviewed_at": (
            m.approval_reviewed_at.isoformat()
            if getattr(m, "approval_reviewed_at", None) else None
        ),
        "approval_reviewed_by_admin": bool(
            getattr(m, "approval_reviewed_by_admin", False)
        ),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _serialize_pharmacy_self(p: PharmacyProfile) -> Dict[str, Any]:
    rules = tier_rules(p.subscription_tier)
    return {
        "id": str(p.id),
        "pharmacy_name": p.pharmacy_name,
        "owner_name": p.owner_name,
        "business_name": p.business_name,
        "pharmacy_license_no": p.pharmacy_license_no,
        "pharmacy_license_doc_url": p.pharmacy_license_doc_url,
        "pharmacist_name": p.pharmacist_name,
        "pharmacist_reg_no": p.pharmacist_reg_no,
        "banner_photo_url": p.banner_photo_url,
        "address": p.address,
        "phone_number": p.phone_number,
        "lat": p.lat,
        "lng": p.lng,
        "rating": round(p.rating, 1),
        "rating_count": p.rating_count,
        "delivery_base_fee": p.delivery_base_fee,
        "delivery_per_km_fee": p.delivery_per_km_fee,
        "is_verified": p.is_verified,
        "description": p.description,
        "opening_hours": parse_hours(p.opening_hours_json),
        "is_published": p.is_published,
        "is_blocked": bool(getattr(p, "is_blocked", False)),
        "block_notice": getattr(p, "block_notice", None),
        "blocked_at": p.blocked_at.isoformat() if getattr(p, "blocked_at", None) else None,
        "blocked_by": getattr(p, "blocked_by", None),
        "closed_until": p.closed_until.isoformat() if p.closed_until else None,
        "subscription_tier": p.subscription_tier,
        "tier_rules": rules,
        "is_open_now": is_open_now(p),
        "verification": {
            "status": p.verification_status,
            "message": _public_verification_message(p),
            "mismatch_fields": parse_mismatch_fields(p.verification_mismatch_fields),
            "dgda_record": _public_dgda_record(p),
            "checked_at": (
                p.verification_checked_at.isoformat()
                if p.verification_checked_at else None
            ),
            "attempts": p.verification_attempts or 0,
        },
    }


def _public_dgda_record(p: PharmacyProfile) -> dict | None:
    if p.verification_status in {"mismatch", "not_found"}:
        return None
    return parse_dgda_record(p.verification_dgda_data)


def _public_verification_message(p: PharmacyProfile) -> str | None:
    if p.verification_status != "mismatch":
        return p.verification_message
    fields = parse_mismatch_fields(p.verification_mismatch_fields)
    labels = {
        "pharmacy_name": "Pharmacy name",
        "owner_name": "Owner name",
        "pharmacist_name": "Pharmacist name",
        "pharmacist_reg_no": "Pharmacist registration no.",
    }
    wrong = " ও ".join(labels.get(f, f) for f in fields) or "তথ্য"
    return (
        f"License number সঠিক, কিন্তু DGDA registry-তে আপনার দেওয়া {wrong} মিলছে না। "
        "সঠিক তথ্য দিয়ে আবার submit করুন।"
    )


def _serialize_order(o: Order, *, include_messages: bool = False) -> Dict[str, Any]:
    try:
        items = json.loads(o.items_json or "[]")
    except json.JSONDecodeError:
        items = []
    out: Dict[str, Any] = {
        "id": str(o.id),
        "pharmacy_id": str(o.pharmacy_id),
        "customer_name": o.customer_name,
        "customer_phone": o.customer_phone,
        "delivery_address": o.delivery_address,
        "delivery_lat": o.delivery_lat,
        "delivery_lng": o.delivery_lng,
        "items": items,
        "prescription_url": o.prescription_url,
        "note": o.note,
        "subtotal": o.subtotal,
        "delivery_fee": o.delivery_fee,
        "total": o.total,
        "status": o.status.value,
        "rejection_reason": o.rejection_reason,
        "accepted_rider_id": str(o.accepted_rider_id) if o.accepted_rider_id else None,
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "updated_at": o.updated_at.isoformat() if o.updated_at else None,
    }
    if include_messages:
        out["messages"] = [
            {
                "id": str(m.id),
                "sender_role": m.sender_role.value,
                "body": m.body,
                "preset_key": m.preset_key,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in (o.messages or [])
        ]
    return out


# ----------------------------- profile -----------------------------


@router.get("/me")
async def get_my_pharmacy(account: Account = Depends(get_current_account)) -> Dict[str, Any]:
    p = _require_pharmacy(account)
    return _serialize_pharmacy_self(p)


class PharmacyUpdate(BaseModel):
    pharmacy_name: str | None = None
    business_name: str | None = None
    owner_name: str | None = None
    description: str | None = None
    address: str | None = None
    phone_number: str | None = None
    lat: float | None = None
    lng: float | None = None
    banner_photo_url: str | None = None
    pharmacy_license_doc_url: str | None = None
    delivery_base_fee: float | None = Field(default=None, ge=0)
    delivery_per_km_fee: float | None = Field(default=None, ge=0)
    opening_hours: Dict[str, Dict[str, Any]] | None = None
    is_published: bool | None = None
    subscription_tier: str | None = Field(default=None, pattern=r"^[ABCabc]$")


@router.patch("/me")
async def update_my_pharmacy(
    payload: PharmacyUpdate,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    data = payload.model_dump(exclude_unset=True)
    # Publish gate — pharmacy must upload a banner image first AND have a
    # verified DGDA license before going public on the storefront.
    if data.get("is_published") is True:
        new_banner = data.get("banner_photo_url", p.banner_photo_url)
        if not new_banner:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Banner image upload করতে হবে publish করার আগে।",
            )
        if p.verification_status != "verified":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "DGDA verification সম্পূর্ণ না হলে shop publish করা যাবে না।",
            )
    if "opening_hours" in data and data["opening_hours"] is not None:
        # validate keys, dump back to text column
        cleaned: Dict[str, Dict[str, Any]] = {}
        for d in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
            entry = data["opening_hours"].get(d) or DEFAULT_HOURS[d]
            cleaned[d] = {
                "open": str(entry.get("open", "09:00"))[:5],
                "close": str(entry.get("close", "22:00"))[:5],
                "closed": bool(entry.get("closed", False)),
            }
        p.opening_hours_json = serialize_hours(cleaned)
        data.pop("opening_hours")
    # subscription_tier is a billing-controlled field. A pharmacy must NOT be
    # able to upgrade its own plan (e.g. to premium "A") for free through this
    # self-service endpoint — it is set by admin/billing only. Drop any
    # client-supplied value so it can never be changed here.
    data.pop("subscription_tier", None)

    for k, v in data.items():
        setattr(p, k, v)
    await db.commit()
    await db.refresh(p)
    return _serialize_pharmacy_self(p)


@router.post("/me/close-today")
async def close_today(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    p.closed_until = end_of_today_bd_utc()
    await db.commit()
    await db.refresh(p)
    return _serialize_pharmacy_self(p)


@router.post("/me/open-now")
async def open_now(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    p.closed_until = None
    await db.commit()
    await db.refresh(p)
    return _serialize_pharmacy_self(p)


# ----------------------------- MediDoor Admin thread -----------------------------


class PharmacyAdminThreadIn(BaseModel):
    body: str = Field(default="", max_length=4000)
    attachment_url: str | None = Field(default=None, max_length=500)
    attachment_mime: str | None = Field(default=None, max_length=120)


def _serialize_admin_thread_msg(m: PharmacyAdminMessage) -> Dict[str, Any]:
    return {
        "id": str(m.id),
        "direction": m.direction,
        "body": m.body,
        "attachment_url": m.attachment_url,
        "attachment_mime": m.attachment_mime,
        "is_read": bool(m.is_read),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


@router.get("/me/admin-thread")
async def get_my_admin_thread(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    _require_pharmacy(account)
    rows = (
        await db.execute(
            select(PharmacyAdminMessage)
            .where(PharmacyAdminMessage.pharmacy_account_id == account.id)
            .order_by(PharmacyAdminMessage.created_at.asc())
        )
    ).scalars().all()
    unread = [m for m in rows if m.direction == "admin_to_pharmacy" and not m.is_read]
    for m in unread:
        m.is_read = True
    if unread:
        await db.commit()
    return {"items": [_serialize_admin_thread_msg(m) for m in rows]}


@router.get("/me/admin-thread/unread")
async def get_my_admin_thread_unread(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    _require_pharmacy(account)
    count = (
        await db.execute(
            select(func.count(PharmacyAdminMessage.id))
            .where(PharmacyAdminMessage.pharmacy_account_id == account.id)
            .where(PharmacyAdminMessage.direction == "admin_to_pharmacy")
            .where(PharmacyAdminMessage.is_read.is_(False))
        )
    ).scalar_one()
    return {"unread": int(count or 0)}


@router.post("/me/admin-thread", status_code=201)
async def post_my_admin_thread(
    payload: PharmacyAdminThreadIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    _require_pharmacy(account)
    body = (payload.body or "").strip()
    attachment_url = (payload.attachment_url or "").strip() or None
    attachment_mime = (payload.attachment_mime or "").strip() or None
    if not body and not attachment_url:
        raise HTTPException(400, "Message body or attachment required")
    msg = PharmacyAdminMessage(
        pharmacy_account_id=account.id,
        direction="pharmacy_to_admin",
        body=body,
        attachment_url=attachment_url,
        attachment_mime=attachment_mime,
        is_read=False,
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    return _serialize_admin_thread_msg(msg)


# ----------------------------- DGDA verification -----------------------------


class VerifyResubmit(BaseModel):
    pharmacy_name: str = Field(min_length=1, max_length=160)
    owner_name: str = Field(min_length=1, max_length=160)
    pharmacy_license_no: str = Field(min_length=1, max_length=120)
    pharmacist_name: str = Field(min_length=1, max_length=160)
    pharmacist_reg_no: str = Field(min_length=1, max_length=60)


@router.get("/me/verification")
async def get_my_verification(
    account: Account = Depends(get_current_account),
) -> Dict[str, Any]:
    """Lightweight poll endpoint for the dashboard's verification gate."""
    p = _require_pharmacy(account)
    return {
        "status": p.verification_status,
        "message": _public_verification_message(p),
        "mismatch_fields": parse_mismatch_fields(p.verification_mismatch_fields),
        "dgda_record": _public_dgda_record(p),
        "checked_at": (
            p.verification_checked_at.isoformat()
            if p.verification_checked_at else None
        ),
        "attempts": p.verification_attempts or 0,
        "submitted": {
            "pharmacy_name": p.pharmacy_name,
            "owner_name": p.owner_name,
            "pharmacy_license_no": p.pharmacy_license_no,
            "pharmacist_name": p.pharmacist_name,
            "pharmacist_reg_no": p.pharmacist_reg_no,
        },
    }


@router.post("/me/verify-resubmit")
async def resubmit_verification(
    payload: VerifyResubmit,
    background: BackgroundTasks,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Pharmacy fixes the field(s) the DGDA bot flagged and resubmits.

    Allowed only when the current status is one of the *failed* states
    (mismatch / not_found / error) — verified pharmacies must contact admin
    to change identity fields, and pending requests must wait for the
    current run to finish.
    """
    p = _require_operational_pharmacy(account)
    if p.verification_status not in {"mismatch", "not_found", "error", "expired"}:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "এই মুহূর্তে details পাল্টানো যাবে না।",
        )
    if await license_already_taken(
        db, payload.pharmacy_license_no, exclude_pharmacy_id=p.id
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "এই DGDA license number ইতিমধ্যে অন্য একটি pharmacy ব্যবহার করছে।",
        )
    p.pharmacy_name = payload.pharmacy_name.strip()
    p.owner_name = payload.owner_name.strip()
    p.pharmacy_license_no = payload.pharmacy_license_no.strip()
    p.pharmacist_name = payload.pharmacist_name.strip()
    p.pharmacist_reg_no = payload.pharmacist_reg_no.strip()
    p.verification_status = "pending"
    p.verification_message = "নতুন তথ্য দিয়ে আবার যাচাই চলছে — অপেক্ষা করুন…"
    p.verification_mismatch_fields = None
    p.verification_dgda_data = None
    p.is_verified = False
    await db.commit()
    await db.refresh(p)
    schedule_pharmacy_verification(background, p.id)
    return _serialize_pharmacy_self(p)


@router.post("/me/verify-retry")
async def retry_verification(
    background: BackgroundTasks,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Re-run the DGDA bot with the SAME stored values. Used by the Retry
    button when status is "error" (transient DGDA outage). Also useful when
    a license has been renewed and the user wants to flip from `expired`
    back to `verified`."""
    p = _require_operational_pharmacy(account)
    if p.verification_status == "verified":
        # Idempotent: already verified, nothing to do.
        return _serialize_pharmacy_self(p)
    p.verification_status = "pending"
    p.verification_message = "DGDA-তে আবার যাচাই চলছে…"
    p.verification_mismatch_fields = None
    p.verification_dgda_data = None
    p.is_verified = False
    await db.commit()
    await db.refresh(p)
    schedule_pharmacy_verification(background, p.id)
    return _serialize_pharmacy_self(p)


# ----------------------------- categories -----------------------------
#
# The hard-coded preset list is gone. Categories live in `category_catalog`
# (a global, searchable pool seeded by the platform + grown organically as
# pharmacies add new ones via the AI publish flow). Pharmacies still keep
# a per-pharmacy `medicine_categories` row for each category they actually
# use, so existing storefront grouping/queries continue to work unchanged.


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    short_description: str | None = Field(default=None, max_length=280)
    sort_order: int = 0


class CategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    short_description: str | None = Field(default=None, max_length=280)
    sort_order: int | None = None


def _serialize_category(c: MedicineCategory) -> Dict[str, Any]:
    return {
        "id": str(c.id),
        "name": c.name,
        "short_description": c.short_description,
        "sort_order": c.sort_order,
    }


@router.get("/categories/presets")
async def list_preset_categories(
    q: str | None = Query(default=None, max_length=80),
    limit: int = Query(default=60, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Public: searchable global category catalogue (replaces the old
    hard-coded preset list). The pharmacy publish modal uses this for its
    typeahead picker; the admin/customer stores can also call it.

    Pass `q=` to fuzzy-match by name or group label. Empty `q` returns
    the top `limit` rows ordered by sort_order then name.
    """
    stmt = select(CategoryCatalog)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            (func.lower(CategoryCatalog.name).like(like))
            | (func.lower(CategoryCatalog.group_label).like(like))
        )
    stmt = stmt.order_by(CategoryCatalog.sort_order, CategoryCatalog.name).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    items = [
        {
            "name": c.name,
            "short_description": c.short_description,
            "group": c.group_label,
        }
        for c in rows
    ]
    return {"items": items}


@router.get("/me/categories")
async def list_my_categories(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_pharmacy(account)
    rows = (await db.execute(
        select(MedicineCategory)
        .where(MedicineCategory.pharmacy_id == p.id)
        .order_by(MedicineCategory.sort_order, MedicineCategory.name)
    )).scalars().all()
    return {"items": [_serialize_category(c) for c in rows]}


@router.post("/me/categories", status_code=201)
async def create_category(
    payload: CategoryIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    name = payload.name.strip()
    # If the name isn't already in the global catalogue, a short description
    # is mandatory so customers understand what the custom category contains.
    catalogue_hit = (await db.execute(
        select(CategoryCatalog).where(func.lower(CategoryCatalog.name) == name.lower())
    )).scalar_one_or_none()
    if not catalogue_hit and not (payload.short_description and payload.short_description.strip()):
        raise HTTPException(400, "Custom category needs a short description")
    existing = (await db.execute(
        select(MedicineCategory).where(
            MedicineCategory.pharmacy_id == p.id,
            func.lower(MedicineCategory.name) == name.lower(),
        )
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "Category already exists")
    c = MedicineCategory(
        pharmacy_id=p.id,
        name=name,
        short_description=(payload.short_description or "").strip() or None,
        sort_order=payload.sort_order,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return _serialize_category(c)


@router.patch("/me/categories/{cat_id}")
async def update_category(
    cat_id: UUID,
    payload: CategoryPatch,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    c = (await db.execute(
        select(MedicineCategory).where(
            MedicineCategory.id == cat_id, MedicineCategory.pharmacy_id == p.id
        )
    )).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "Category not found")
    data = payload.model_dump(exclude_unset=True)
    old_name = c.name
    for k, v in data.items():
        setattr(c, k, v)
    # If renamed, propagate to medicines so existing items stay grouped.
    if "name" in data and data["name"] and data["name"] != old_name:
        await db.execute(
            Medicine.__table__.update()
            .where(Medicine.pharmacy_id == p.id, Medicine.category == old_name)
            .values(category=data["name"])
        )
    await db.commit()
    await db.refresh(c)
    return _serialize_category(c)


@router.delete("/me/categories/{cat_id}", status_code=204)
async def delete_category(
    cat_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
):
    p = _require_operational_pharmacy(account)
    c = (await db.execute(
        select(MedicineCategory).where(
            MedicineCategory.id == cat_id, MedicineCategory.pharmacy_id == p.id
        )
    )).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "Category not found")
    # Block delete if it still has medicines — forces explicit move/delete.
    in_use = (await db.execute(
        select(func.count(Medicine.id)).where(
            Medicine.pharmacy_id == p.id, Medicine.category == c.name
        )
    )).scalar_one()
    if in_use:
        raise HTTPException(
            409, f"Category still has {in_use} medicine(s). Move or delete them first."
        )
    await db.delete(c)
    await db.commit()


async def _ensure_category(db: AsyncSession, pharmacy_id: UUID, name: str) -> None:
    """Auto-create a per-pharmacy `medicine_categories` row when a medicine
    references a new name. Looks up `category_catalog` for a starter
    short_description; if the name isn't in the catalogue yet, also
    inserts it there (organic growth) using a placeholder description.
    """
    name = name.strip()
    if not name:
        return
    existing = (await db.execute(
        select(MedicineCategory).where(
            MedicineCategory.pharmacy_id == pharmacy_id,
            func.lower(MedicineCategory.name) == name.lower(),
        )
    )).scalar_one_or_none()
    if existing:
        return
    catalogue_row = (await db.execute(
        select(CategoryCatalog).where(func.lower(CategoryCatalog.name) == name.lower())
    )).scalar_one_or_none()
    if catalogue_row is None:
        # Grow the global pool so future searches surface this name.
        catalogue_row = CategoryCatalog(
            name=name,
            short_description=None,
            group_label=None,
            sort_order=999,
            is_seed=False,
        )
        db.add(catalogue_row)
    db.add(MedicineCategory(
        pharmacy_id=pharmacy_id,
        name=name,
        short_description=catalogue_row.short_description,
    ))


async def _ensure_categories(
    db: AsyncSession, pharmacy_id: UUID, names: List[str]
) -> None:
    """Vectorised version of `_ensure_category` for multi-category meds.
    Also bumps `category_catalog.use_count` for each accepted bucket so the
    AI's ranking can prefer popular existing names over inventing new ones.
    """
    seen: set[str] = set()
    for raw in names:
        n = (raw or "").strip()
        if not n or n.lower() in seen:
            continue
        seen.add(n.lower())
        await _ensure_category(db, pharmacy_id, n)
        # Track popularity (best-effort — ignore failures).
        try:
            cat = (await db.execute(
                select(CategoryCatalog).where(func.lower(CategoryCatalog.name) == n.lower())
            )).scalar_one_or_none()
            if cat is not None:
                cat.use_count = (cat.use_count or 0) + 1
        except Exception:
            pass


# ----------------------------- medicines CRUD -----------------------------


class MedicineIn(BaseModel):
    """Publish payload. The pharmacy supplies ONLY image, name, price, stock
    (and optionally short_description + prescription_required). Category
    is no longer accepted from the client — the AI vision moderator picks
    one or more categories from the live catalogue (or invents a new one
    when nothing fits). short_description is auto-generated when blank.
    """
    name: str = Field(min_length=1, max_length=160)
    image_url: str = Field(min_length=4, max_length=600)
    short_description: str | None = Field(default=None, max_length=280)
    price: float = Field(ge=0)
    stock: int = Field(ge=0, default=0)
    is_active: bool = True
    prescription_required: bool = False


class MedicinePatch(BaseModel):
    name: str | None = None
    short_description: str | None = None
    image_url: str | None = None
    price: float | None = Field(default=None, ge=0)
    stock: int | None = Field(default=None, ge=0)
    is_active: bool | None = None
    prescription_required: bool | None = None


# Fields that, when changed by the pharmacy, should trigger an AI re-classify.
_CONTENT_FIELDS = ("name", "short_description", "image_url")


async def _catalogue_names(db: AsyncSession, limit: int = 80) -> List[str]:
    """Cheap name list passed to the vision prompt so the AI prefers
    existing categories over inventing new ones."""
    rows = (await db.execute(
        select(CategoryCatalog.name)
        .order_by(CategoryCatalog.sort_order, CategoryCatalog.name)
        .limit(limit)
    )).scalars().all()
    return list(rows)


async def _run_product_moderation(
    db: AsyncSession,
    m: Medicine,
    *,
    user_short_description: str | None,
) -> Dict[str, Any]:
    """Vision-classifies the medicine, writes the verdict back onto `m`,
    and returns the full AI result (so the caller can also act on the
    AI-generated short_description / suggested_categories / advice).

    Caller is responsible for the surrounding `commit()`.
    Always safe — on any failure leaves status="pending".
    """
    from app.api.routes.ai import vision_classify_product  # local to avoid cycle

    catalogue = await _catalogue_names(db)
    res = await vision_classify_product(
        image_url=m.image_url or "",
        name=m.name,
        short_description=user_short_description,
        category=None,
        catalog_names=catalogue,
    )
    m.approval_status = res["verdict"]
    m.approval_category = res["category"]
    m.approval_reason = res["reason"]
    m.approval_reviewed_at = datetime.now(timezone.utc)
    m.approval_reviewed_by_admin = False
    return res


async def _apply_ai_autofill(
    db: AsyncSession,
    m: Medicine,
    res: Dict[str, Any],
    *,
    user_short_description: str | None,
) -> None:
    """After moderation: if the pharmacy left short_description blank,
    fill it with the AI's generated text. Always overwrite the medicine's
    categories with the AI's full suggestion list (the AI is the sole
    authority on categorisation in this build).
    """
    # 1) Auto-fill blank short_description.
    if (not user_short_description or not user_short_description.strip()) and res.get("generated_short_description"):
        m.short_description = res["generated_short_description"]

    # 2) Replace categories with the AI's full set (1–3 entries). Falls back
    #    to a single "Uncategorized" bucket so the NOT-NULL `category`
    #    column always has a value.
    suggested = [str(c).strip() for c in (res.get("suggested_categories") or []) if str(c).strip()]
    if not suggested:
        suggested = [m.category or "Uncategorized"]
    m.category = suggested[0]
    m.categories_json = json.dumps(suggested, ensure_ascii=False)
    await _ensure_categories(db, m.pharmacy_id, suggested)

    # 3) If the pharmacy's metadata doesn't match what the AI sees, drop
    #    a Bengali advice into their inbox. (We still publish.)
    if res.get("verdict") == "approved" and not res.get("user_metadata_matches", True) and res.get("advice_bn"):
        payload = {
            "medicine_id": str(m.id),
            "medicine_name": m.name,
            "suggested_categories": suggested,
            "suggested_short_description": res.get("generated_short_description") or "",
        }
        db.add(AiNotification(
            pharmacy_id=m.pharmacy_id,
            kind="publish_advice",
            title=f"MediAI পরামর্শ — {m.name[:80]}",
            body_bn=res["advice_bn"],
            payload_json=json.dumps(payload, ensure_ascii=False),
        ))


@router.get("/me/medicines")
async def list_medicines(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_pharmacy(account)
    rows = (await db.execute(
        select(Medicine).where(Medicine.pharmacy_id == p.id).order_by(Medicine.category, Medicine.name)
    )).scalars().all()
    return {
        "items": [_serialize_medicine_admin(m) for m in rows],
        "total": len(rows),
    }


@router.post("/me/medicines", status_code=201)
async def create_medicine(
    payload: MedicineIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    # Image is mandatory — the vision moderator cannot work without it,
    # and the storefront looks bad with a missing thumbnail.
    if not payload.image_url or not payload.image_url.strip():
        raise HTTPException(400, "Product image অবশ্যই দিতে হবে — image upload করে publish করুন।")
    user_short = payload.short_description

    # Run vision moderation up-front — we need the AI's suggested category
    # before INSERT because medicines.category is NOT NULL.
    from app.api.routes.ai import vision_classify_product
    catalogue = await _catalogue_names(db)
    res = await vision_classify_product(
        image_url=payload.image_url,
        name=payload.name,
        short_description=user_short,
        category=None,
        catalog_names=catalogue,
    )

    suggested_raw = res.get("suggested_categories") or []
    suggested = [str(c).strip() for c in suggested_raw if str(c).strip()]
    if not suggested:
        suggested = ["Uncategorized"]
    final_short = (user_short or "").strip() or res.get("generated_short_description") or None

    await _ensure_categories(db, p.id, suggested)

    data = payload.model_dump()
    data["short_description"] = final_short
    data["category"] = suggested[0]
    data["categories_json"] = json.dumps(suggested, ensure_ascii=False)
    m = Medicine(pharmacy_id=p.id, **data)
    # Stamp moderation result onto the row.
    m.approval_status = res["verdict"]
    m.approval_category = res["category"]
    m.approval_reason = res["reason"]
    m.approval_reviewed_at = datetime.now(timezone.utc)
    m.approval_reviewed_by_admin = False
    db.add(m)
    await db.flush()

    # Post advice to MediAI inbox if the AI sees a metadata mismatch.
    if res.get("verdict") == "approved" and not res.get("user_metadata_matches", True) and res.get("advice_bn"):
        payload_json = {
            "medicine_id": str(m.id),
            "medicine_name": m.name,
            "suggested_categories": suggested,
            "suggested_short_description": res.get("generated_short_description") or "",
        }
        db.add(AiNotification(
            pharmacy_id=p.id,
            kind="publish_advice",
            title=f"MediAI পরামর্শ — {m.name[:80]}",
            body_bn=res["advice_bn"],
            payload_json=json.dumps(payload_json, ensure_ascii=False),
        ))

    await db.commit()
    await db.refresh(m)
    return _serialize_medicine_admin(m)


@router.patch("/me/medicines/{med_id}")
async def update_medicine(
    med_id: UUID,
    payload: MedicinePatch,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    m = (await db.execute(
        select(Medicine).where(Medicine.id == med_id, Medicine.pharmacy_id == p.id)
    )).scalar_one_or_none()
    if not m:
        raise HTTPException(404, "Medicine not found")
    data = payload.model_dump(exclude_unset=True)
    content_changed = any(
        k in data and data[k] != getattr(m, k, None) for k in _CONTENT_FIELDS
    )
    user_short = data.get("short_description", m.short_description) if "short_description" in data else None
    for k, v in data.items():
        setattr(m, k, v)
    # Block clearing the image on edit — image is required after publish too.
    if not m.image_url or not str(m.image_url).strip():
        raise HTTPException(400, "Product image অবশ্যই থাকতে হবে।")
    if content_changed:
        # Pharmacy edited name / short_description / image →
        # re-run vision moderation. (Stock / price / is_active /
        # prescription_required edits do NOT trigger re-review.)
        res = await _run_product_moderation(
            db, m,
            user_short_description=user_short,
        )
        await _apply_ai_autofill(
            db, m, res,
            user_short_description=user_short,
        )
    await db.commit()
    await db.refresh(m)
    return _serialize_medicine_admin(m)


@router.delete("/me/medicines/{med_id}", status_code=204)
async def delete_medicine(
    med_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
):
    p = _require_operational_pharmacy(account)
    m = (await db.execute(
        select(Medicine).where(Medicine.id == med_id, Medicine.pharmacy_id == p.id)
    )).scalar_one_or_none()
    if not m:
        raise HTTPException(404, "Medicine not found")
    await db.delete(m)
    await db.commit()
    return None


# ----------------------------- orders -----------------------------


@router.get("/me/orders")
async def list_orders(
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_pharmacy(account)
    stmt = (
        select(Order)
        .options(selectinload(Order.messages))
        .where(Order.pharmacy_id == p.id)
        .order_by(Order.created_at.desc())
        .limit(limit)
    )
    if status_filter:
        try:
            stmt = stmt.where(Order.status == OrderStatus(status_filter))
        except ValueError:
            raise HTTPException(400, "Invalid status filter")
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_serialize_order(o, include_messages=True) for o in rows]}


async def _get_owned_order(order_id: UUID, p: PharmacyProfile, db: AsyncSession) -> Order:
    o = (await db.execute(
        select(Order).options(selectinload(Order.messages))
        .where(Order.id == order_id, Order.pharmacy_id == p.id)
    )).scalar_one_or_none()
    if not o:
        raise HTTPException(404, "Order not found")
    return o


@router.post("/me/orders/{order_id}/confirm")
async def confirm_order(
    order_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    o = await _get_owned_order(order_id, p, db)
    if o.status != OrderStatus.pending:
        raise HTTPException(409, f"Cannot confirm order in status '{o.status.value}'")
    o.status = OrderStatus.confirmed
    db.add(OrderMessage(order_id=o.id, sender_role=SenderRole.pharmacy,
                        body="Order confirmed ✓ আমরা প্রস্তুত করতে শুরু করছি।",
                        preset_key="confirmed"))
    # Phase 4 — open the customer-side "modify window" (allowed only while
    # status==confirmed). The chat card lets the customer add/remove items
    # or change qty before the pharmacy starts packaging.
    if o.conversation_id:
        try:
            _items_now = json.loads(o.items_json or "[]")
            if not isinstance(_items_now, list):
                _items_now = []
        except Exception:
            _items_now = []
        # Normalize: Order.items_json uses `price`, but the modify-window
        # card (and all chat cards) read `unit_price`. Without this the
        # customer sees "৳0 × N" on every line item. (UI bug fix.)
        _items_norm = []
        for _it in _items_now:
            if not isinstance(_it, dict):
                continue
            _up = float(_it.get("unit_price", _it.get("price", 0)) or 0)
            _items_norm.append({**_it, "unit_price": _up, "price": _up})
        db.add(ConversationMessage(
            conversation_id=o.conversation_id,
            sender_role=SenderRole.system,
            body="✏️ Order modify window খোলা — pharmacy packaging শুরু করার আগ পর্যন্ত item add/qty change করা যাবে।",
            preset_key="ai_modify_window_open",
            payload_json=json.dumps({
                "order_id": str(o.id),
                "pharmacy_id": str(o.pharmacy_id),
                "items": _items_norm,
                "subtotal": float(o.subtotal or 0),
                "delivery_fee": float(o.delivery_fee or 0),
                "total": float(o.total or 0),
            }),
            visibility="all",
        ))
    if o.customer_account_id:
        await user_notify(
            db, o.customer_account_id,
            kind="order_status",
            title="Order confirmed ✓",
            body_bn=f"{p.pharmacy_name} আপনার order accept করেছে — প্রস্তুতি শুরু।",
            payload={"order_id": str(o.id), "status": "confirmed"},
        )
    await db.commit()
    await db.refresh(o)
    return _serialize_order(o, include_messages=True)


class RejectIn(BaseModel):
    reason: str | None = Field(default=None, max_length=280)


@router.post("/me/orders/{order_id}/reject")
async def reject_order(
    order_id: UUID,
    payload: RejectIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    o = await _get_owned_order(order_id, p, db)
    if o.status not in (OrderStatus.pending, OrderStatus.confirmed):
        raise HTTPException(409, f"Cannot reject order in status '{o.status.value}'")
    o.status = OrderStatus.rejected
    o.rejection_reason = payload.reason
    # Return any reserved stock to inventory (idempotent; no-op for chat orders).
    await restore_order_stock(db, o)
    db.add(OrderMessage(
        order_id=o.id, sender_role=SenderRole.pharmacy,
        body=f"দুঃখিত — order reject করা হয়েছে। {payload.reason or ''}".strip(),
        preset_key="rejected",
    ))
    if o.customer_account_id:
        await user_notify(
            db, o.customer_account_id,
            kind="order_status",
            title="Order rejected",
            body_bn=f"{p.pharmacy_name} আপনার order reject করেছে। {payload.reason or ''}".strip(),
            payload={"order_id": str(o.id), "status": "rejected"},
        )
    await db.commit()
    await db.refresh(o)
    return _serialize_order(o, include_messages=True)


class StatusIn(BaseModel):
    status: str


# Forward-only lifecycle ordering. Higher rank = later stage. Used to block
# backward status moves (e.g. delivered → packaging). rejected/cancelled are
# terminal and handled separately.
_STATUS_RANK: Dict[OrderStatus, int] = {
    OrderStatus.pending: 0,
    OrderStatus.confirmed: 1,
    OrderStatus.packaging: 2,
    OrderStatus.ready: 3,
    OrderStatus.dispatched: 4,
    OrderStatus.delivered: 5,
    OrderStatus.rejected: 5,
    OrderStatus.cancelled: 5,
}


@router.post("/me/orders/{order_id}/status")
async def set_order_status(
    order_id: UUID,
    payload: StatusIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    o = await _get_owned_order(order_id, p, db)
    try:
        target = OrderStatus(payload.status)
    except ValueError:
        raise HTTPException(400, "Invalid status")
    # Delivery is rider-only — a pharmacy can prepare (packaging) and finish
    # prep (ready), but only the rider who carried the medicine marks delivered.
    if target not in (OrderStatus.packaging, OrderStatus.ready):
        raise HTTPException(
            400,
            "Pharmacy শুধু packaging বা ready দিতে পারবে — delivered শুধু rider দেবে।",
        )
    # Forward-only: never move a finished order, and never step backward (this
    # stops repeat 'delivered 🎉' notifications and out-of-order packaging).
    if o.status in (OrderStatus.delivered, OrderStatus.rejected, OrderStatus.cancelled):
        raise HTTPException(409, f"Order already '{o.status.value}' — status can't change")
    if _STATUS_RANK[target] <= _STATUS_RANK[o.status]:
        raise HTTPException(
            409,
            f"Status backward নেওয়া যাবে না ('{o.status.value}' → '{target.value}')।",
        )
    o.status = target
    db.add(OrderMessage(
        order_id=o.id, sender_role=SenderRole.system,
        body={
            OrderStatus.packaging: "Packaging started 📦",
            OrderStatus.ready:     "Order ready ✅ — rider দরকার।",
            OrderStatus.delivered: "Delivered 🎉",
        }[target],
        preset_key=target.value,
    ))
    # Phase 4 — once packaging starts, the customer-side modify window closes.
    if target == OrderStatus.packaging and o.conversation_id:
        db.add(ConversationMessage(
            conversation_id=o.conversation_id,
            sender_role=SenderRole.system,
            body="🔒 Packaging শুরু — order এখন আর modify সম্ভব নয়।",
            preset_key="ai_modify_window_closed",
            payload_json=json.dumps({
                "order_id": str(o.id),
                "pharmacy_id": str(o.pharmacy_id),
            }),
            visibility="all",
        ))
    if o.customer_account_id:
        await user_notify(
            db, o.customer_account_id,
            kind="order_status",
            title={
                OrderStatus.packaging: "প্রস্তুতি শুরু",
                OrderStatus.ready:     "Order ready",
                OrderStatus.delivered: "Delivered 🎉",
            }[target],
            body_bn={
                OrderStatus.packaging: f"{p.pharmacy_name} আপনার order packaging শুরু করেছে।",
                OrderStatus.ready:     f"{p.pharmacy_name} আপনার order প্রস্তুত — rider খোঁজা হচ্ছে।",
                OrderStatus.delivered: f"{p.pharmacy_name} থেকে আপনার order পৌঁছেছে 🎉",
            }[target],
            payload={"order_id": str(o.id), "status": target.value},
        )
    await db.commit()
    await db.refresh(o)
    return _serialize_order(o, include_messages=True)


class MessageIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    preset_key: str | None = None


@router.post("/me/orders/{order_id}/messages")
async def post_message(
    order_id: UUID,
    payload: MessageIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_operational_pharmacy(account)
    o = await _get_owned_order(order_id, p, db)
    db.add(OrderMessage(
        order_id=o.id, sender_role=SenderRole.pharmacy,
        body=payload.body, preset_key=payload.preset_key,
    ))
    await db.commit()
    await db.refresh(o)
    return _serialize_order(o, include_messages=True)


@router.post("/me/orders/{order_id}/dispatch")
async def dispatch_order(
    order_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Broadcast a rider offer to every verified rider with a fresh location
    ping within RIDER_BROADCAST_RADIUS_KM (5 km) of the pharmacy — shared
    rules live in app/services/dispatch.py. Each rider sees order + payout."""
    p = _require_operational_pharmacy(account)
    if p.lat is None or p.lng is None:
        raise HTTPException(400, "Set pharmacy location before dispatching riders")
    o = await _get_owned_order(order_id, p, db)
    if o.status not in (OrderStatus.ready, OrderStatus.confirmed, OrderStatus.packaging):
        raise HTTPException(409, "Mark the order ready before dispatching riders")

    offers = await broadcast_rider_offers(db, o, p)

    o.status = OrderStatus.ready
    db.add(OrderMessage(
        order_id=o.id, sender_role=SenderRole.system,
        body=f"📣 {len(offers)} rider(s) notified within {RIDER_BROADCAST_RADIUS_KM:.0f} km.",
        preset_key="dispatched",
    ))
    await db.commit()
    return {"offers_sent": len(offers), "order": _serialize_order(o)}


# ----------------------------- analytics -----------------------------


@router.get("/me/analytics")
async def analytics(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_pharmacy(account)

    # Per-status counts.
    status_rows = (await db.execute(
        select(Order.status, func.count(Order.id), func.coalesce(func.sum(Order.total), 0.0))
        .where(Order.pharmacy_id == p.id)
        .group_by(Order.status)
    )).all()
    by_status: Dict[str, Dict[str, float]] = {
        s.value: {"count": 0, "total": 0.0} for s in OrderStatus
    }
    for st, count, total in status_rows:
        by_status[st.value] = {"count": int(count), "total": float(total or 0)}

    # Lifetime + this-month revenue (delivered only).
    lifetime_revenue = sum(v["total"] for k, v in by_status.items() if k == "delivered")
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month_total = (await db.execute(
        select(func.coalesce(func.sum(Order.total), 0.0))
        .where(
            Order.pharmacy_id == p.id,
            Order.status == OrderStatus.delivered,
            Order.created_at >= month_start,
        )
    )).scalar() or 0.0

    # Inventory snapshot.
    med_total = (await db.execute(
        select(func.count(Medicine.id)).where(Medicine.pharmacy_id == p.id)
    )).scalar() or 0
    med_active = (await db.execute(
        select(func.count(Medicine.id)).where(
            Medicine.pharmacy_id == p.id, Medicine.is_active.is_(True), Medicine.stock > 0
        )
    )).scalar() or 0

    # Top selling (by qty delivered).
    delivered = (await db.execute(
        select(Order.items_json).where(
            Order.pharmacy_id == p.id, Order.status == OrderStatus.delivered
        )
    )).scalars().all()
    sold: Dict[str, Dict[str, Any]] = {}
    for items_json in delivered:
        try:
            items = json.loads(items_json or "[]")
        except json.JSONDecodeError:
            continue
        for it in items:
            key = it.get("medicine_id") or it.get("name") or "unknown"
            cur = sold.setdefault(key, {"name": it.get("name", "—"), "qty": 0, "revenue": 0.0})
            qty = int(it.get("qty", 0) or 0)
            # items_json from chat orders uses `unit_price`; legacy direct
            # orders may use `price` — accept both for backward compat.
            unit_price = float(it.get("unit_price", it.get("price", 0)) or 0)
            cur["qty"] += qty
            cur["revenue"] += unit_price * qty
    top_products = sorted(sold.values(), key=lambda x: x["qty"], reverse=True)[:10]

    return {
        "by_status": by_status,
        "lifetime_revenue": round(lifetime_revenue, 0),
        "this_month_revenue": round(float(month_total), 0),
        "rejected_count": by_status["rejected"]["count"],
        "cancelled_count": by_status["cancelled"]["count"],
        "delivered_count": by_status["delivered"]["count"],
        "pending_count": by_status["pending"]["count"],
        "inventory_total": int(med_total),
        "inventory_active": int(med_active),
        "top_products": top_products,
        "since": account.created_at.isoformat() if account.created_at else None,
    }


# ----------------------------- public: customer rating -----------------------------


class PharmacyRateIn(BaseModel):
    stars: int = Field(ge=1, le=5)
    # Optional rider rating for the same delivered order (delivery is rider-only,
    # so a delivered order always has a rider to rate).
    rider_stars: int | None = Field(default=None, ge=1, le=5)


@router.post("/{pharmacy_id}/rate")
async def rate_pharmacy(
    pharmacy_id: UUID,
    payload: PharmacyRateIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Submit a 1-5 star rating for a pharmacy (and optionally the rider).

    Hardened against rating manipulation: only the **customer** who has a
    **delivered** order from this pharmacy can rate, and each delivered order
    can be rated **once** (tracked via `Order.pharmacy_rating`). This stops
    anyone from spamming 5★ on themselves or 1★ on competitors — important
    because the storefront ranks by rating.
    """
    if account.role != RoleEnum.customer:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "শুধু customer rating দিতে পারবে।")

    p = (await db.execute(
        select(PharmacyProfile).where(PharmacyProfile.id == pharmacy_id)
    )).scalar_one_or_none()
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pharmacy not found")

    # The customer must own a delivered, not-yet-rated order from this pharmacy.
    order = (await db.execute(
        select(Order).where(
            Order.customer_account_id == account.id,
            Order.pharmacy_id == pharmacy_id,
            Order.status == OrderStatus.delivered,
            Order.pharmacy_rating.is_(None),
        ).order_by(Order.created_at.desc()).limit(1)
    )).scalar_one_or_none()
    if order is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Rate দেওয়ার মতো delivered order নেই, অথবা এই order-এ already rate দিয়েছেন।",
        )

    # Running-average update for the pharmacy.
    n = max(0, p.rating_count or 0)
    cur = float(p.rating or 0.0)
    p.rating = round((cur * n + float(payload.stars)) / (n + 1), 2)
    p.rating_count = n + 1
    order.pharmacy_rating = int(payload.stars)

    # Optional rider rating for the same order's delivering rider.
    rider_rated = False
    if payload.rider_stars is not None and order.accepted_rider_id is not None:
        rp = (await db.execute(
            select(RiderProfile).where(RiderProfile.id == order.accepted_rider_id)
        )).scalar_one_or_none()
        if rp is not None:
            rn = max(0, rp.rating_count or 0)
            rcur = float(rp.rating or 0.0)
            rp.rating = round((rcur * rn + float(payload.rider_stars)) / (rn + 1), 2)
            rp.rating_count = rn + 1
            order.rider_rating = int(payload.rider_stars)
            rider_rated = True

    await db.commit()
    await db.refresh(p)
    return {
        "id": str(p.id),
        "rating": round(p.rating, 1),
        "rating_count": p.rating_count,
        "rider_rated": rider_rated,
    }



# ----------------------------- MediAI inbox / notifications -----------------------------
#
# A one-way feed of platform → pharmacy advice messages. Today the only
# producer is the publish flow (publish_advice when AI sees a metadata
# mismatch). Pharmacy reads via a bell dropdown in the dashboard navbar.


def _serialize_notification(n: AiNotification) -> Dict[str, Any]:
    payload = None
    if n.payload_json:
        try:
            payload = json.loads(n.payload_json)
        except (ValueError, TypeError):
            payload = None
    return {
        "id": str(n.id),
        "kind": n.kind,
        "title": n.title,
        "body_bn": n.body_bn,
        "payload": payload,
        "is_read": bool(n.is_read),
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


@router.get("/me/notifications")
async def list_my_notifications(
    limit: int = Query(default=30, ge=1, le=100),
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_pharmacy(account)
    rows = (await db.execute(
        select(AiNotification)
        .where(AiNotification.pharmacy_id == p.id)
        .order_by(AiNotification.created_at.desc())
        .limit(limit)
    )).scalars().all()
    unread = (await db.execute(
        select(func.count(AiNotification.id)).where(
            AiNotification.pharmacy_id == p.id,
            AiNotification.is_read == False,  # noqa: E712
        )
    )).scalar_one()
    return {
        "items": [_serialize_notification(n) for n in rows],
        "unread": int(unread or 0),
    }


@router.post("/me/notifications/{nid}/read")
async def mark_notification_read(
    nid: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_pharmacy(account)
    n = (await db.execute(
        select(AiNotification).where(
            AiNotification.id == nid, AiNotification.pharmacy_id == p.id
        )
    )).scalar_one_or_none()
    if n is None:
        raise HTTPException(404, "Notification not found")
    if not n.is_read:
        n.is_read = True
        await db.commit()
    return {"ok": True}


@router.post("/me/notifications/read-all")
async def mark_all_notifications_read(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    p = _require_pharmacy(account)
    await db.execute(
        AiNotification.__table__.update()
        .where(
            AiNotification.pharmacy_id == p.id,
            AiNotification.is_read == False,  # noqa: E712
        )
        .values(is_read=True)
    )
    await db.commit()
    return {"ok": True}
