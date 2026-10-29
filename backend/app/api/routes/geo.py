"""
Geo helpers — proxy Barikoi v2 APIs (server-side so the API key stays secret)
plus a few MediDoor-specific helpers (pharmacy markers + live rider tracking).

Endpoints
---------
GET  /api/geo/reverse                lat/lng → rich address (Barikoi v2, OSM
                                     second-chance) + human `label` (never
                                     raw coordinates)
GET  /api/geo/autocomplete           free-text place suggestions (Barikoi v2)
GET  /api/geo/route                  encoded polyline + distance + duration
GET  /api/geo/pharmacies             every published+open pharmacy with lat/lng
GET  /api/geo/track/{order_id}       rider's last known lat/lng for an order
                                     (only the pharmacy or the customer of
                                     that order may read it)
GET  /api/geo/me/location            role-aware saved location (customer last
                                     save / rider last ping / pharmacy shop)
POST /api/geo/me/location            save the caller's current location so a
                                     GPS-less device can reuse it later

If `BARIKOI_API_KEY` is missing we degrade gracefully so dev still works.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_account, get_db
from app.core.config import settings
from app.models import Account, Order, OrderStatus, PharmacyProfile, RiderProfile
from app.services.delivery import haversine_km
from app.services.geo_policy import CONNECT_RADIUS_KM
from app.services.pharmacy_ops import is_open_now, tier_rules

router = APIRouter(prefix="/api/geo", tags=["geo"])

BARIKOI_BASE = "https://barikoi.xyz/v2/api"
HTTP_TIMEOUT = 12.0

# Barikoi is a THIRD-PARTY dependency with a hard quota: once it starts
# answering 429 (rate limit / plan exhausted), every geo call used to bubble
# up as a 502 and the customer app showed a "Location service" error on every
# screen. Geo is an ENHANCEMENT, never a hard dependency — so an upstream
# failure now degrades to the same graceful fallback we already use when no
# API key is configured, and the app keeps working.
async def _barikoi_get(url: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """GET Barikoi and return parsed JSON, or None on ANY failure
    (network error, timeout, 429 quota, 4xx/5xx, malformed body)."""
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            resp = await client.get(url, params=params)
    except httpx.HTTPError:
        return None
    if resp.status_code >= 400:
        return None
    try:
        return resp.json() or {}
    except ValueError:
        return None


# Reverse-geocoding the same spot over and over is what burns the quota: every
# page load resolves the user's location. Cache by ~11 m grid (4 decimals) so
# repeat lookups are free. Small, bounded, per-process — no infra needed.
_REVERSE_CACHE: Dict[tuple[float, float], tuple[float, Dict[str, Any]]] = {}
_REVERSE_CACHE_TTL = 24 * 60 * 60.0
_REVERSE_CACHE_MAX = 500


def _reverse_cache_get(key: tuple[float, float]) -> Optional[Dict[str, Any]]:
    hit = _REVERSE_CACHE.get(key)
    if not hit:
        return None
    ts, value = hit
    if (time.time() - ts) > _REVERSE_CACHE_TTL:
        _REVERSE_CACHE.pop(key, None)
        return None
    return value


def _reverse_cache_put(key: tuple[float, float], value: Dict[str, Any]) -> None:
    if len(_REVERSE_CACHE) >= _REVERSE_CACHE_MAX:
        # Drop the oldest entry — plain FIFO is plenty for a 500-slot cache.
        oldest = min(_REVERSE_CACHE.items(), key=lambda kv: kv[1][0])[0]
        _REVERSE_CACHE.pop(oldest, None)
    _REVERSE_CACHE[key] = (time.time(), value)


# A "23.70123, 90.36789" style string is NOT an address. Users read those bare
# numbers as an IP address — every UI label must be a written place name.
_COORDS_RE = re.compile(r"^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$")

GENERIC_LOCATION_LABEL = "আপনার অবস্থান"


def _friendly_label(place: Dict[str, Any]) -> str:
    """Best human-readable one-liner for a reverse-geocode result.
    NEVER returns raw coordinates — degrades to a Bengali placeholder."""
    area_city = ", ".join(
        str(x) for x in (place.get("area"), place.get("city")) if x
    )
    for candidate in (place.get("address"), area_city, place.get("address_bn")):
        text = str(candidate or "").strip()
        if text and not _COORDS_RE.match(text):
            return text
    return GENERIC_LOCATION_LABEL


# --- OSM Nominatim second-chance -------------------------------------------
# Barikoi has a hard quota; when it 429s (or no key is configured) we used to
# fall straight to the coordinate fallback, so "Locate me" showed bare numbers
# instead of a road name. Nominatim is a free reverse geocoder — used ONLY as
# a second chance for /reverse, behind the same 24 h / ~11 m cache, so request
# volume stays tiny (their usage policy requires a proper User-Agent).
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
NOMINATIM_TIMEOUT = 6.0


async def _nominatim_reverse(lat: float, lng: float) -> Optional[Dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=NOMINATIM_TIMEOUT) as client:
            resp = await client.get(
                NOMINATIM_URL,
                params={
                    "lat": lat, "lon": lng,
                    "format": "jsonv2", "accept-language": "en,bn",
                },
                headers={"User-Agent": "MediDoor/1.0 (+https://medidoor.com.bd)"},
            )
    except httpx.HTTPError:
        return None
    if resp.status_code >= 400:
        return None
    try:
        data = resp.json() or {}
    except ValueError:
        return None
    addr = data.get("address") or {}
    if not addr and not data.get("display_name"):
        return None

    def pick(*keys: str) -> Optional[str]:
        for k in keys:
            v = addr.get(k)
            if v:
                return str(v)
        return None

    road = pick("road", "pedestrian", "footway", "path", "residential")
    area = pick("neighbourhood", "suburb", "quarter", "village", "hamlet")
    city = pick("city", "town", "municipality", "county")
    parts: List[str] = []
    for p in (road, area, city):
        if p and p not in parts:
            parts.append(p)
    if not parts:
        # display_name is very long ("road, area, upazila, district, division,
        # postcode, Bangladesh") — the first 3 segments read like an address.
        parts = [s.strip() for s in str(data.get("display_name") or "").split(",")[:3] if s.strip()]
    if not parts:
        return None
    return {
        "address": ", ".join(parts),
        "address_bn": None,
        "area": area,
        "area_bn": None,
        "city": city,
        "city_bn": None,
        "district": pick("state_district", "district"),
        "sub_district": pick("county", "suburb"),
        "post_code": pick("postcode"),
        "division": pick("state"),
        "country": pick("country") or "Bangladesh",
        "location_type": None,
        "lat": lat,
        "lng": lng,
        "source": "osm",
    }


# --------------------------------------------------------------------------- #
# Reverse geocode                                                             #
# --------------------------------------------------------------------------- #
@router.get("/reverse")
async def reverse_geocode(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
) -> Dict[str, Any]:
    """Pick the nearest known place for (lat, lng). Returns rich Bengali +
    English fields plus a ready-made `label` — the one string every UI should
    show for this location. `label` is ALWAYS a written place name (road /
    area / city); it is never raw coordinates.

    NEVER fails: Barikoi first; if it is unreachable / out of quota (429) or
    no key is configured, OSM Nominatim gets a second chance; only when both
    are unavailable do we return the generic-label fallback.
    """
    cache_key = (round(lat, 4), round(lng, 4))
    cached = _reverse_cache_get(cache_key)
    if cached is not None:
        return cached

    result: Optional[Dict[str, Any]] = None
    if settings.BARIKOI_API_KEY:
        url = f"{BARIKOI_BASE}/search/reverse/geocode"
        params = {
            "api_key": settings.BARIKOI_API_KEY,
            "longitude": lng,
            "latitude": lat,
            "district": "true",
            "post_code": "true",
            "country": "true",
            "sub_district": "true",
            "union": "true",
            "pauroshova": "true",
            "location_type": "true",
            "division": "true",
            "address": "true",
            "area": "true",
            "bangla": "true",
        }
        data = await _barikoi_get(url, params)
        place = (data or {}).get("place") or {}
        if place:
            result = {
                "address": place.get("address"),
                "address_bn": place.get("address_bn"),
                "area": place.get("area"),
                "area_bn": place.get("area_bn"),
                "city": place.get("city"),
                "city_bn": place.get("city_bn"),
                "district": place.get("district"),
                "sub_district": place.get("sub_district"),
                "post_code": place.get("postCode"),
                "division": place.get("division"),
                "country": place.get("country") or "Bangladesh",
                "location_type": place.get("location_type"),
                "lat": lat,
                "lng": lng,
                "source": "barikoi",
            }

    if result is None:
        # Barikoi missing / down / out of quota — OSM second chance so the
        # user still sees a real road name instead of the generic label.
        result = await _nominatim_reverse(lat, lng)

    if result is None:
        # Both geocoders unavailable — degrade, don't break the app. NOT
        # cached, so the next request can try the upstreams again.
        return _fallback_reverse(lat, lng)

    result["label"] = _friendly_label(result)
    _reverse_cache_put(cache_key, result)
    return result


def _fallback_reverse(lat: float, lng: float) -> Dict[str, Any]:
    # No coordinate strings here: bare "23.70, 90.36" text reads like an IP
    # address to users, and several UIs render `address` directly.
    return {
        "address": None,
        "address_bn": GENERIC_LOCATION_LABEL,
        "area": None,
        "city": None,
        "country": "Bangladesh",
        "label": GENERIC_LOCATION_LABEL,
        "lat": lat,
        "lng": lng,
        "source": "fallback",
    }


# --------------------------------------------------------------------------- #
# Autocomplete                                                                #
# --------------------------------------------------------------------------- #
@router.get("/autocomplete")
async def autocomplete(
    q: str = Query(..., min_length=1, max_length=120),
    city: Optional[str] = Query(None, max_length=60),
    limit: int = Query(8, ge=1, le=20),
) -> Dict[str, Any]:
    """Free-text place search powered by Barikoi v2."""
    if not settings.BARIKOI_API_KEY:
        return {"items": [], "source": "fallback"}

    url = f"{BARIKOI_BASE}/search/autocomplete/place"
    params: Dict[str, Any] = {
        "api_key": settings.BARIKOI_API_KEY,
        "q": q,
        "sub_area": "true",
        "sub_district": "true",
    }
    if city:
        params["city"] = city
    data = await _barikoi_get(url, params)
    if data is None:
        # Upstream down / quota exhausted — return no suggestions rather than
        # an error; the user can still type a free-text address.
        return {"items": [], "source": "fallback"}

    raw = data.get("places") or []
    items: List[Dict[str, Any]] = []
    for p in raw[:limit]:
        try:
            items.append({
                "id": p.get("id"),
                "address": p.get("address"),
                "area": p.get("area"),
                "city": p.get("city"),
                "district": p.get("district"),
                "sub_district": p.get("sub_district"),
                "sub_area": p.get("sub_area"),
                "post_code": p.get("postCode"),
                "type": p.get("pType"),
                "sub_type": p.get("subType"),
                "lat": float(p.get("latitude")) if p.get("latitude") is not None else None,
                "lng": float(p.get("longitude")) if p.get("longitude") is not None else None,
            })
        except (TypeError, ValueError):
            continue
    return {"items": items, "source": "barikoi"}


# --------------------------------------------------------------------------- #
# Route (polyline)                                                            #
# --------------------------------------------------------------------------- #
@router.get("/route")
async def route(
    from_lat: float = Query(..., ge=-90, le=90),
    from_lng: float = Query(..., ge=-180, le=180),
    to_lat: float = Query(..., ge=-90, le=90),
    to_lng: float = Query(..., ge=-180, le=180),
) -> Dict[str, Any]:
    """Driving route between two points. Returns encoded polyline so the
    frontend can decode + draw with one Leaflet/MapLibre call."""
    if not settings.BARIKOI_API_KEY:
        return {
            "geometry": None,
            "distance_m": None,
            "duration_s": None,
            "from": [from_lng, from_lat],
            "to": [to_lng, to_lat],
            "source": "fallback",
        }

    url = f"{BARIKOI_BASE}/route/{from_lng},{from_lat};{to_lng},{to_lat}"
    params = {"api_key": settings.BARIKOI_API_KEY, "geometries": "polyline"}
    data = await _barikoi_get(url, params)
    if data is None:
        # Upstream down / quota exhausted — no polyline; the map still renders
        # the pickup/drop markers and a straight-line hint.
        return {
            "geometry": None,
            "distance_m": None,
            "duration_s": None,
            "from": [from_lng, from_lat],
            "to": [to_lng, to_lat],
            "source": "fallback",
        }

    routes = data.get("routes") or []
    if not routes:
        return {
            "geometry": None,
            "distance_m": None,
            "duration_s": None,
            "from": [from_lng, from_lat],
            "to": [to_lng, to_lat],
            "source": "barikoi",
        }
    r0 = routes[0]
    return {
        "geometry": r0.get("geometry"),
        "distance_m": r0.get("distance"),
        "duration_s": r0.get("duration"),
        "from": [from_lng, from_lat],
        "to": [to_lng, to_lat],
        "source": "barikoi",
    }


# --------------------------------------------------------------------------- #
# Pharmacy markers                                                            #
# --------------------------------------------------------------------------- #
@router.get("/pharmacies")
async def pharmacy_markers(
    lat: float | None = Query(None, ge=-90, le=90),
    lng: float | None = Query(None, ge=-180, le=180),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Published pharmacies with coordinates — used to render markers on the
    customer landing map. Lightweight (no medicine join, no impressions cap).
    When the caller sends its location, pins are filtered to the platform
    5 km connect radius — customers only see the world they can order from."""
    rows = (await db.execute(
        select(PharmacyProfile).where(
            PharmacyProfile.is_published.is_(True),
            PharmacyProfile.lat.is_not(None),
            PharmacyProfile.lng.is_not(None),
        )
    )).scalars().all()
    if lat is not None and lng is not None:
        rows = [
            p for p in rows
            if haversine_km(lat, lng, p.lat, p.lng) <= CONNECT_RADIUS_KM
        ]
    items: List[Dict[str, Any]] = []
    for p in rows:
        items.append({
            "id": str(p.id),
            "name": p.pharmacy_name,
            "business_name": p.business_name,
            "address": p.address,
            "phone": p.phone_number,
            "lat": p.lat,
            "lng": p.lng,
            "rating": round(p.rating, 1),
            "rating_count": p.rating_count,
            "is_verified": p.is_verified,
            # Tier badge — the subscription cards promise a map badge
            # ("Verified" / "Verified Pro" / "Verified Pro+").
            "subscription_tier": p.subscription_tier,
            "verified_label": (
                tier_rules(p.subscription_tier)["badge"] if p.is_verified else None
            ),
            "is_open": is_open_now(p),
            "banner_photo_url": p.banner_photo_url,
        })
    return {"items": items, "total": len(items)}


