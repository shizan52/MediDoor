"""
Seed demo pharmacies + medicines so the customer landing page has content
to show even before any real pharmacy registers.

Idempotent — only inserts rows that don't already exist (matches by license #
for pharmacies and (pharmacy_id, name) for medicines).

Usage:
    python -m app.db.seed
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
    Medicine,
    MedicineCategory,
    PharmacyProfile,
    RoleEnum,
)

# Short-descriptions used when seeding categories so the storefront shows
# meaningful subtitles right out of the box.
CATEGORY_DESCRIPTIONS: dict[str, str] = {
    "Pain & Fever":      "Paracetamol, NSAIDs, fever reducers",
    "Gastric":           "Antacids, PPI, gas & ulcer medicines",
    "Allergy":           "Antihistamines & allergy relief",
    "Antibiotic":        "Prescription antibiotics",
    "Vitamins":          "Multivitamins & supplements",
    "Devices":           "BP machines, thermometers, glucometers",
    "Daily Essentials":  "Masks, hand sanitizer, first aid",
}

# Centered roughly on Dhaka (Banani area). All within ~3 km of one another.
DEMO_PHARMACIES: list[dict[str, Any]] = [
    {
        "gmail": "demo+greencare@medidoor.app",
        "google_sub": "demo-greencare",
        "license": "BD-PH-DEMO-001",
        "pharmacy_name": "GreenCare Pharmacy",
        "owner_name": "Anika Rahman",
        "business_name": "GreenCare Pharma Ltd.",
        "address": "House 12, Road 7, Banani, Dhaka",
        "phone_number": "+8801711000001",
        "lat": 23.7937,
        "lng": 90.4066,
        "rating": 4.6,
        "rating_count": 312,
        "delivery_base_fee": 30,
        "delivery_per_km_fee": 12,
        "is_verified": True,
    },
    {
        "gmail": "demo+lazz@medidoor.app",
        "google_sub": "demo-lazz",
        "license": "BD-PH-DEMO-002",
        "pharmacy_name": "Lazz 24×7 Pharmacy",
        "owner_name": "Sakib Hossain",
        "business_name": "Lazz Pharma",
        "address": "Gulshan 2 Circle, Dhaka",
        "phone_number": "+8801711000002",
        "lat": 23.7932,
        "lng": 90.4140,
        "rating": 4.8,
        "rating_count": 1280,
        "delivery_base_fee": 40,
        "delivery_per_km_fee": 15,
        "is_verified": True,
    },
    {
        "gmail": "demo+sundormed@medidoor.app",
        "google_sub": "demo-sundormed",
        "license": "BD-PH-DEMO-003",
        "pharmacy_name": "Sundor Medicine Corner",
        "owner_name": "Mehedi Karim",
        "business_name": "Sundor Pharma",
        "address": "Mohakhali DOHS, Dhaka",
        "phone_number": "+8801711000003",
        "lat": 23.7820,
        "lng": 90.4030,
        "rating": 4.2,
        "rating_count": 86,
        "delivery_base_fee": 25,
        "delivery_per_km_fee": 10,
        "is_verified": True,
    },
    {
        "gmail": "demo+nightowl@medidoor.app",
        "google_sub": "demo-nightowl",
        "license": "BD-PH-DEMO-004",
        "pharmacy_name": "NightOwl Pharma",
        "owner_name": "Tania Begum",
        "business_name": "NightOwl Trading",
        "address": "Niketon, Gulshan, Dhaka",
        "phone_number": "+8801711000004",
        "lat": 23.7795,
        "lng": 90.4165,
        "rating": 4.0,
        "rating_count": 41,
        "delivery_base_fee": 35,
        "delivery_per_km_fee": 13,
        "is_verified": False,
    },
]

# Stock catalog used to populate every demo pharmacy.
DEMO_MEDICINES: list[dict[str, Any]] = [
    {
        "name": "Napa 500mg",
        "short_description": "প্যারাসিটামল ৫০০mg, জ্বর ও ব্যাথার জন্য",
        "category": "Pain & Fever",
        "image_url": "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=480",
        "price": 1.20,
        "stock": 240,
    },
    {
        "name": "Seclo 20mg",
        "short_description": "Omeprazole — গ্যাস্ট্রিক ও অম্বলে",
        "category": "Gastric",
        "image_url": "https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=480",
        "price": 5.00,
        "stock": 180,
    },
    {
        "name": "Monas 10mg",
        "short_description": "Montelukast, allergy ও asthma-র জন্য",
        "category": "Allergy",
        "image_url": "https://images.unsplash.com/photo-1576602976047-174e57a47881?w=480",
        "price": 14.00,
        "stock": 60,
    },
    {
        "name": "Maxpro 20mg",
        "short_description": "Esomeprazole, acid reflux-এ কার্যকর",
        "category": "Gastric",
        "image_url": "https://images.unsplash.com/photo-1550572017-edd951b55104?w=480",
        "price": 7.50,
        "stock": 120,
    },
    {
        "name": "Histacin",
        "short_description": "Antihistamine, ঠান্ডা/অ্যালার্জিতে",
        "category": "Allergy",
        "image_url": "https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=480",
        "price": 1.50,
        "stock": 320,
    },
    {
        "name": "Cef-3 200mg",
        "short_description": "Cefixime ক্যাপসুল, infection-এ",
        "category": "Antibiotic",
        "image_url": "https://images.unsplash.com/photo-1585435557343-3b092031a831?w=480",
        "price": 35.00,
        "stock": 40,
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
        "name": "Glucometer Strip (50)",
        "short_description": "ডায়াবেটিস টেস্ট স্ট্রিপ — 50 pcs",
        "category": "Devices",
        "image_url": "https://images.unsplash.com/photo-1580281657527-47f249e8f4df?w=480",
        "price": 750.00,
        "stock": 25,
    },
    {
        "name": "ORS Saline",
        "short_description": "ডায়রিয়া ও পানিশূন্যতায়",
        "category": "Daily Essentials",
        "image_url": "https://images.unsplash.com/photo-1550572017-9f2f48b87a05?w=480",
        "price": 6.00,
        "stock": 500,
    },
    {
        "name": "Surgical Mask (50)",
        "short_description": "3-layer disposable mask, box",
        "category": "Daily Essentials",
        "image_url": "https://images.unsplash.com/photo-1584634731339-252c581abfc5?w=480",
        "price": 180.00,
        "stock": 70,
    },
]


async def main() -> None:
    # Make sure schema is up to date before inserting.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await autopatch_sqlite(engine)

    inserted_pharm = 0
    inserted_med = 0

    async with AsyncSessionLocal() as db:
        for pdata in DEMO_PHARMACIES:
            existing = (
                await db.execute(
                    select(PharmacyProfile).where(
                        PharmacyProfile.pharmacy_license_no == pdata["license"]
                    )
                )
            ).scalar_one_or_none()

            if existing is None:
                acct = Account(
                    id=uuid.uuid4(),
                    gmail=pdata["gmail"],
                    google_sub=pdata["google_sub"],
                    role=RoleEnum.pharmacy,
                    is_active=True,
                    is_registered=True,
                )
                db.add(acct)
                await db.flush()
                pharm = PharmacyProfile(
                    id=uuid.uuid4(),
                    account_id=acct.id,
                    pharmacy_name=pdata["pharmacy_name"],
                    owner_name=pdata["owner_name"],
                    business_name=pdata["business_name"],
                    pharmacy_license_no=pdata["license"],
                    pharmacy_license_doc_url=None,
                    banner_photo_url="https://images.unsplash.com/photo-1631549916768-4119b2e5f926?w=1200",
                    address=pdata["address"],
                    phone_number=pdata["phone_number"],
                    lat=pdata["lat"],
                    lng=pdata["lng"],
                    rating=pdata["rating"],
                    rating_count=pdata["rating_count"],
                    delivery_base_fee=pdata["delivery_base_fee"],
                    delivery_per_km_fee=pdata["delivery_per_km_fee"],
                    is_verified=pdata["is_verified"],
                )
                db.add(pharm)
                await db.flush()
                inserted_pharm += 1
            else:
                pharm = existing

            # Upsert categories first so the pharmacy has them visible
            # in the dashboard even before any medicine is added.
            existing_cats = {
                c.name
                for c in (
                    (
                        await db.execute(
                            select(MedicineCategory).where(
                                MedicineCategory.pharmacy_id == pharm.id
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
            }
            for cname in {m["category"] for m in DEMO_MEDICINES}:
                if cname in existing_cats:
                    continue
                db.add(MedicineCategory(
                    id=uuid.uuid4(),
                    pharmacy_id=pharm.id,
                    name=cname,
                    short_description=CATEGORY_DESCRIPTIONS.get(cname),
                ))

            # Upsert medicines.
            existing_meds = {
                m.name
                for m in (
                    (
                        await db.execute(
                            select(Medicine).where(Medicine.pharmacy_id == pharm.id)
                        )
                    )
                    .scalars()
                    .all()
                )
            }
            for mdata in DEMO_MEDICINES:
                if mdata["name"] in existing_meds:
                    continue
                db.add(
                    Medicine(
                        id=uuid.uuid4(),
                        pharmacy_id=pharm.id,
                        name=mdata["name"],
                        short_description=mdata["short_description"],
                        category=mdata["category"],
                        image_url=mdata["image_url"],
                        price=mdata["price"],
                        stock=mdata["stock"],
                        is_active=True,
                    )
                )
                inserted_med += 1

        await db.commit()

    print(f"[seed] +{inserted_pharm} pharmacies, +{inserted_med} medicines")


if __name__ == "__main__":
    asyncio.run(main())
