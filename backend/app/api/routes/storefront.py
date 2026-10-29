"""
Public storefront routes — no auth required. Browse pharmacies + medicines
within delivery radius. Used by the customer landing page.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_db
from app.api.routes.pharmacy import medicine_categories
from app.core.security import decode_token
from app.models import Account, RoleEnum
from app.models.category_catalog import CategoryCatalog
from app.models.user import Medicine, MedicineCategory, PharmacyProfile
from app.services.customer_policy import ensure_customer_not_banned
from app.services.delivery import delivery_fee_for_distance
from app.services.exposure import (
    PharmacyFeed, quality_score, rotation_rng, weighted_fair_feed,
)
from app.services.geo_policy import (
    CONNECT_RADIUS_KM,
    ensure_within_connect_radius,
    location_required_error,
)
from app.services.pharmacy_ops import is_open_now, parse_hours, tier_rules

# Customers may only browse pharmacies within this radius of their location
# (platform-wide 5 km connect rule — see app/services/geo_policy.py).
STOREFRONT_RADIUS_KM = CONNECT_RADIUS_KM

router = APIRouter(prefix="/api/storefront", tags=["storefront"])

EARTH_KM = 6371.0

# ---------------------------------------------------------------------------
# Bangla / English symptom → category synonym map.
# Used by the storefront search so customers can type natural-language
# queries like "মাথা ব্যথা" or "চোখ জ্বালা" and still see the right
# category of medicine.  Keys are normalised lowercase substrings; values
# are the canonical category names that should match.
# ---------------------------------------------------------------------------
SYMPTOM_SYNONYMS: dict[str, list[str]] = {
    # Pain & Fever
    "মাথা ব্যথা": ["Pain & Fever"],
    "মাথাব্যথা": ["Pain & Fever"],
    "মাথা ব্যাথা": ["Pain & Fever"],
    "জ্বর": ["Pain & Fever"],
    "ব্যথা": ["Pain & Fever"],
    "ব্যাথা": ["Pain & Fever"],
    "ফিভার": ["Pain & Fever"],
    "headache": ["Pain & Fever"],
    "fever": ["Pain & Fever"],
    "pain": ["Pain & Fever"],
    # Eye Care
    "চোখ": ["Eye Care"],
    "চোখ জ্বালা": ["Eye Care"],
    "চোখে জ্বালা": ["Eye Care"],
    "চোখের ড্রপ": ["Eye Care"],
    "চোখ লাল": ["Eye Care"],
    "eye": ["Eye Care"],
    "eye drop": ["Eye Care"],
    # Gastric
    "গ্যাস": ["Gastric"],
    "গ্যাসট্রিক": ["Gastric"],
    "পেট ব্যথা": ["Gastric", "Pain & Fever"],
    "পেটে ব্যথা": ["Gastric", "Pain & Fever"],
    "এসিডিটি": ["Gastric"],
    "অ্যাসিডিটি": ["Gastric"],
    "gas": ["Gastric"],
    "acidity": ["Gastric"],
    # Allergy
    "অ্যালার্জি": ["Allergy"],
    "এলার্জি": ["Allergy"],
    "allergy": ["Allergy"],
    "চুলকানি": ["Allergy"],
    # Vitamins
    "ভিটামিন": ["Vitamins"],
    "vitamin": ["Vitamins"],
    "ক্যালসিয়াম": ["Vitamins"],
    # Daily Essentials
    "মাস্ক": ["Daily Essentials"],
    "স্যানিটাইজার": ["Daily Essentials"],
    "ফার্স্ট এইড": ["Daily Essentials"],
    "mask": ["Daily Essentials"],
    "sanitizer": ["Daily Essentials"],
    # Sexual Wellness
    "কনডম": ["Sexual Wellness"],
    "condom": ["Sexual Wellness"],
}


def _resolve_symptom_categories(qs: str) -> set[str]:
    """Return canonical category names matched by a Bangla/English query."""
    q_lc = qs.strip().lower()
    if not q_lc:
        return set()
    matched: set[str] = set()
    for key, cats in SYMPTOM_SYNONYMS.items():
        if key in q_lc or q_lc in key:
            matched.update(cats)
    return matched


def _km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine distance in km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(a))


async def _optional_auth_account(authorization: str, db: AsyncSession) -> Account | None:
    if not authorization.lower().startswith("bearer "):
        return None
    payload = decode_token(authorization.split(" ", 1)[1].strip())
    if not payload or payload.get("type") != "access":
        return None
    try:
        account_id = UUID(str(payload.get("sub")))
    except Exception:
        return None
    return (
        await db.execute(
            select(Account)
            .where(Account.id == account_id)
            .options(selectinload(Account.customer))
        )
    ).scalar_one_or_none()


def _delivery_fee(p: PharmacyProfile, distance_km: float | None) -> float:
    # Flat 10 BDT/km from pharmacy to customer — same rule used at order time.
    return delivery_fee_for_distance(distance_km)


def _serialize_pharmacy(p: PharmacyProfile, distance_km: float | None) -> Dict[str, Any]:
    rules = tier_rules(p.subscription_tier)
    return {
        "id": str(p.id),
        "name": p.pharmacy_name,
        "business_name": p.business_name,
        "banner_photo_url": p.banner_photo_url,
        "address": p.address,
        "phone_number": p.phone_number,
        "rating": round(p.rating, 1),
        "rating_count": p.rating_count,
        "is_verified": p.is_verified,
        "verified_label": rules["badge"] if p.is_verified else None,
        "subscription_tier": p.subscription_tier,
        "is_open": is_open_now(p),
        "is_published": p.is_published,
        "opening_hours": parse_hours(p.opening_hours_json),
        "description": p.description,
        "lat": p.lat,
        "lng": p.lng,
        "distance_km": round(distance_km, 4) if distance_km is not None else None,
        "delivery_fee": _delivery_fee(p, distance_km),
    }


def _serialize_medicine(m: Medicine, p: PharmacyProfile, distance_km: float | None) -> Dict[str, Any]:
    rules = tier_rules(p.subscription_tier)
    cats = medicine_categories(m)
    return {
        "id": str(m.id),
        "name": m.name,
        "short_description": m.short_description,
        "category": m.category,
        "categories": cats,
        "image_url": m.image_url,
        "price": m.price,
        "stock": m.stock,
        "prescription_required": bool(getattr(m, "prescription_required", False)),
        "pharmacy": {
            "id": str(p.id),
            "name": p.pharmacy_name,
            "rating": round(p.rating, 1),
            "rating_count": p.rating_count,
            "is_verified": p.is_verified,
            "verified_label": rules["badge"] if p.is_verified else None,
            "subscription_tier": p.subscription_tier,
        },
        "distance_km": round(distance_km, 4) if distance_km is not None else None,
        "delivery_fee": _delivery_fee(p, distance_km),
    }


@router.get("/nearby")
async def storefront_nearby(
    lat: float | None = Query(None, ge=-90, le=90),
    lng: float | None = Query(None, ge=-180, le=180),
    radius_km: float = Query(CONNECT_RADIUS_KM, ge=0.5, le=50),
    q: str | None = Query(None, max_length=80),
    category: str | None = Query(None, max_length=80),
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """
    Returns medicines from active pharmacies within the fixed 5 km connect
    radius of the customer's location. Feed order comes from the tier exposure engine
    (app/services/exposure.py): impression share follows the subscription
    plan (A:B:C = 3:2:1, per-response caps 30/20/10), quality nudges order
    within a tier, and the rotation re-shuffles every 10 minutes.

    Location is **mandatory**: without lat/lng we can neither apply the radius
    nor compute the distance-based delivery fee, so we refuse to list anything.
    """
    if lat is None or lng is None:
        raise location_required_error()
    # Hard-cap the radius at the platform connect radius (5 km) regardless
    # of what the client asks for.
    radius_km = STOREFRONT_RADIUS_KM

    account = await _optional_auth_account(authorization, db)
    if account and account.role == RoleEnum.customer:
        ensure_customer_not_banned(account)

    stmt = (
        select(Medicine)
        .options(selectinload(Medicine.pharmacy))
        .where(
            Medicine.is_active.is_(True),
            Medicine.stock > 0,
            Medicine.approval_status == "approved",
        )
    )
    if q:
        qs = q.strip()
        like = f"%{qs}%"
        # Expand the query: match medicine name/desc OR category name OR
        # any pharmacy MedicineCategory name/short_description OR any
        # global CategoryCatalog short_description that matches the term.
        # Plus a Bangla/English symptom synonym map so natural-language
        # queries like "মাথা ব্যথা" resolve to the right category.
        cat_name_q = await db.execute(
            select(MedicineCategory.name).where(
                or_(
                    MedicineCategory.name.ilike(like),
                    MedicineCategory.short_description.ilike(like),
                )
            )
        )
        catalog_name_q = await db.execute(
            select(CategoryCatalog.name).where(
                or_(
                    CategoryCatalog.name.ilike(like),
                    CategoryCatalog.short_description.ilike(like),
                )
            )
        )
        matched_cats: set[str] = set()
        for (n,) in cat_name_q.all():
            if n:
                matched_cats.add(n.lower())
        for (n,) in catalog_name_q.all():
            if n:
                matched_cats.add(n.lower())
        # Symptom synonyms (Bangla + English).
        for c in _resolve_symptom_categories(qs):
            matched_cats.add(c.lower())

        clauses = [
            Medicine.name.ilike(like),
            Medicine.short_description.ilike(like),
            Medicine.category.ilike(like),
        ]
        if matched_cats:
            from sqlalchemy import func as _sqlfn
            clauses.append(_sqlfn.lower(Medicine.category).in_(list(matched_cats)))
            for c in matched_cats:
                clauses.append(Medicine.categories_json.ilike(f"%{c}%"))
        stmt = stmt.where(or_(*clauses))
    # Category filter: match either the primary `category` column OR a hit
    # inside the JSON-encoded `categories_json` (multi-category meds).
    # We do the JSON match in Python after fetch — the result-set is
    # already capped by radius + impressions.

    result = await db.execute(stmt)
    medicines = result.scalars().all()
    if category:
        cat_lc = category.strip().lower()
        medicines = [
            m for m in medicines
            if any(c.lower() == cat_lc for c in medicine_categories(m))
        ]

    # Group eligible medicines per pharmacy, then let the tier exposure
    # engine build the feed: slot share ∝ subscription tier (A:B:C = 3:2:1,
    # quality-nudged within tier) with the per-response impressions cap
    # (C=10 / B=20 / A=30) enforced inside the engine.
    grouped: Dict[UUID, Dict[str, Any]] = {}
    for m in medicines:
        p = m.pharmacy
        if p is None:
            continue
        if getattr(p, "is_blocked", False):
            continue
        if not p.is_published or not is_open_now(p):
            continue
        # Location is mandatory, so every shown pharmacy must have coordinates
        # and fall inside the 5 km connect radius — otherwise we can't bill delivery.
        if p.lat is None or p.lng is None:
            continue
        ent = grouped.get(p.id)
        if ent is None:
            distance = _km(lat, lng, p.lat, p.lng)
            ent = {"skip": distance > radius_km, "p": p, "distance": distance, "meds": []}
            grouped[p.id] = ent
        if ent["skip"]:
            continue
        ent["meds"].append(m)

    # Time-bucketed rotation (10 min): same neighbourhood + query sees a
    # stable feed within a bucket, and same-tier pharmacies (plus each
    # pharmacy's own catalogue face) take turns across buckets.
    rng = rotation_rng(f"{lat:.2f},{lng:.2f}", q or "", category or "")
    feeds: List[PharmacyFeed] = []
    pharmacy_ids: set[UUID] = set()
    for ent in grouped.values():
        if ent["skip"] or not ent["meds"]:
            continue
        p = ent["p"]
        meds = list(ent["meds"])
        rng.shuffle(meds)  # rotate which items represent this pharmacy
        feeds.append(PharmacyFeed(
            key=p.id,
            tier=p.subscription_tier,
            quality=quality_score(p.rating, p.rating_count, ent["distance"], radius_km),
            items=[_serialize_medicine(m, p, ent["distance"]) for m in meds],
        ))
        pharmacy_ids.add(p.id)
    sorted_items = weighted_fair_feed(feeds, rng=rng)

    # Distinct categories for the filter chip row — counted from the SAME
    # filtered set the customer actually sees (radius + open + published +
    # impression cap), enriched with short_description from MedicineCategory.
    # Each medicine is counted once per category it belongs to (multi-cat
    # meds bump every bucket they live in).
    cat_counts: Dict[str, int] = {}
    for it in sorted_items:
        for name in (it.get("categories") or []):
            if not name:
                continue
            cat_counts[name] = cat_counts.get(name, 0) + 1
    cat_names = list(cat_counts.keys())
    desc_map: Dict[str, str | None] = {}
    if cat_names:
        desc_q = await db.execute(
            select(MedicineCategory.name, MedicineCategory.short_description)
            .where(MedicineCategory.name.in_(cat_names))
        )
        for n, d in desc_q.all():
            if n not in desc_map or (d and not desc_map.get(n)):
                desc_map[n] = d
    categories = [
        {"name": name, "count": count, "short_description": desc_map.get(name)}
        for name, count in sorted(cat_counts.items(), key=lambda kv: kv[1], reverse=True)
    ]

    return {
        "items": sorted_items[:60],
        "total": len(sorted_items),
        "categories": categories,
        "pharmacy_count": len(pharmacy_ids),
        "radius_km": radius_km,
        "user_lat": lat,
        "user_lng": lng,
    }


@router.get("/pharmacy/{pharmacy_id}")
async def storefront_pharmacy(
    pharmacy_id: UUID,
    lat: float | None = Query(None, ge=-90, le=90),
    lng: float | None = Query(None, ge=-180, le=180),
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    account = await _optional_auth_account(authorization, db)
    if account and account.role == RoleEnum.customer:
        ensure_customer_not_banned(account)

    p = (await db.execute(
        select(PharmacyProfile)
        .options(
            selectinload(PharmacyProfile.medicines),
            selectinload(PharmacyProfile.categories),
        )
        .where(PharmacyProfile.id == pharmacy_id)
    )).scalar_one_or_none()
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pharmacy not found")
    if getattr(p, "is_blocked", False):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pharmacy not found")

    # 5 km connect gate — the storefront detail page is browsable only
    # inside the connect radius, and only with a real customer location
    # (400 location_required / 403 out_of_range). Closes the direct-URL
    # loophole that skipped the /nearby radius check.
    # Exemption: the pharmacy OWNER browsing their own storefront (the
    # quote/modify order composers) has no customer location to send —
    # their shop is by definition 0 km from itself.
    is_owner = bool(
        account
        and account.role == RoleEnum.pharmacy
        and p.account_id == account.id
    )
    distance = None if is_owner else ensure_within_connect_radius(lat, lng, p)

    medicines = [m for m in p.medicines if m.is_active and (
        getattr(m, "approval_status", "approved") or "approved"
    ) == "approved"]
    by_category: Dict[str, List[Dict[str, Any]]] = {}
    for m in medicines:
        item = _serialize_medicine(m, p, distance)
        for cname in medicine_categories(m):
            by_category.setdefault(cname, []).append(item)

    cat_meta = {c.name: c for c in p.categories}
    # Pharmacy-defined order: sort_order then name. Categories with items but
    # no row (legacy) get appended at the end, alphabetically.
    ordered_cats = sorted(
        p.categories, key=lambda c: (c.sort_order, c.name.lower())
    )
    cats_out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for c in ordered_cats:
        items = by_category.get(c.name, [])
        if not items:
            continue  # hide empty categories from customers
        cats_out.append({
            "name": c.name,
            "short_description": c.short_description,
            "items": items,
        })
        seen.add(c.name)
    for name in sorted(by_category.keys()):
        if name in seen:
            continue
        cats_out.append({
            "name": name,
            "short_description": None,
            "items": by_category[name],
        })

    return {
        "pharmacy": _serialize_pharmacy(p, distance),
        "categories": cats_out,
        "total_medicines": len(medicines),
    }