# --------------------------------------------------------------------------- #
# Live rider tracking                                                         #
# --------------------------------------------------------------------------- #
@router.get("/track/{order_id}")
async def track_order(
    order_id: UUID,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Returns the latest known location of the rider assigned to this order,
    plus pharmacy + delivery coordinates so the caller can draw a route.

    Auth: only the pharmacy that owns the order, the customer who placed it,
    or the rider currently assigned can read this.
    """
    order = (await db.execute(
        select(Order).where(Order.id == order_id)
    )).scalar_one_or_none()
    if not order:
        raise HTTPException(404, "Order not found")
    pharmacy = (await db.execute(
        select(PharmacyProfile).where(PharmacyProfile.id == order.pharmacy_id)
    )).scalar_one_or_none()

    is_owner_customer = (
        order.customer_account_id is not None
        and order.customer_account_id == account.id
    )
    is_owner_pharmacy = (
        account.pharmacy is not None
        and account.pharmacy.id == order.pharmacy_id
    )
    is_assigned_rider = (
        account.rider is not None
        and order.accepted_rider_id == account.rider.id
    )
    if not (is_owner_customer or is_owner_pharmacy or is_assigned_rider):
        raise HTTPException(403, "Not allowed to track this order")

    # N5 — only share the rider's live GPS while the delivery is actually in
    # progress. Once the order is delivered / rejected / cancelled, stop
    # exposing the rider's location (they may now be on a different delivery).
    live_tracking = order.status not in (
        OrderStatus.delivered, OrderStatus.rejected, OrderStatus.cancelled,
    )

    rider_lat = rider_lng = None
    rider_seen_at: Optional[str] = None
    rider_name: Optional[str] = None
    if order.accepted_rider_id and live_tracking:
        rp = (await db.execute(
            select(RiderProfile).where(RiderProfile.id == order.accepted_rider_id)
        )).scalar_one_or_none()
        if rp:
            rider_lat = rp.last_lat
            rider_lng = rp.last_lng
            rider_seen_at = rp.last_seen_at.isoformat() if rp.last_seen_at else None
            rider_name = rp.nick_name or rp.full_name

    return {
        "order_id": str(order.id),
        "status": order.status.value,
        "pharmacy": {
            "id": str(pharmacy.id) if pharmacy else None,
            "name": pharmacy.pharmacy_name if pharmacy else None,
            "lat": pharmacy.lat if pharmacy else None,
            "lng": pharmacy.lng if pharmacy else None,
            "address": pharmacy.address if pharmacy else None,
            "banner_photo_url": pharmacy.banner_photo_url if pharmacy else None,
        },
        "customer": {
            "name": order.customer_name,
            "address": order.delivery_address,
            "lat": order.delivery_lat,
            "lng": order.delivery_lng,
        },
        "rider": {
            "name": rider_name,
            "lat": rider_lat,
            "lng": rider_lng,
            "last_seen_at": rider_seen_at,
        } if (order.accepted_rider_id and live_tracking) else None,
        "now": datetime.now(timezone.utc).isoformat(),
    }


# --------------------------------------------------------------------------- #
# Saved location (per account)                                                #
# --------------------------------------------------------------------------- #
# The platform promise: locate once from a GPS-capable device (the phone) and
# every other device shows that written location until a newer one replaces
# it. Role semantics differ on purpose:
#   customer — explicit snapshot columns on customer_profiles
#   rider    — their live-ping fields (last_lat/last_lng/last_seen_at); the
#              label is reverse-geocoded on read (cache keeps it cheap)
#   pharmacy — ALWAYS the stored shop location; a login fix must never move
#              the shop, so POST is a read-only no-op for pharmacies

MAX_SAVE_ACCURACY_M = 1000.0

NO_SAVED_LOCATION_MESSAGE = (
    "এখনো কোনো location save হয়নি। আপনার mobile দিয়ে login করে Locate me চাপুন — "
    "আমরা location নিয়ে নেব এবং সব জায়গায় দেখাব।"
)


class SaveLocationIn(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    accuracy_m: Optional[float] = Field(None, ge=0)


async def _reverse_label(lat: float, lng: float) -> str:
    geo = await reverse_geocode(lat=lat, lng=lng)
    return str(geo.get("label") or GENERIC_LOCATION_LABEL)


def _location_payload(
    role: str, lat: float, lng: float, label: str,
    updated_at: Optional[datetime], source: str,
) -> Dict[str, Any]:
    return {
        "role": role,
        "lat": lat,
        "lng": lng,
        "label": label,
        "updated_at": updated_at.isoformat() if updated_at else None,
        "source": source,
    }


@router.get("/me/location")
async def my_saved_location(
    account: Account = Depends(get_current_account),
) -> Dict[str, Any]:
    """Last known location for this account, with a written label — what a
    GPS-less device shows instead of asking the browser for a fix."""
    if account.customer is not None:
        prof = account.customer
        if prof.last_lat is not None and prof.last_lng is not None:
            label = prof.last_location_label or await _reverse_label(prof.last_lat, prof.last_lng)
            return _location_payload(
                "customer", prof.last_lat, prof.last_lng, label,
                prof.last_location_at, "saved",
            )
    elif account.rider is not None:
        rp = account.rider
        if rp.last_lat is not None and rp.last_lng is not None:
            label = await _reverse_label(rp.last_lat, rp.last_lng)
            return _location_payload(
                "rider", rp.last_lat, rp.last_lng, label, rp.last_seen_at, "ping",
            )
    elif account.pharmacy is not None:
        p = account.pharmacy
        if p.lat is not None and p.lng is not None:
            label = (p.address or "").strip()
            if not label or _COORDS_RE.match(label):
                label = await _reverse_label(p.lat, p.lng)
            return _location_payload("pharmacy", p.lat, p.lng, label, None, "shop")
    raise HTTPException(
        status.HTTP_404_NOT_FOUND,
        detail={"code": "no_saved_location", "message": NO_SAVED_LOCATION_MESSAGE},
    )


@router.post("/me/location")
async def save_my_location(
    payload: SaveLocationIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Persist the caller's current device fix as their platform location.
    Coarse (IP/Wi-Fi) fixes are refused — a saved location must be real."""
    if payload.accuracy_m is not None and payload.accuracy_m > MAX_SAVE_ACCURACY_M:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "gps_accuracy_poor",
                "message": (
                    "এই device থেকে সঠিক location পাওয়া যায়নি। আপনার mobile দিয়ে "
                    "login করে আবার চেষ্টা করুন।"
                ),
            },
        )
    now = datetime.now(timezone.utc)

    if account.customer is not None:
        prof = account.customer
        label = await _reverse_label(payload.lat, payload.lng)
        prof.last_lat = payload.lat
        prof.last_lng = payload.lng
        prof.last_location_label = label
        prof.last_location_at = now
        await db.commit()
        return _location_payload("customer", payload.lat, payload.lng, label, now, "saved")

    if account.rider is not None:
        # Same fields the ping loop writes. Broadcast eligibility still
        # requires is_verified + freshness — saving here grants nothing.
        rp = account.rider
        rp.last_lat = payload.lat
        rp.last_lng = payload.lng
        rp.last_seen_at = now
        await db.commit()
        label = await _reverse_label(payload.lat, payload.lng)
        return _location_payload("rider", payload.lat, payload.lng, label, now, "ping")

    if account.pharmacy is not None:
        # Shop coordinates change ONLY via the deliberate profile-edit /
        # in-shop locate flow — never from a login fix on some device.
        p = account.pharmacy
        if p.lat is not None and p.lng is not None:
            label = (p.address or "").strip()
            if not label or _COORDS_RE.match(label):
                label = await _reverse_label(p.lat, p.lng)
            return _location_payload("pharmacy", p.lat, p.lng, label, None, "shop")
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"code": "no_saved_location", "message": NO_SAVED_LOCATION_MESSAGE},
        )

    raise HTTPException(
        status.HTTP_400_BAD_REQUEST,
        detail={"code": "not_registered", "message": "আগে registration শেষ করুন।"},
    )
