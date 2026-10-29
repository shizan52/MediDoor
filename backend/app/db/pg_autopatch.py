"""
Postgres schema-sync — add any model-declared columns that are missing on the
live Postgres database.

WHY
    `app/db/migrate.py::autopatch_sqlite` only patches SQLite and returns early
    for Postgres. So when a new column is added to a model but no Alembic
    migration is run against production, the live Postgres table is missing it.
    SQLAlchemy's ORM then `SELECT`s every mapped column, Postgres raises
    `UndefinedColumnError: column ... does not exist`, and the endpoint 500s.
    (This is what broke every /api/admin/* route — a missing
    `pharmacy_profiles.license_needs_renewal` column.)

WHAT
    Diff every table in `Base.metadata` against `information_schema.columns` and
    `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` each missing column, rendering the
    type with the Postgres dialect. NOT NULL is only emitted when the column has
    a usable default (an existing non-empty table can't take a bare NOT NULL).
    Each statement runs in its own transaction so one odd column can't abort the
    rest. Idempotent — safe to re-run.

RUN (on the VPS)
    cd D:\vps\apps\medidoor\backend
    .venv\Scripts\python -m app.db.pg_autopatch
"""
from __future__ import annotations

import asyncio

from sqlalchemy import text
from sqlalchemy.dialects import postgresql

import app.models  # noqa: F401  — register every table on Base.metadata
from app.db.base import Base, engine


def _ddl_fragment(column) -> str:
    col_type = column.type.compile(dialect=postgresql.dialect())
    parts = [f'"{column.name}"', col_type]
    has_default = False

    server_default = getattr(column, "server_default", None)
    if server_default is not None and getattr(server_default, "arg", None) is not None:
        try:
            parts.append(f"DEFAULT {server_default.arg.text}")  # type: ignore[attr-defined]
            has_default = True
        except AttributeError:
            pass

    default = column.default
    if not has_default and default is not None and getattr(default, "is_scalar", False):
        val = default.arg
        if isinstance(val, bool):
            parts.append(f"DEFAULT {str(val).lower()}")
            has_default = True
        elif isinstance(val, (int, float)):
            parts.append(f"DEFAULT {val}")
            has_default = True
        elif isinstance(val, str):
            parts.append("DEFAULT '" + val.replace("'", "''") + "'")
            has_default = True

    # An existing, populated table rejects a bare NOT NULL ADD COLUMN, so only
    # enforce NOT NULL when we also supply a default to backfill existing rows.
    if not column.nullable and has_default:
        parts.append("NOT NULL")
    return " ".join(parts)


async def pg_autopatch(target_engine) -> list[str]:
    """Add every model-declared column missing on the live Postgres DB.

    Returns human-readable notes. Safe to call on every startup: when the schema
    is already in sync it only runs cheap ``information_schema`` SELECTs and
    changes nothing. Does NOT dispose the engine (it may be the shared app one).
    Returns ``[]`` for non-Postgres backends (SQLite uses ``app.db.migrate``).
    """
    backend = target_engine.url.get_backend_name()
    if not backend.startswith("postgres"):
        return []

    notes: list[str] = []
    for table in Base.metadata.sorted_tables:
        async with target_engine.connect() as conn:
            rows = await conn.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = :t"
            ), {"t": table.name})
            existing = {r[0] for r in rows.fetchall()}
        if not existing:
            continue  # table doesn't exist yet — create_all handles it on startup
        for col in table.columns:
            if col.name in existing:
                continue
            stmt = f'ALTER TABLE "{table.name}" ADD COLUMN IF NOT EXISTS {_ddl_fragment(col)}'
            try:
                async with target_engine.begin() as conn:
                    await conn.exec_driver_sql(stmt)
                notes.append(f"+col {table.name}.{col.name}")
            except Exception as exc:  # noqa: BLE001
                notes.append(f"FAILED {table.name}.{col.name}: {exc}")
    return notes


async def _run() -> None:
    print(f"[pg_autopatch] backend = {engine.url.get_backend_name()}", flush=True)
    notes = await pg_autopatch(engine)
    if notes:
        for n in notes:
            print(f"[pg_autopatch] {n}", flush=True)
    else:
        print("[pg_autopatch] schema already in sync — nothing to add.", flush=True)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(_run())
