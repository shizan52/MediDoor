"""Test admin product moderation endpoints (mirrors what admin.py Tk app does)."""
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import asyncio, sys, io, json, sqlite3, httpx

BASE = "http://localhost:8000"
ADMIN_GMAIL = "admin@medidoor.app"

async def main():
    async with httpx.AsyncClient(timeout=20.0) as c:
        # 1. Admin dev-login
        r = await c.post(f"{BASE}/api/auth/dev-login", json={"gmail": ADMIN_GMAIL, "role": "customer"})
        assert r.status_code == 200, r.text
        admin_tok = r.json()["access_token"]
        h = {"Authorization": f"Bearer {admin_tok}"}
        print(f"[ok] admin logged in: {ADMIN_GMAIL}")

        # 2. List queue (pending + rejected)
        r = await c.get(f"{BASE}/api/admin/moderation/products?status_filter=pending", headers=h)
        assert r.status_code == 200, r.text
        pending = r.json()
        print(f"\n[queue] pending={len(pending)}")
        for p in pending:
            print(f"  • {p['name']} (status={p['approval_status']}, cat={p.get('approval_category')})")
            print(f"    reason: {p.get('approval_reason', '')[:80]}")

        r = await c.get(f"{BASE}/api/admin/moderation/products?status_filter=rejected", headers=h)
        rejected = r.json()
        print(f"\n[queue] rejected={len(rejected)}")
        for p in rejected:
            print(f"  • {p['name']} (status={p['approval_status']})")
            print(f"    reason: {p.get('approval_reason', '')[:80]}")

        # 3. Pick the pending Red Bull (or any pending) and APPROVE it
        target = next((p for p in pending if "Red Bull" in p["name"]), pending[0] if pending else None)
        if target:
            print(f"\n[admin action] APPROVE: {target['name']} ({target['id']})")
            r = await c.post(
                f"{BASE}/api/admin/moderation/products/{target['id']}/approve",
                json={"note": "admin override after manual review — energy drink allowed"},
                headers=h,
            )
            print(f"  → {r.status_code}: {r.json()}")
            assert r.status_code == 200

        # 4. Pick a rejected (Rice) and re-confirm reject with note (idempotent)
        if rejected:
            tgt = rejected[0]
            print(f"\n[admin action] REJECT (re-confirm): {tgt['name']} ({tgt['id']})")
            r = await c.post(
                f"{BASE}/api/admin/moderation/products/{tgt['id']}/reject",
                json={"note": "confirmed: not a healthcare product"},
                headers=h,
            )
            print(f"  → {r.status_code}: {r.json()}")
            assert r.status_code == 200

        # 5. Verify approval state via DB
        db = sqlite3.connect(str(DB_PATH))
        db.row_factory = sqlite3.Row
        print("\n[DB verify]")
        for row in db.execute(
            "SELECT name, approval_status, approval_reviewed_by_admin, approval_reason "
            "FROM medicines ORDER BY created_at DESC LIMIT 5"
        ):
            print(f"  • {row['name']}: status={row['approval_status']} admin_reviewed={row['approval_reviewed_by_admin']}")
            print(f"    reason: {(row['approval_reason'] or '')[:90]}")
        db.close()

        # 6. Confirm storefront now exposes approved Red Bull
        r = await c.get(f"{BASE}/api/storefront/pharmacy/ddfc9f94-58ad-457f-98cb-8758d0ba5c1b", headers=h)
        if r.status_code == 200:
            data = r.json()
            meds = data.get("medicines") or data.get("items") or []
            print(f"\n[storefront after approval] Test Pharmacy now exposes {len(meds)} medicines:")
            for m in meds:
                print(f"  • {m.get('name')} (Rx={m.get('prescription_required')})")

asyncio.run(main())
