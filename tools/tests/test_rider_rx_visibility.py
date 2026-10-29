"""Rider visibility test: rider joins conversation and sees prescription attachment_url."""
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import asyncio, sys, io, sqlite3, httpx

BASE = "http://localhost:8000"

async def main():
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row

    # Find a rider account
    r_row = db.execute(
        "SELECT a.gmail FROM accounts a JOIN rider_profiles rp ON rp.account_id=a.id "
        "WHERE a.role='rider' LIMIT 1"
    ).fetchone()
    if not r_row:
        print("[skip] no rider in DB")
        return
    rider_gmail = r_row["gmail"]
    print(f"[ok] using rider {rider_gmail}")

    # Find the most recent conversation that has a customer order_request with attachment_url
    conv_row = db.execute("""
        SELECT c.id AS cid, c.pharmacy_id, c.rider_id
        FROM conversations c
        JOIN conversation_messages m ON m.conversation_id=c.id
        WHERE m.preset_key='order_request' AND m.attachment_url IS NOT NULL
        ORDER BY m.created_at DESC LIMIT 1
    """).fetchone()
    if not conv_row:
        print("[skip] no conversation with prescription attachment found")
        return
    conv_id = conv_row["cid"]
    print(f"[ok] target conversation: {conv_id}")

    # Get rider account UUID + rider_profile id
    rider_acct_id = db.execute(
        "SELECT id FROM accounts WHERE gmail=?", (rider_gmail,)
    ).fetchone()["id"]
    rider_prof_id = db.execute(
        "SELECT id FROM rider_profiles WHERE account_id=?", (rider_acct_id,)
    ).fetchone()["id"]

    # Manually attach this rider to the conversation (simulating offer accept)
    db.execute("UPDATE conversations SET rider_id=? WHERE id=?", (rider_prof_id, conv_id.replace("-", "")))
    db.commit()
    print(f"[ok] attached rider_profile_id={rider_prof_id} to conversation")

    async with httpx.AsyncClient(timeout=15.0) as c:
        # Rider dev-login
        r = await c.post(f"{BASE}/api/auth/dev-login", json={"gmail": rider_gmail, "role": "rider"})
        assert r.status_code == 200, r.text
        rider_tok = r.json()["access_token"]

        # Rider fetches conversation messages
        r = await c.get(
            f"{BASE}/api/conversations/{conv_id}/messages",
            headers={"Authorization": f"Bearer {rider_tok}"},
        )
        print(f"[messages GET] status={r.status_code}")
        if r.status_code != 200:
            print(r.text)
            return
        msgs = r.json()
        print(f"[messages] rider sees {len(msgs)} messages")

        rx_msgs = [m for m in msgs if m.get("preset_key") == "order_request" and m.get("attachment_url")]
        print(f"[messages] order_request with attachment: {len(rx_msgs)}")
        for m in rx_msgs[-3:]:
            print(f"  • body: {m['body'][:60]}")
            print(f"    attachment_url: {m['attachment_url']}")
            payload = m.get("payload") or {}
            for it in payload.get("items", []):
                print(f"    item: {it.get('name')} (Rx={it.get('prescription_required')}) qty={it.get('qty')}")

        if rx_msgs:
            print("\n[PASS] rider can see prescription attachment_url on Rx order_request")
        else:
            print("\n[FAIL] rider cannot see Rx order with attachment")

    db.close()

asyncio.run(main())
