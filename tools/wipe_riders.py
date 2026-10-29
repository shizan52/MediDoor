"""
Wipe ALL rider data from medidoor.db.

Deletes:
  • rider_offers                    — all rows
  • orders.accepted_rider_id        — set NULL (orders themselves preserved)
  • conversations.rider_id          — set NULL
  • rider_profiles                  — all rows (cascades from accounts too)
  • accounts WHERE role='rider'     — all rows

Safe to run while backend is stopped. Idempotent.

Usage:
    python tools/wipe_riders.py
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "backend" / "medidoor.db"


def main() -> int:
    if not DB.exists():
        print(f"[wipe_riders] medidoor.db not found at {DB}")
        return 1

    con = sqlite3.connect(DB, timeout=10.0)
    con.execute("PRAGMA foreign_keys = ON")
    cur = con.cursor()

    def count(table: str, where: str = "") -> int:
        try:
            row = cur.execute(f"SELECT COUNT(*) FROM {table} {where}").fetchone()
            return int(row[0] or 0)
        except sqlite3.Error:
            return 0

    before = {
        "rider_offers": count("rider_offers"),
        "rider_profiles": count("rider_profiles"),
        "accounts(rider)": count("accounts", "WHERE role='rider'"),
        "orders.accepted_rider_id NOT NULL": count(
            "orders", "WHERE accepted_rider_id IS NOT NULL"
        ),
        "conversations.rider_id NOT NULL": count(
            "conversations", "WHERE rider_id IS NOT NULL"
        ),
    }
    print("[wipe_riders] before:")
    for k, v in before.items():
        print(f"   {k:<40} {v}")

    # Best-effort, table may not exist on a brand-new DB
    for stmt in (
        "DELETE FROM rider_offers",
        "UPDATE orders SET accepted_rider_id = NULL WHERE accepted_rider_id IS NOT NULL",
        "UPDATE conversations SET rider_id = NULL WHERE rider_id IS NOT NULL",
        "DELETE FROM rider_profiles",
        "DELETE FROM accounts WHERE role = 'rider'",
    ):
        try:
            cur.execute(stmt)
            print(f"   ✓ {stmt}  →  {cur.rowcount} row(s)")
        except sqlite3.Error as exc:
            print(f"   ! {stmt}  →  skipped ({exc})")

    con.commit()

    after = {
        "rider_offers": count("rider_offers"),
        "rider_profiles": count("rider_profiles"),
        "accounts(rider)": count("accounts", "WHERE role='rider'"),
    }
    print("[wipe_riders] after:")
    for k, v in after.items():
        print(f"   {k:<40} {v}")

    con.close()
    print("[wipe_riders] done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
