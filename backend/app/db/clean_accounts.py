"""
Review & clean up user accounts — SAFE by default (dry-run).

WHY
    During launch/testing many accounts get created: seed/demo accounts
    (`*@medidoor.app`, `demo+*`), and real people who accidentally signed in
    under the WRONG role (one Gmail = one role for life, so they're then stuck).
    This tool lets you SEE every account and delete only the ones you choose,
    without wiping the whole database.

SAFETY
    * Runs against whatever DATABASE_URL is configured — on the VPS that is the
      LIVE PostgreSQL, so read the dry-run list carefully before using --apply.
    * Nothing is deleted unless you pass --apply. Without it the script only
      prints what it WOULD delete.
    * Deletion relies on the FK cascades already declared on the models
      (accounts -> profiles -> orders/medicines/chats), so removing an account
      cleanly removes everything tied to it. Orders placed BY a deleted customer
      keep their row but get customer_account_id set to NULL (history preserved).

USAGE  (run from the backend folder, inside its venv)
    # 1) Just look — list every account, flag seed/test + unregistered ones:
    python -m app.db.clean_accounts

    # 2) Delete obvious seed/test accounts (*@medidoor.app, demo+*):
    python -m app.db.clean_accounts --tests --apply

    # 3) Delete accounts that never finished registration (stuck half-signups):
    python -m app.db.clean_accounts --unregistered --apply

    # 4) Delete one specific account (e.g. someone stuck in the wrong role,
    #    so they can re-register fresh). Repeatable.
    python -m app.db.clean_accounts --gmail someone@gmail.com --apply

    # Protect an address from --tests/--unregistered (repeatable):
    python -m app.db.clean_accounts --tests --keep admin@medidoor.app --apply

Combine flags freely. --tests and --unregistered and --gmail are UNIONed.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict

from sqlalchemy import event, func, select, text
from sqlalchemy.orm import selectinload

from app.db.base import AsyncSessionLocal, engine
from app.models import Account, Order

_IS_SQLITE = engine.url.get_backend_name().startswith("sqlite")

# SQLite ignores ON DELETE CASCADE unless foreign_keys is ON per-connection.
# Postgres (the live DB) enforces them natively, so this is a no-op there.
if _IS_SQLITE:
    @event.listens_for(engine.sync_engine, "connect")
    def _enable_sqlite_fks(dbapi_conn, _record):  # noqa: ANN001
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()


def _is_test_gmail(gmail: str) -> bool:
    g = (gmail or "").strip().lower()
    return g.endswith("@medidoor.app") or g.startswith("demo+")


async def _order_counts(db) -> tuple[dict, dict]:
    """Return (orders_as_pharmacy_by_pharmacy_id, orders_as_customer_by_account_id)."""
    by_pharmacy: dict = {}
    rows = await db.execute(select(Order.pharmacy_id, func.count()).group_by(Order.pharmacy_id))
    for pid, n in rows.all():
        by_pharmacy[pid] = n
    by_customer: dict = {}
    rows = await db.execute(
        select(Order.customer_account_id, func.count())
        .where(Order.customer_account_id.is_not(None))
        .group_by(Order.customer_account_id)
    )
    for aid, n in rows.all():
        by_customer[aid] = n
    return by_pharmacy, by_customer


def _profile_of(acc: Account):
    return acc.customer or acc.pharmacy or acc.rider


async def main() -> None:
    ap = argparse.ArgumentParser(description="Review & clean up user accounts (dry-run by default).")
    ap.add_argument("--tests", action="store_true",
                    help="target seed/test accounts (*@medidoor.app, demo+*)")
    ap.add_argument("--unregistered", action="store_true",
                    help="target accounts that never finished registration")
    ap.add_argument("--gmail", action="append", default=[],
                    help="target one specific gmail (repeatable)")
    ap.add_argument("--keep", action="append", default=[],
                    help="protect a gmail from --tests/--unregistered (repeatable)")
    ap.add_argument("--apply", action="store_true",
                    help="actually delete (without this it is a dry run)")
    args = ap.parse_args()

    keep = {g.strip().lower() for g in args.keep}
    want_gmails = {g.strip().lower() for g in args.gmail}

    print(f"DB backend: {engine.url.get_backend_name()}  ({engine.url.render_as_string(hide_password=True)})")

    async with AsyncSessionLocal() as db:
        accounts = (
            await db.execute(
                select(Account).options(
                    selectinload(Account.customer),
                    selectinload(Account.pharmacy),
                    selectinload(Account.rider),
                ).order_by(Account.created_at)
            )
        ).scalars().all()
        by_pharmacy, by_customer = await _order_counts(db)

        targeted: list[Account] = []
        print(f"\n=== {len(accounts)} account(s) ===")
        print(f"{'sel':>3}  {'role':<9} {'reg':<4} {'orders':<7} {'gmail':<38} note")
        for a in accounts:
            gmail = (a.gmail or "").lower()
            prof = _profile_of(a)
            orders = by_customer.get(a.id, 0)
            if a.pharmacy is not None:
                orders += by_pharmacy.get(a.pharmacy.id, 0)

            hit = False
            reasons = []
            if gmail in want_gmails:
                hit = True
                reasons.append("--gmail")
            if args.tests and _is_test_gmail(gmail):
                hit = True
                reasons.append("test")
            if args.unregistered and not a.is_registered:
                hit = True
                reasons.append("unregistered")
            if hit and gmail in keep:
                hit = False
                reasons = ["KEPT"]

            note = []
            if _is_test_gmail(gmail):
                note.append("seed/test")
            if not a.is_registered:
                note.append("never finished signup")
            if prof is None:
                note.append("no profile")
            note += ([f"({'+'.join(reasons)})"] if reasons else [])

            print(f"{'DEL' if hit else '':>3}  {a.role.value:<9} "
                  f"{('yes' if a.is_registered else 'no'):<4} {orders:<7} "
                  f"{a.gmail:<38} {', '.join(note)}")
            if hit:
                targeted.append(a)

        if not (args.tests or args.unregistered or want_gmails):
            print("\nNo targeting flags given — list only. "
                  "Use --tests / --unregistered / --gmail to select, then --apply to delete.")
            return

        print(f"\n{len(targeted)} account(s) selected for deletion.")
        if not targeted:
            return

        if not args.apply:
            print("DRY RUN — nothing deleted. Re-run with --apply to actually delete.")
            return

        for a in targeted:
            await db.delete(a)
        await db.commit()
        print(f"DELETED {len(targeted)} account(s) and all their cascaded data "
              f"(profiles, medicines, orders-as-pharmacy, chats). "
              f"Orders placed by deleted customers were kept with a NULL customer.")


if __name__ == "__main__":
    asyncio.run(main())
