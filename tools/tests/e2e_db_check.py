"""DB sanity for e2e: counts of every important table + which seed accounts exist."""
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import asyncio, sys, io, os
from pathlib import Path
os.chdir(ROOT / "backend")
sys.path.insert(0, str(ROOT / "backend"))
from sqlalchemy import select, func
from app.db.base import AsyncSessionLocal
from app.models import (
    Account, PharmacyProfile, RiderProfile, Medicine, MedicineCategory,
    Conversation, ConversationMessage, Order,
)


async def main():
    async with AsyncSessionLocal() as db:
        async def cnt(model):
            return (await db.execute(select(func.count(model.id)))).scalar_one()
        print(f"users:                {await cnt(Account)}")
        print(f"pharmacy_profiles:    {await cnt(PharmacyProfile)}")
        print(f"rider_profiles:       {await cnt(RiderProfile)}")
        print(f"medicines:            {await cnt(Medicine)}")
        print(f"medicine_categories:  {await cnt(MedicineCategory)}")
        print(f"conversations:        {await cnt(Conversation)}")
        print(f"conversation_msgs:    {await cnt(ConversationMessage)}")
        print(f"orders:               {await cnt(Order)}")

        print("\nSeed accounts:")
        for email in ("test.customer@medidoor.app", "test.pharmacy@medidoor.app", "test.rider@medidoor.app"):
            u = (await db.execute(select(Account).where(Account.gmail == email))).scalar_one_or_none()
            print(f"  {email}: {'OK' if u else 'MISSING'} role={u.role if u else '-'}")

        print("\nPublished pharmacies:")
        rows = (await db.execute(select(PharmacyProfile))).scalars().all()
        for p in rows:
            print(f"  {p.pharmacy_name:20} published={p.is_published} verified={p.is_verified} "
                  f"lat={p.lat} lng={p.lng} rating={p.rating}")

asyncio.run(main())
