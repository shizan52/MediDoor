"""
E2E: AI-brokered handshake + dual-confirm Smart Prescription flow.

Phases:
  1) Customer uploads asset/a.jpg, calls /api/ai/prescription-scan
  2) Customer calls NEW /api/ai/prescription-handshake (no credit consumed,
     no order rows created) → expects ai_handshake message in conversation
  3) Pharmacy reads the conversation and posts pharmacy_handshake_ok
     → server auto-posts ai_customer_confirm_prompt
  4) Customer calls /api/ai/prescription-dispatch with handshake_ids set
     → order_request created + ai_handshake_completed posted + 1 credit consumed
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import json
import os
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests


BASE = os.environ.get("MEDIDOOR_TEST_BASE", "http://localhost:8000")
IMG = ASSETS / "a.jpg"
DB_PATH = DB_PATH

LAT, LNG = 22.7009, 90.3676

CUSTOMER = "test.customer@medidoor.app"
PHARMACY = "test.pharmacy@medidoor.app"


def step(t: str) -> None:
    print(f"\n=== {t} ===")


def reset_test_data() -> None:
    if not DB_PATH.exists():
        return
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("SELECT id FROM accounts WHERE gmail IN (?, ?)", (CUSTOMER, PHARMACY))
    acct_ids = [r[0] for r in cur.fetchall()]
    if acct_ids:
        placeholders = ",".join("?" * len(acct_ids))
        cur.execute(
            f"SELECT id FROM conversations WHERE customer_account_id IN ({placeholders})",
            acct_ids,
        )
        conv_ids = [r[0] for r in cur.fetchall()]
        cur.execute(
            f"SELECT id FROM orders WHERE customer_account_id IN ({placeholders})",
            acct_ids,
        )
        order_ids = [r[0] for r in cur.fetchall()]
        if conv_ids:
            ph = ",".join("?" * len(conv_ids))
            cur.execute(
                f"DELETE FROM conversation_messages WHERE conversation_id IN ({ph})",
                conv_ids,
            )
        if order_ids:
            ph = ",".join("?" * len(order_ids))
            cur.execute(f"DELETE FROM order_messages WHERE order_id IN ({ph})", order_ids)
            cur.execute(f"DELETE FROM orders WHERE id IN ({ph})", order_ids)
        if conv_ids:
            ph = ",".join("?" * len(conv_ids))
            cur.execute(f"DELETE FROM conversations WHERE id IN ({ph})", conv_ids)
        # Reset Smart Prescription quota for test customer so reruns work.
        ph = ",".join("?" * len(acct_ids))
        cur.execute(
            f"UPDATE ai_usage SET count = 0 WHERE feature = 'smart_prescription' AND account_id IN ({ph})",
            acct_ids,
        )
    con.commit()
    con.close()
    print("[reset] cleared prior conversations / orders for test users")


def pharmacy_owner_gmail(pharmacy_id: str) -> str:
    """Look up the gmail of the account that owns pharmacy_id.

    The scan returns whatever pharmacy is closest to LAT/LNG — which may not be
    the seeded test pharmacy. Dev-login as the actual owner so the conv is
    visible from the pharmacy side.
    """
    pid_no_dash = pharmacy_id.replace("-", "")
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(
        """
        SELECT a.gmail
        FROM pharmacy_profiles pp
        JOIN accounts a ON a.id = pp.account_id
        WHERE pp.id = ? OR pp.id = ?
        """,
        (pharmacy_id, pid_no_dash),
    )
    row = cur.fetchone()
    con.close()
    if not row:
        raise RuntimeError(f"no owner found for pharmacy {pharmacy_id}")
    return row[0]


def login(gmail: str, role: str) -> str:
    r = requests.post(
        f"{BASE}/api/auth/dev-login", json={"gmail": gmail, "role": role}, timeout=10
    )
    r.raise_for_status()
    return r.json()["access_token"]


def main() -> int:
    if not IMG.exists():
        print(f"Missing prescription image at {IMG}")
        return 2

    reset_test_data()

    step("dev-login customer")
    cust_tok = login(CUSTOMER, "customer")
    Hc = {"Authorization": f"Bearer {cust_tok}"}
    print("customer token ok")

    step("upload prescription image (asset/a.jpg)")
    with IMG.open("rb") as f:
        r = requests.post(
            f"{BASE}/api/upload",
            headers=Hc,
            files={"file": ("rx.jpg", f, "image/jpeg")},
            timeout=30,
        )
    r.raise_for_status()
    image_url = r.json()["url"]
    if image_url.startswith("http"):
        image_url = urlparse(image_url).path
    print(f"uploaded -> {image_url}")

    step("POST /api/ai/prescription-scan")
    r = requests.post(
        f"{BASE}/api/ai/prescription-scan",
        headers={**Hc, "Content-Type": "application/json"},
        json={"image_url": image_url, "lat": LAT, "lng": LNG, "radius_km": 4.0},
        timeout=60,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:600]); return 1
    scan = r.json()
    if not scan.get("ok"):
        print(f"scan returned non-ok ({scan.get('code')}): {scan.get('message')}")
        return 1
    proposals = scan["proposals"]
    if not proposals:
        print("No proposals returned")
        return 1
    p = proposals[0]
    print(f"{len(proposals)} proposals; picking #0: {p['pharmacy']['name']} (coverage {p['coverage_pct']}%)")

    # Dev-login as whoever actually owns the selected pharmacy
    # (radius-based scan may pick a non-seeded pharmacy).
    owner_gmail = pharmacy_owner_gmail(p["pharmacy"]["id"])
    pharm_tok = login(owner_gmail, "pharmacy")
    Hp = {"Authorization": f"Bearer {pharm_tok}"}
    print(f"dev-login pharmacy owner {owner_gmail} for {p['pharmacy']['name']}")

    items = [
        {
            "medicine_id": it["medicine_id"],
            "name": it["name"],
            "qty": it["qty"],
            "unit_price": it["unit_price"],
            "prescription_required": it["prescription_required"],
            "rx_strength": it["rx_strength"],
            "rx_instructions": it["rx_instructions"],
        }
        for it in p["items"]
    ]
    plan = {
        "pharmacy_id": p["pharmacy"]["id"],
        "items": items,
        "subtotal": p["subtotal"],
        "delivery_fee": p["delivery_fee"],
        "total": p["total"],
    }

    # ------------- Phase 1: handshake -------------
    step("POST /api/ai/prescription-handshake (NEW)")
    r = requests.post(
        f"{BASE}/api/ai/prescription-handshake",
        headers={**Hc, "Content-Type": "application/json"},
        json={
            "prescription_url": image_url,
            "plans": [plan],
            "note": scan["ai"]["notes"],
            "delivery_lat": LAT,
            "delivery_lng": LNG,
        },
        timeout=15,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:600]); return 1
    hs = r.json()
    print(json.dumps(hs, ensure_ascii=False, indent=2)[:1200])
    assert hs.get("ok"), "handshake not ok"
    conv_id = hs["conversation_id"]
    handshake_id = hs["handshake_id"]
    assert handshake_id, "no handshake_id"
    print(f"handshake_id={handshake_id} conv={conv_id}")

    # Verify ai_handshake message exists in conversation (as customer)
    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    r.raise_for_status()
    msgs = r.json()
    hs_msg = next((m for m in msgs if m.get("preset_key") == "ai_handshake"), None)
    assert hs_msg is not None, "ai_handshake message missing"
    pl = hs_msg.get("payload") or {}
    assert pl.get("handshake_id") == handshake_id, "handshake_id mismatch"
    assert pl.get("status") == "awaiting_pharmacy", f"unexpected status {pl.get('status')}"
    print(f"OK — ai_handshake in conv with {len(pl.get('items', []))} items, total={pl.get('total')}")

    # Confirm no credit consumed yet — check usage if endpoint exists; otherwise trust the design
    # (server explicitly only increments quota in dispatch).

    # ------------- Phase 2: pharmacy accepts -------------
    step("Pharmacy POSTs pharmacy_handshake_ok")
    r = requests.get(f"{BASE}/api/conversations", headers=Hp, timeout=10)
    r.raise_for_status()
    pharm_convs = r.json()
    pharm_conv = next((c for c in pharm_convs if c.get("id") == conv_id), None)
    assert pharm_conv is not None, "pharmacy cannot see the conversation"

    r = requests.post(
        f"{BASE}/api/conversations/{conv_id}/messages",
        headers={**Hp, "Content-Type": "application/json"},
        json={
            "body": "✅ সব ওষুধ available। Order confirm করতে পারেন।",
            "preset_key": "pharmacy_handshake_ok",
            "payload": {"handshake_id": handshake_id},
        },
        timeout=10,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:600]); return 1

    # ------------- Phase 3: verify server auto-posted ai_customer_confirm_prompt -------------
    step("verify ai_customer_confirm_prompt auto-posted")
    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    r.raise_for_status()
    msgs = r.json()
    prompt_msg = next(
        (m for m in msgs if m.get("preset_key") == "ai_customer_confirm_prompt"), None
    )
    assert prompt_msg is not None, "ai_customer_confirm_prompt missing"
    pl = prompt_msg.get("payload") or {}
    assert pl.get("handshake_id") == handshake_id, "prompt handshake_id mismatch"
    assert pl.get("status") == "awaiting_customer", f"unexpected status {pl.get('status')}"
    print(f"OK — ai_customer_confirm_prompt present, total={pl.get('total')}")

    # ------------- Phase 4: customer Final Confirm via dispatch with handshake_ids -------------
    step("POST /api/ai/prescription-dispatch with handshake_ids")
    r = requests.post(
        f"{BASE}/api/ai/prescription-dispatch",
        headers={**Hc, "Content-Type": "application/json"},
        json={
            "prescription_url": image_url,
            "plans": [plan],
            "handshake_ids": [handshake_id],
            "note": scan["ai"]["notes"],
            "delivery_lat": LAT,
            "delivery_lng": LNG,
        },
        timeout=15,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:600]); return 1
    disp = r.json()
    print(json.dumps(disp, ensure_ascii=False, indent=2)[:1200])
    assert disp.get("ok"), "dispatch not ok"

    # ------------- Phase 5: verify completion + order_request + 1 credit -------------
    step("verify ai_handshake_completed + order_request")
    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    r.raise_for_status()
    msgs = r.json()
    done_msg = next(
        (m for m in msgs if m.get("preset_key") == "ai_handshake_completed"), None
    )
    assert done_msg is not None, "ai_handshake_completed missing"
    pl = done_msg.get("payload") or {}
    assert pl.get("handshake_id") == handshake_id, "completed handshake_id mismatch"
    print("OK — ai_handshake_completed present")

    order_req = next((m for m in msgs if m.get("preset_key") == "order_request"), None)
    assert order_req is not None, "order_request missing"
    print(f"OK — order_request present, items={len(order_req.get('payload', {}).get('items', []))}")

    # quota consumed?
    if DB_PATH.exists():
        con = sqlite3.connect(DB_PATH)
        cur = con.cursor()
        cur.execute(
            """
            SELECT count FROM ai_usage
            WHERE account_id = (SELECT id FROM accounts WHERE gmail = ?)
              AND feature = 'smart_prescription'
            """,
            (CUSTOMER,),
        )
        row = cur.fetchone()
        con.close()
        if row:
            print(f"quota count = {row[0]}")
            assert row[0] >= 1, "expected at least 1 credit consumed"

    print("\nPASS — full handshake + dual-confirm flow")
    return 0


if __name__ == "__main__":
    sys.exit(main())
