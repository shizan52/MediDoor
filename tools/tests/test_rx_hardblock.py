"""Direct API test of the prescription_required hard-block in conversations.post_message."""
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import asyncio, sys, io, json, httpx

BASE = "http://localhost:8000"

async def main():
    async with httpx.AsyncClient(timeout=20.0) as c:
        # 1. Customer dev-login
        r = await c.post(f"{BASE}/api/auth/dev-login", json={"gmail": "test.customer@medidoor.app", "role": "customer"})
        assert r.status_code == 200, r.text
        cust_token = r.json()["access_token"]
        print("[ok] customer logged in")

        # 2. Find Rx medicine + pharmacy from DB directly (avoid storefront filtering)
        import sqlite3
        db = sqlite3.connect(str(DB_PATH))
        db.row_factory = sqlite3.Row
        row = db.execute(
            "SELECT id, name, price, pharmacy_id FROM medicines "
            "WHERE prescription_required=1 AND approval_status='approved' AND is_active=1 LIMIT 1"
        ).fetchone()
        db.close()
        assert row, "no Rx-required approved medicine in DB"
        rx_med = {"id": row["id"], "name": row["name"], "price": row["price"]}
        pharm_id = row["pharmacy_id"]
        print(f"[ok] found Rx medicine: {rx_med['name']} id={rx_med['id']} pharmacy={pharm_id}")

        # 3. Open / get conversation with Test Pharmacy
        r = await c.post(f"{BASE}/api/conversations",
                         json={"pharmacy_id": pharm_id},
                         headers={"Authorization": f"Bearer {cust_token}"})
        assert r.status_code in (200, 201), r.text
        conv = r.json()
        conv_id = conv["id"]
        print(f"[ok] opened conversation {conv_id}")

        # 4. ATTEMPT 1 — send order_request WITHOUT prescription. Expect 400 prescription_required.
        order_payload = {
            "items": [
                {"medicine_id": rx_med["id"], "name": rx_med["name"], "qty": 2,
                 "unit_price": rx_med["price"], "prescription_required": True}
            ],
            "subtotal": rx_med["price"] * 2,
            "delivery_fee": 30,
            "total": rx_med["price"] * 2 + 30,
            "note": "test order without prescription",
        }
        msg = {
            "body": "Order request — testing Rx block",
            "preset_key": "order_request",
            "payload": order_payload,
        }
        r = await c.post(f"{BASE}/api/conversations/{conv_id}/messages",
                         json=msg, headers={"Authorization": f"Bearer {cust_token}"})
        print(f"\n[TEST 1: no prescription] status={r.status_code}")
        print(json.dumps(r.json(), indent=2, ensure_ascii=False))
        assert r.status_code == 400, f"expected 400, got {r.status_code}"
        body = r.json()
        assert body.get("detail", {}).get("code") == "prescription_required", "wrong block code"
        print("[PASS] backend correctly hard-blocked Rx order without prescription")

        # 5. ATTEMPT 2 — send same order WITH attachment_url. Expect 200/201.
        msg2 = {**msg, "attachment_url": "/uploads/fake-prescription.jpg"}
        r = await c.post(f"{BASE}/api/conversations/{conv_id}/messages",
                         json=msg2, headers={"Authorization": f"Bearer {cust_token}"})
        print(f"\n[TEST 2: with prescription] status={r.status_code}")
        if r.status_code in (200, 201):
            print("[PASS] backend accepted Rx order WITH prescription attached")
        else:
            print(json.dumps(r.json(), indent=2, ensure_ascii=False))

asyncio.run(main())
