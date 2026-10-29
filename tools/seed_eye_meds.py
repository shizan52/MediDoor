"""Add a few real-Rx-matching eye drop medicines to Test Pharmacy so the
smart prescription happy path can be exercised in the browser."""
import asyncio, sys, io, os
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT / "backend")
sys.path.insert(0, str(ROOT / "backend"))
from sqlalchemy import select
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from app.db.base import AsyncSessionLocal
from app.models import Medicine, PharmacyProfile, MedicineCategory


SEEDS = [
    ("A.F.M.", "Eye Drop", "Antifungal/anti-inflammatory eye drop", "Eye Care", 1, 180.0, 30),
    ("Aladay SSN", "Eye Drop", "Lubricating + decongestant eye drop", "Eye Care", 1, 220.0, 25),
    ("Armakash Regigel P", "Eye Gel", "Carbomer-based regenerating eye gel", "Eye Care", 1, 280.0, 20),
    ("Fixal 500mg", "Antibiotic Tablet", "Cefixime 500 mg tablet", "Antibiotics", 20, 120.0, 80),
]


async def main():
    async with AsyncSessionLocal() as db:
        pharm = (await db.execute(
            select(PharmacyProfile).where(PharmacyProfile.pharmacy_name == "Test Pharmacy")
        )).scalar_one_or_none()
        if not pharm:
            print("Test Pharmacy not found — run seed_test_accounts first")
            return
        # Ensure categories
        for cat_name in {"Eye Care", "Antibiotics"}:
            exists = (await db.execute(
                select(MedicineCategory).where(
                    MedicineCategory.pharmacy_id == pharm.id,
                    MedicineCategory.name == cat_name,
                )
            )).scalar_one_or_none()
            if not exists:
                db.add(MedicineCategory(pharmacy_id=pharm.id, name=cat_name))
        await db.flush()

        added = 0
        for name, short, desc, cat, qty, price, stock in SEEDS:
            exists = (await db.execute(
                select(Medicine).where(
                    Medicine.pharmacy_id == pharm.id, Medicine.name == name
                )
            )).scalar_one_or_none()
            if exists:
                continue
            db.add(Medicine(
                pharmacy_id=pharm.id,
                name=name,
                short_description=short,
                description=desc,
                category=cat,
                price=price,
                stock=stock,
                is_active=True,
                approval_status="approved",
                prescription_required=False,
            ))
            added += 1
        await db.commit()
        print(f"Added {added} medicines to Test Pharmacy")


asyncio.run(main())
