"""Seed a single rider test account + a few delivered orders so the
Rider My Profile page has data to render. For UI screenshots only;
safe to wipe afterwards via tools/wipe_db.py."""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db.base import AsyncSessionLocal, Base, engine
from app.db.migrate import autopatch_sqlite
from app.models.user import (
    Account, RoleEnum, RiderProfile, PharmacyProfile, CustomerProfile,
)
from app.models.order import (
    Order, OrderStatus, RiderOffer, RiderOfferStatus,
)
from app.core.security import create_access_token, create_refresh_token


async def main():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await autopatch_sqlite(engine)

    async with AsyncSessionLocal() as db:
        # rider account
        gmail = "ui.rider@medidoor.app"
        existing = (await db.execute(select(Account).where(Account.gmail == gmail))).scalar_one_or_none()
        if existing:
            rider_acct = existing
        else:
            rider_acct = Account(
                id=uuid.uuid4(), gmail=gmail, google_sub="ui-rider",
                role=RoleEnum.rider, is_active=True, is_registered=True,
            )
            db.add(rider_acct)
            await db.flush()

        rider = (await db.execute(select(RiderProfile).where(RiderProfile.account_id == rider_acct.id))).scalar_one_or_none()
        if not rider:
            rider = RiderProfile(
                id=uuid.uuid4(), account_id=rider_acct.id,
                full_name="UI Test Rider", nick_name="Rifat",
                phone_number="+8801700000099",
                age=24, nid_number="UI-NID-001",
                is_verified=True, verification_status="verified",
                last_lat=22.7009, last_lng=90.3676,
                last_seen_at=datetime.now(timezone.utc),
            )
            db.add(rider)
            await db.flush()

        # pharmacy account (needed for FK on Order.pharmacy_id)
        pgmail = "ui.pharm@medidoor.app"
        pacct = (await db.execute(select(Account).where(Account.gmail == pgmail))).scalar_one_or_none()
        if not pacct:
            pacct = Account(id=uuid.uuid4(), gmail=pgmail, google_sub="ui-pharm",
                            role=RoleEnum.pharmacy, is_active=True, is_registered=True)
            db.add(pacct)
            await db.flush()
        pharm = (await db.execute(select(PharmacyProfile).where(PharmacyProfile.account_id == pacct.id))).scalar_one_or_none()
        if not pharm:
            pharm = PharmacyProfile(
                id=uuid.uuid4(), account_id=pacct.id,
                pharmacy_name="UI Pharmacy", owner_name="UI",
                business_name="UI Pharma", pharmacy_license_no="BD-UI-001",
                address="UI", phone_number="+8801700000098",
                lat=22.7009, lng=90.3676,
                delivery_base_fee=30, delivery_per_km_fee=12,
                is_published=True, subscription_tier="A",
                is_verified=True,
            )
            db.add(pharm)
            await db.flush()

        # delivered orders distributed across windows so all stat cards show data
        # times are: 6h ago (in 48h), 3 days ago (in week), 12 days ago (in month),
        # 100 days ago (in year), 400 days ago (lifetime only)
        now = datetime.now(timezone.utc)
        samples = [
            (timedelta(hours=6),   95.0,   1.5),
            (timedelta(hours=20),  80.0,   1.1),
            (timedelta(hours=44),  120.0,  2.4),
            (timedelta(days=3),    100.0,  1.8),
            (timedelta(days=12),   140.0,  2.9),
            (timedelta(days=100),  85.0,   1.2),
            (timedelta(days=400),  60.0,   0.8),
        ]
        for delta, payout, dist in samples:
            ts = now - delta
            o = Order(
                id=uuid.uuid4(),
                pharmacy_id=pharm.id, customer_account_id=None,
                customer_name="UI Cust", customer_phone="+8801700000097",
                delivery_address="UI Addr", delivery_lat=22.7, delivery_lng=90.36,
                items_json="[]", subtotal=payout * 5, delivery_fee=payout, total=payout * 6,
                status=OrderStatus.delivered, accepted_rider_id=rider.id,
                created_at=ts, updated_at=ts,
            )
            db.add(o)
            await db.flush()
            db.add(RiderOffer(
                id=uuid.uuid4(), order_id=o.id, rider_id=rider.id,
                payout_amount=payout, distance_km=dist,
                status=RiderOfferStatus.accepted,
                offered_at=ts, responded_at=ts,
            ))
        await db.commit()

        access = create_access_token(str(rider_acct.id), rider_acct.role.value)
        refresh = create_refresh_token(str(rider_acct.id), rider_acct.role.value)
        print("ACCESS=", access)
        print("REFRESH=", refresh)
        print("ACCOUNT_ID=", rider_acct.id)


if __name__ == "__main__":
    asyncio.run(main())
