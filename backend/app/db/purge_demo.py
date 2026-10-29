"""
Delete all demo / dummy data inserted by `app.db.seed`.

Removes accounts whose gmail starts with `demo+` (and via cascade their
pharmacy profile, medicines, categories, orders, etc.).

Run:
    python -m app.db.purge_demo
"""
from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.db.base import AsyncSessionLocal
from app.models import Account


async def main() -> None:
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(Account).where(Account.gmail.like("demo+%@medidoor.app"))
        )).scalars().all()
        n = len(rows)
        for a in rows:
            await db.delete(a)
        await db.commit()
        print(f"[purge] removed {n} demo account(s) (cascade: pharmacy, medicines, categories)")


if __name__ == "__main__":
    asyncio.run(main())
