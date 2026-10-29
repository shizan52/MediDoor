"""Shared rider-offer broadcast — ONE implementation for every dispatch
path (pharmacy "Call rider", chat `call_rider` preset, admin re-assign).

Previously three routes carried their own copy-pasted loop and they had
drifted apart (different radius constants, only one filtered verified
riders, none checked ping freshness). Central rules:

- only **verified** riders (unverified riders cannot accept anyway — the
  offer would be a dead notification);
- only riders whose last location ping is **fresh**
  (RIDER_LOCATION_FRESH_MINUTES) — no offers to phones that went offline;
- only riders within **RIDER_BROADCAST_RADIUS_KM** (5 km) of the pharmacy;
- payout = base + per_km × distance × 2 (round trip);
- every offered rider gets a `rider_offer` inbox notification.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order, OrderStatus, PharmacyProfile, RiderOffer, RiderProfile
from app.services.delivery import haversine_km
from app.services.geo_policy import (
    RIDER_BROADCAST_RADIUS_KM,
    rider_location_is_fresh,
)
from app.services.notify import notify as user_notify

# A rider coming online is offered any order still waiting for a rider from
# the last day; older `ready` rows are almost certainly abandoned and
# re-offering them would just spam.
BACKFILL_MAX_ORDER_AGE_HOURS = 24


async def broadcast_rider_offers(
    db: AsyncSession,
    order: Order,
    pharmacy: PharmacyProfile,
) -> List[RiderOffer]:
    """Create RiderOffer rows (added to the session, NOT committed) for every
    eligible rider around the pharmacy and notify each one. Returns the
    created offers; callers add their own system OrderMessage and commit."""
    if pharmacy.lat is None or pharmacy.lng is None:
        return []
    riders = (await db.execute(
        select(RiderProfile).where(RiderProfile.is_verified.is_(True))
    )).scalars().all()
    offers: List[RiderOffer] = []
    targets: List[RiderProfile] = []
    for r in riders:
        if r.last_lat is None or r.last_lng is None:
            continue
        if not rider_location_is_fresh(r.last_seen_at):
            continue
        d = haversine_km(pharmacy.lat, pharmacy.lng, r.last_lat, r.last_lng)
        if d > RIDER_BROADCAST_RADIUS_KM:
            continue
        payout = round(
            (pharmacy.delivery_base_fee or 0)
            + (pharmacy.delivery_per_km_fee or 0) * d * 2,
            0,
        )
        offer = RiderOffer(
            order_id=order.id,
            rider_id=r.id,
            payout_amount=payout,
            distance_km=round(d, 2),
        )
        db.add(offer)
        offers.append(offer)
        targets.append(r)
    if offers:
        # Flush so offer.id (python-side default fires at flush) is real
        # before it goes into the notification payload.
        await db.flush()
        for offer, r in zip(offers, targets):
            await user_notify(
                db, r.account_id,
                kind="rider_offer",
                title="নতুন delivery offer 🛵",
                body_bn=(
                    f"{pharmacy.pharmacy_name} থেকে নতুন offer — "
                    f"৳{int(offer.payout_amount)} · {offer.distance_km:.2f} km"
                ),
                payload={
                    "order_id": str(order.id),
                    "offer_id": str(offer.id),
                    "payout": offer.payout_amount,
                    "distance_km": offer.distance_km,
                },
            )
    return offers


async def backfill_offers_for_rider(
    db: AsyncSession,
    rider: RiderProfile,
) -> List[RiderOffer]:
    """Offer a rider who just came online every order still WAITING for a
    rider around them.

    `broadcast_rider_offers` is a one-shot at "Call rider" time — a rider
    whose ping was stale (or who was offline) at that moment never got an
    offer, and if NO rider was fresh the order stranded in `ready` forever
    with the pharmacy staring at "rider notified — waiting". This backfill
    runs on every rider location ping (added to the session, NOT committed;
    the caller commits) and closes that gap.
    """
    if rider.last_lat is None or rider.last_lng is None:
        return []
    cutoff = datetime.utcnow() - timedelta(hours=BACKFILL_MAX_ORDER_AGE_HOURS)
    rows = (await db.execute(
        select(Order, PharmacyProfile)
        .join(PharmacyProfile, PharmacyProfile.id == Order.pharmacy_id)
        .where(
            Order.status == OrderStatus.ready,
            Order.accepted_rider_id.is_(None),
            Order.created_at >= cutoff,
        )
    )).all()
    offers: List[RiderOffer] = []
    notify_args: List[tuple[Order, PharmacyProfile, RiderOffer]] = []
    for order, pharmacy in rows:
        if pharmacy.lat is None or pharmacy.lng is None:
            continue
        d = haversine_km(pharmacy.lat, pharmacy.lng, rider.last_lat, rider.last_lng)
        if d > RIDER_BROADCAST_RADIUS_KM:
            continue
        # Never duplicate: any prior offer row for this (order, rider) —
        # offered / rejected / expired — means the rider already had their
        # chance (or still has the live offer in their inbox).
        existing = (await db.execute(
            select(RiderOffer.id).where(
                RiderOffer.order_id == order.id,
                RiderOffer.rider_id == rider.id,
            ).limit(1)
        )).scalar_one_or_none()
        if existing is not None:
            continue
        payout = round(
            (pharmacy.delivery_base_fee or 0)
            + (pharmacy.delivery_per_km_fee or 0) * d * 2,
            0,
        )
        offer = RiderOffer(
            order_id=order.id,
            rider_id=rider.id,
            payout_amount=payout,
            distance_km=round(d, 2),
        )
        db.add(offer)
        offers.append(offer)
        notify_args.append((order, pharmacy, offer))
    if offers:
        await db.flush()
        for order, pharmacy, offer in notify_args:
            await user_notify(
                db, rider.account_id,
                kind="rider_offer",
                title="নতুন delivery offer 🛵",
                body_bn=(
                    f"{pharmacy.pharmacy_name} থেকে অপেক্ষমাণ offer — "
                    f"৳{int(offer.payout_amount)} · {offer.distance_km:.2f} km"
                ),
                payload={
                    "order_id": str(order.id),
                    "offer_id": str(offer.id),
                    "payout": offer.payout_amount,
                    "distance_km": offer.distance_km,
                },
            )
    return offers
