"""
Tiny dev-only schema migrator for SQLite.

`Base.metadata.create_all` only creates **missing tables** — it never adds new
columns to an existing table. This helper reads the live `PRAGMA table_info`,
diffs it against our SQLAlchemy metadata, and `ALTER TABLE ADD COLUMN`s the
missing ones. Safe to run on every startup.

For Postgres / Alembic, prefer real migrations.
"""
from __future__ import annotations

from typing import Iterable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.base import Base


def _column_ddl_fragment(column) -> str:
    """Render `<name> <TYPE> [DEFAULT ...] [NOT NULL]` for ALTER TABLE."""
    col_type = column.type.compile(dialect=None)
    parts = [f'"{column.name}"', col_type]
    # SQLite ADD COLUMN with NOT NULL requires a DEFAULT — only add if both sides agree.
    default = column.default
    if default is not None and getattr(default, "is_scalar", False):
        val = default.arg
        if isinstance(val, bool):
            parts.append(f"DEFAULT {1 if val else 0}")
        elif isinstance(val, (int, float)):
            parts.append(f"DEFAULT {val}")
        elif isinstance(val, str):
            parts.append(f"DEFAULT '{val}'")
    if not column.nullable and "DEFAULT" not in " ".join(parts):
        # SQLite refuses NOT NULL without DEFAULT on ADD COLUMN — fall back to nullable.
        return " ".join(parts)
    if not column.nullable:
        parts.append("NOT NULL")
    return " ".join(parts)


async def autopatch_sqlite(engine: AsyncEngine) -> Iterable[str]:
    """Add any newly-declared columns to existing SQLite tables. Returns notes."""
    if not engine.url.get_backend_name().startswith("sqlite"):
        return []

    notes: list[str] = []
    async with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            try:
                rows = await conn.exec_driver_sql(f'PRAGMA table_info("{table.name}")')
                existing = {r[1] for r in rows.fetchall()}
            except Exception:
                continue
            if not existing:
                # Table doesn't exist yet — create_all will handle it.
                continue
            for col in table.columns:
                if col.name in existing:
                    continue
                ddl = _column_ddl_fragment(col)
                stmt = f'ALTER TABLE "{table.name}" ADD COLUMN {ddl}'
                try:
                    await conn.exec_driver_sql(stmt)
                    notes.append(f"+col {table.name}.{col.name}")
                except Exception as exc:  # noqa: BLE001
                    # N12 — if another worker added this column microseconds
                    # earlier (multi-worker startup race), SQLite raises
                    # "duplicate column name". That's benign — the column now
                    # exists, which is the goal. Anything else we surface.
                    msg = str(exc).lower()
                    if "duplicate column" in msg or "already exists" in msg:
                        notes.append(f"=col {table.name}.{col.name} (already added)")
                    else:
                        raise
    return notes


if __name__ == "__main__":
    # Standalone schema healer: run this when a deploy synced new model columns
    # but the live SQLite DB is missing them (which otherwise shows up as
    # `OperationalError: no such column ...` -> HTTP 500). Normally this also
    # runs automatically on backend startup, but this lets you fix the schema
    # without a full restart:
    #
    #     cd backend && .venv\Scripts\python -m app.db.migrate
    #
    import asyncio

    # Import the models so every table is registered on `Base.metadata` before
    # we diff it against the live DB. (On normal startup main.py imports the
    # routes which import the models; when run standalone we must do it here,
    # otherwise the metadata is empty and autopatch sees no tables to patch.)
    import app.models  # noqa: F401
    from app.db.base import engine

    async def _run() -> None:
        notes = list(await autopatch_sqlite(engine))
        if notes:
            for n in notes:
                print(f"[migrate] {n}")
        else:
            print("[migrate] schema already up to date — nothing to add.")
        await engine.dispose()

    asyncio.run(_run())
