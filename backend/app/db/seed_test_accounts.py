"""
Seed two ready-to-use accounts for end-to-end testing. Idempotent.

  - test.customer@medidoor.app   (customer, fully registered, with a
    placeholder profile photo so the navbar avatar shows up).
  - test.pharmacy@medidoor.app   (pharmacy, fully registered, published,
    located at Banani circle, with a banner photo + 5 medicines so the
    storefront and chat-first ordering can be exercised end-to-end).

Usage:
    python -m app.db.seed_test_accounts
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

from sqlalchemy import select

from app.db.base import AsyncSessionLocal, Base, engine
from app.db.migrate import autopatch_sqlite
from app.models.user import (
    Account,
    CustomerProfile,
    Medicine,
    MedicineCategory,
    PharmacyProfile,
    RiderProfile,
    RoleEnum,
)

CUSTOMER_GMAIL = "test.customer@medidoor.app"
PHARMACY_GMAIL = "test.pharmacy@medidoor.app"
RIDER_GMAIL = "test.rider@medidoor.app"
PHARMACY_LICENSE = "BD-PH-TEST-001"
RIDER_NID = "BD-NID-TEST-001"

# All test users live near Barishal (22.7009, 90.3676) so the 5 km
# rider broadcast and 5 km customer storefront can be exercised.
TEST_LAT = 22.7009
TEST_LNG = 90.3676

PHOTO_AVATAR = "https://i.pravatar.cc/200?img=14"
PHOTO_BANNER = (
    "https://images.unsplash.com/photo-1631549916768-4119b2e5f926?w=1600"
)

# 24/7 hours so storefront/nearby never filters the test pharmacy out
# because of clock-of-day in the test environment.
import json as _json
ALWAYS_OPEN_HOURS_JSON = _json.dumps(
    {
        d: {"open": "00:00", "close": "23:59", "closed": False}
        for d in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
    }
)

CATEGORIES: dict[str, str] = {
    "Pain & Fever": "Paracetamol, NSAIDs, fever reducers",
    "Gastric": "Antacids, PPI, gas & ulcer medicines",
    "Allergy": "Antihistamines & allergy relief",
    "Vitamins": "Multivitamins & supplements",
    "Daily Essentials": "Masks, hand sanitizer, first aid",
}

MEDICINES: list[dict[str, Any]] = [
    {
        "name": "Napa 500mg",
        "short_description": "প্যারাসিটামল 500mg, জ্বর ও ব্যথায়",
        "category": "Pain & Fever",
        "image_url": "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=480",
        "price": 1.20,
        "stock": 240,
    },
    {
        "name": "Seclo 20mg",
        "short_description": "Omeprazole — গ্যাস্ট্রিকে",
        "category": "Gastric",
        "image_url": "https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=480",
        "price": 5.00,
        "stock": 180,
    },
    {
        "name": "Histacin",
        "short_description": "Antihistamine — অ্যালার্জিতে",
        "category": "Allergy",
        "image_url": "https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=480",
        "price": 1.50,
        "stock": 320,
    },
    {
        "name": "Vitamin D3 40000 IU",
        "short_description": "সাপ্তাহিক ডোজ, হাড়ের যত্নে",
        "category": "Vitamins",
        "image_url": "https://images.unsplash.com/photo-1559757175-5700dde675bc?w=480",
        "price": 25.00,
        "stock": 90,
    },
    {
        "name": "ORS Saline",
        "short_description": "ডায়রিয়া ও পানিশূন্যতায়",
        "category": "Daily Essentials",
        "image_url": "https://images.unsplash.com/photo-1550572017-9f2f48b87a05?w=480",
        "price": 6.00,
        "stock": 500,
    },
]


async def _ensure_account(db, gmail: str, role: RoleEnum) -> Account:
    existing = (
        await db.execute(select(Account).where(Account.gmail == gmail))
    ).scalar_one_or_none()
    if existing:
        return existing
    acct = Account(
        id=uuid.uuid4(),
        gmail=gmail,
        google_sub=f"dev-{gmail}",
        role=role,
        is_active=True,
        is_registered=True,
    )
    db.add(acct)
    await db.flush()
    return acct


async def main() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await autopatch_sqlite(engine)

    async with AsyncSessionLocal() as db:
        # ---------- Customer ----------
        cust_acct = await _ensure_account(db, CUSTOMER_GMAIL, RoleEnum.customer)
        cust_acct.is_registered = True
        cust_profile = (
            await db.execute(
                select(CustomerProfile).where(CustomerProfile.account_id == cust_acct.id)
            )
        ).scalar_one_or_none()
        if cust_profile is None:
            cust_profile = CustomerProfile(
                id=uuid.uuid4(),
                account_id=cust_acct.id,
                first_name="Test",
                last_name="Customer",
                phone_number="+8801700000001",
                date_of_birth=None,
                gender="other",
                profile_photo_url=PHOTO_AVATAR,
            )
            db.add(cust_profile)
        else:
            cust_profile.first_name = cust_profile.first_name or "Test"
            cust_profile.last_name = cust_profile.last_name or "Customer"
            cust_profile.phone_number = cust_profile.phone_number or "+8801700000001"
            cust_profile.profile_photo_url = (
                cust_profile.profile_photo_url or PHOTO_AVATAR
            )

        # ---------- Pharmacy ----------
        pharm_acct = await _ensure_account(db, PHARMACY_GMAIL, RoleEnum.pharmacy)
        pharm_acct.is_registered = True
        pharm = (
            await db.execute(
                select(PharmacyProfile).where(PharmacyProfile.account_id == pharm_acct.id)
            )
        ).scalar_one_or_none()
        if pharm is None:
            pharm = PharmacyProfile(
                id=uuid.uuid4(),
                account_id=pharm_acct.id,
                pharmacy_name="Test Pharmacy",
                owner_name="Test Owner",
                business_name="Test Pharma Ltd.",
                pharmacy_license_no=PHARMACY_LICENSE,
                pharmacy_license_doc_url=None,
                pharmacist_name="Test Pharmacist",
                pharmacist_reg_no="B-99999",
                banner_photo_url=PHOTO_BANNER,
                address="Test Pharmacy Address",
                phone_number="+8801700000002",
                lat=TEST_LAT,
                lng=TEST_LNG,
                rating=0.0,
                rating_count=0,
                delivery_base_fee=30,
                delivery_per_km_fee=12,
                is_verified=True,
                is_published=True,
                subscription_tier="A",
                verification_status="verified",
                verification_message="Seeded test pharmacy — DGDA যাচাই এড়ানো হয়েছে।",
                # 24/7 hours so end-to-end tests work at any wall-clock time.
                opening_hours_json=ALWAYS_OPEN_HOURS_JSON,
            )
            db.add(pharm)
            await db.flush()
        else:
            pharm.banner_photo_url = pharm.banner_photo_url or PHOTO_BANNER
            pharm.is_published = True
            pharm.is_verified = True
            pharm.verification_status = "verified"
            pharm.verification_message = (
                "Seeded test pharmacy — DGDA যাচাই এড়ানো হয়েছে।"
            )
            pharm.pharmacist_name = pharm.pharmacist_name or "Test Pharmacist"
            pharm.pharmacist_reg_no = pharm.pharmacist_reg_no or "B-99999"
            # Always pin test pharmacy to the configured test coords so rider
            # broadcast (5 km) works deterministically.
            pharm.lat = TEST_LAT
            pharm.lng = TEST_LNG
            pharm.subscription_tier = pharm.subscription_tier or "A"
            # Force 24/7 hours so storefront/nearby never filters this row out
            # because of clock-of-day in the test environment.
            pharm.opening_hours_json = ALWAYS_OPEN_HOURS_JSON
            pharm.closed_until = None

        # Categories
        existing_cats = {
            c.name: c
            for c in (
                await db.execute(
                    select(MedicineCategory).where(
                        MedicineCategory.pharmacy_id == pharm.id
                    )
                )
            ).scalars().all()
        }
        for idx, (cname, desc) in enumerate(CATEGORIES.items()):
            if cname in existing_cats:
                continue
            db.add(MedicineCategory(
                id=uuid.uuid4(),
                pharmacy_id=pharm.id,
                name=cname,
                short_description=desc,
                sort_order=idx,
            ))

        # Medicines
        existing_meds = {
            m.name
            for m in (
                await db.execute(
                    select(Medicine).where(Medicine.pharmacy_id == pharm.id)
                )
            ).scalars().all()
        }
        for m in MEDICINES:
            if m["name"] in existing_meds:
                continue
            db.add(Medicine(
                id=uuid.uuid4(),
                pharmacy_id=pharm.id,
                name=m["name"],
                short_description=m["short_description"],
                description=m["short_description"],
                category=m["category"],
                image_url=m["image_url"],
                price=m["price"],
                stock=m["stock"],
                is_active=True,
            ))

        # ---------- Rider ----------
        rider_acct = await _ensure_account(db, RIDER_GMAIL, RoleEnum.rider)
        rider_acct.is_registered = True
        rider = (
            await db.execute(
                select(RiderProfile).where(RiderProfile.account_id == rider_acct.id)
            )
        ).scalar_one_or_none()
        if rider is None:
            rider = RiderProfile(
                id=uuid.uuid4(),
                account_id=rider_acct.id,
                full_name="Test Rider",
                nick_name="Speedy",
                phone_number="+8801700000003",
                age=28,
                nid_number=RIDER_NID,
                nid_front_url=None,
                nid_back_url=None,
                profile_photo_url=PHOTO_AVATAR,
                is_verified=True,
                verification_status="verified",
                last_lat=TEST_LAT,
                last_lng=TEST_LNG,
            )
            db.add(rider)
        else:
            rider.is_verified = True
            rider.verification_status = "verified"
            rider.last_lat = TEST_LAT
            rider.last_lng = TEST_LNG
            rider.profile_photo_url = rider.profile_photo_url or PHOTO_AVATAR

        await db.commit()

    print(
        f"OK — customer={CUSTOMER_GMAIL} pharmacy={PHARMACY_GMAIL} "
        f"rider={RIDER_GMAIL} (license {PHARMACY_LICENSE})"
    )


if __name__ == "__main__":
    asyncio.run(main())
