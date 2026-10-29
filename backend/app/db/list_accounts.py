"""Quick dev helper: list all accounts in the DB."""

import asyncio

from sqlalchemy import select

from app.db.base import AsyncSessionLocal
from app.models import Account


async def main() -> None:
    async with AsyncSessionLocal() as s:
        rows = (await s.execute(select(Account))).scalars().all()
        for a in rows:
            print(f"{a.id}  {a.role.value:<10}  {a.gmail}")
        print(f"\nTotal: {len(rows)}")


if __name__ == "__main__":
    asyncio.run(main())
