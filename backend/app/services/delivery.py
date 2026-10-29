"""Single source of truth for delivery-fee calculation.

Product policy: the delivery charge is a flat **10 BDT per kilometre** of the
straight-line distance from the pharmacy to the customer's delivery address.
It applies everywhere the same way — on the storefront (home page) while
browsing AND at order time, with or without login — so the fee a customer
sees while browsing always matches the fee actually charged.
"""
from __future__ import annotations

import math

# Flat per-kilometre delivery rate, in BDT.
DELIVERY_FEE_PER_KM = 10.0

EARTH_KM = 6371.0


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two lat/lng points, in kilometres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(a))


def delivery_fee_for_distance(distance_km: float | None) -> float:
    """Delivery fee (whole BDT) for a pharmacy->customer distance.

    Returns 0 when the distance is unknown. Callers that actually charge a fee
    must always pass a real distance — location is mandatory both for browsing
    and for placing an order.
    """
    if distance_km is None:
        return 0.0
    return round(DELIVERY_FEE_PER_KM * max(0.0, distance_km), 0)
