"""
Production hotfix — add the missing ban/block columns on Postgres.

WHY
    backend/app/db/migrate.py only auto-patches SQLite (it returns early for
    Postgres). The models (app/models/user.py) declare ban/block columns on
    customer_profiles + pharmacy_profiles, so on the live Postgres DB those
    columns are missing and every admin list/ban/block query raises
    `column ... does not exist` -> HTTP 500. This script adds them.

RUN (on the VPS, from the backend folder, using the backend venv)
    cd D:\vps\apps\medidoor\backend
    .venv\Scripts\python -m app.db.fix_ban_block_columns

Idempotent (ADD COLUMN IF NOT EXISTS). No rows are modified. Works on both
Postgres and SQLite. After it prints "done", the admin tool's user list /
ban / block will work — no backend restart required.
"""
from __future__ import annotations

import asyncio

from sqlalchemy import text

from app.db.base import engine

STATEMENTS = [
    'ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS is_banned  BOOLEAN NOT NULL DEFAULT FALSE',
    'ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS ban_notice TEXT',
    'ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS banned_at  TIMESTAMPTZ',
    'ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS banned_by  VARCHAR(255)',
    'CREATE INDEX IF NOT EXISTS ix_customer_profiles_is_banned ON customer_profiles (is_banned)',
    'ALTER TABLE pharmacy_profiles ADD COLUMN IF NOT EXISTS is_blocked   BOOLEAN NOT NULL DEFAULT FALSE',
    'ALTER TABLE pharmacy_profiles ADD COLUMN IF NOT EXISTS block_notice TEXT',
    'ALTER TABLE pharmacy_profiles ADD COLUMN IF NOT EXISTS blocked_at   TIMESTAMPTZ',
    'ALTER TABLE pharmacy_profiles ADD COLUMN IF NOT EXISTS blocked_by   VARCHAR(255)',
    'CREATE INDEX IF NOT EXISTS ix_pharmacy_profiles_is_blocked ON pharmacy_profiles (is_blocked)',
]


async def _run() -> None:
    backend = engine.url.get_backend_name()
    print(f"[fix] backend = {backend}", flush=True)
    if backend.startswith("sqlite"):
        # SQLite lacks "ADD COLUMN IF NOT EXISTS" — the normal startup
        # autopatch_sqlite already handles SQLite, so nothing to do here.
        print("[fix] SQLite detected — use `python -m app.db.migrate` instead. Nothing to do.")
        await engine.dispose()
        return
    async with engine.begin() as conn:
        for stmt in STATEMENTS:
            await conn.exec_driver_sql(stmt)
            print(f"[fix] ok: {stmt[:70]}...", flush=True)
    await engine.dispose()
    print("[fix] done — admin user list / ban / block should work now.", flush=True)


if __name__ == "__main__":
    asyncio.run(_run())
