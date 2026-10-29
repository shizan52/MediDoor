"""Inject sample items_json into the UI test pharmacy's delivered orders so
the Top selling products card renders 10 rows for layout verification."""
import asyncio, json
from sqlalchemy import select
from app.db.base import AsyncSessionLocal
from app.models.user import Account, RoleEnum
from app.models.order import Order, OrderStatus

PRODUCTS = [
    ("Napa 500mg", 8), ("Seclo 20mg", 12), ("Maxpro 20mg", 7),
    ("Histacin", 14), ("Monas 10mg", 6), ("Cef-3 200mg", 5),
    ("Vitamin D3 40000 IU", 9), ("Glucometer Strip (50)", 3),
    ("ORS Saline", 22), ("Surgical Mask (50)", 11), ("Paracetamol XR", 4),
]

async def m():
    async with AsyncSessionLocal() as db:
        a = (await db.execute(select(Account).where(Account.gmail == "ui.pharm@medidoor.app"))).scalar_one()
        from app.models.user import PharmacyProfile
        p = (await db.execute(select(PharmacyProfile).where(PharmacyProfile.account_id == a.id))).scalar_one()
        orders = (await db.execute(
            select(Order).where(Order.pharmacy_id == p.id, Order.status == OrderStatus.delivered)
        )).scalars().all()
        print(f"Found {len(orders)} delivered orders")
        for i, o in enumerate(orders):
            # spread products across orders so each delivered order contributes some
            items = []
            for j, (name, qty) in enumerate(PRODUCTS):
                if (i + j) % 3 == 0:
                    items.append({
                        "medicine_id": f"fake-{j}",
                        "name": name,
                        "qty": qty,
                        "price": 10 + j * 5,
                        "image_url": None,
                    })
            o.items_json = json.dumps(items)
        await db.commit()
        print("Done")

asyncio.run(m())
