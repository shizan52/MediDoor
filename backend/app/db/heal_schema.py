"""
Standalone schema healer.

Run this when a deploy synced new model columns but the live SQLite database is
still missing them — which otherwise surfaces as
`sqlite3.OperationalError: no such column ...` and an HTTP 500 from endpoints
that read those tables (e.g. /api/admin/users/riders).

The same patch runs automatically on backend startup, but this lets you fix the
schema immediately without waiting for / depending on a full restart.

Run from the `backend` folder, using the backend virtualenv:

    Windows:   .venv\\Scripts\\python -m app.db.heal_schema
    Linux/mac: .venv/bin/python -m app.db.heal_schema
"""
from __future__ import annotations

import asyncio

# Importing the models registers every table on Base.metadata so the patcher
# can diff the full schema against the live database.
import app.models  # noqa: F401
from app.db.base import engine
from app.db.migrate import autopatch_sqlite


async def _run() -> None:
    notes = list(await autopatch_sqlite(engine))
    if notes:
        for n in notes:
            print(f"[heal] {n}")
        print(f"[heal] done — added/checked {len(notes)} column(s).")
    else:
        print("[heal] schema already up to date — nothing to add.")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(_run())
