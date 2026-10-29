"""Platform location policy — the ONE place that defines how far apart two
parties may be and still "connect" on MediDoor.

Rules (product spec):
- Customers and riders always operate within **5 km** of their own live
  location: browsing, searching, chatting-to-order, ordering, prescription
  proposals and rider offers are all gated by this radius.
- A pharmacy's location is its **shop location** stored on the profile —
  never a device GPS fix. It only changes through the in-platform profile
  edit (PATCH /api/pharmacy/me lat/lng). All distance checks run against
  those stored coordinates.
- Location is mandatory: an endpoint that needs the caller's location and
  doesn't get one answers `400 {"code": "location_required"}` so the client
  can tell the user to sign in from a GPS-capable device.

Every radius/freshness constant and gate lives here so no route can drift
out of sync with the policy.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status

from app.models import PharmacyProfile
from app.services.delivery import haversine_km

# Customers/riders connect to pharmacies within this many km of themselves.
CONNECT_RADIUS_KM = 5.0

# Rider offers broadcast to every eligible rider within this many km of the
# pharmacy (same 5 km "connect" rule, rider side).
RIDER_BROADCAST_RADIUS_KM = CONNECT_RADIUS_KM

# A rider's last ping must be at most this old to receive new offers —
# otherwise we'd offer deliveries to phones that went offline hours ago.
RIDER_LOCATION_FRESH_MINUTES = 15

LOCATION_REQUIRED_MESSAGE = (
    "Location ছাড়া MediDoor ব্যবহার করা যাবে না। অনুগ্রহ করে location "
    "permission দিন — GPS না থাকলে mobile বা GPS-সহ device দিয়ে login করুন।"
)

OUT_OF_RANGE_MESSAGE = (
    "এই pharmacy আপনার {radius:.0f} km-এর বাইরে। MediDoor-এ আপনি আপনার "
    "আশেপাশের {radius:.0f} km-এর মধ্যেই pharmacy-র সাথে connect হতে পারবেন।"
)


def location_required_error() -> HTTPException:
    return HTTPException(
        status.HTTP_400_BAD_REQUEST,
        detail={"code": "location_required", "message": LOCATION_REQUIRED_MESSAGE},
    )


def out_of_range_error(distance_km: float | None = None) -> HTTPException:
    detail = {
        "code": "out_of_range",
        "message": OUT_OF_RANGE_MESSAGE.format(radius=CONNECT_RADIUS_KM),
        "radius_km": CONNECT_RADIUS_KM,
    }
    if distance_km is not None:
        detail["distance_km"] = round(distance_km, 2)
    return HTTPException(status.HTTP_403_FORBIDDEN, detail=detail)


def ensure_within_connect_radius(
    lat: float | None,
    lng: float | None,
    pharmacy: PharmacyProfile,
    *,
    require_location: bool = True,
) -> float | None:
    """Gate: the given customer/delivery point must be within
    CONNECT_RADIUS_KM of the pharmacy's stored shop location.

    Returns the distance in km (None only when coords are missing and
    `require_location=False`). Raises:
      - 400 location_required  — coords missing and required
      - 403 out_of_range       — point is beyond the connect radius
    A pharmacy without stored coordinates cannot be distance-checked; it is
    treated as out of range (it also can't be priced for delivery).
    """
    if lat is None or lng is None:
        if require_location:
            raise location_required_error()
        return None
    if pharmacy.lat is None or pharmacy.lng is None:
        raise out_of_range_error()
    d = haversine_km(lat, lng, pharmacy.lat, pharmacy.lng)
    if d > CONNECT_RADIUS_KM:
        raise out_of_range_error(d)
    return d


def rider_location_is_fresh(
    last_seen_at: datetime | None, *, now: datetime | None = None
) -> bool:
    """True iff the rider pinged within RIDER_LOCATION_FRESH_MINUTES."""
    if last_seen_at is None:
        return False
    ts = last_seen_at
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    ref = now or datetime.now(timezone.utc)
    return (ref - ts) <= timedelta(minutes=RIDER_LOCATION_FRESH_MINUTES)
