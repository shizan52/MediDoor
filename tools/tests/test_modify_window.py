"""
Phase 4 E2E: pre-packaging order modify window.

Flow:
  1) Customer Smart Prescription handshake + dispatch → real Order created.
  2) Pharmacy POST /api/pharmacy/me/orders/{id}/confirm
     → expect ai_modify_window_open chat card.
  3) Customer POST /api/customer/me/orders/{id}/modify with new qty
     → expect 200 + ai_order_modified chat card + Order totals updated.
  4) Pharmacy POST /api/pharmacy/me/orders/{id}/status {status:"packaging"}
     → expect ai_modify_window_closed chat card.
  5) Second modify attempt → expect 409.
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests


BASE = "http://localhost:8000"
IMG = ASSETS / "a.jpg"
DB_PATH = DB_PATH

LAT, LNG = 22.7009, 90.3676
CUSTOMER = "test.customer@medidoor.app"


def step(t: str) -> None:
    print(f"\n=== {t} ===")


def reset() -> None:
    if not DB_PATH.exists():
        return
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("SELECT id FROM accounts WHERE gmail = ?", (CUSTOMER,))
    row = cur.fetchone()
    if row:
        aid = row[0]
        cur.execute("SELECT id FROM conversations WHERE customer_account_id = ?", (aid,))
        conv_ids = [r[0] for r in cur.fetchall()]
        cur.execute("SELECT id FROM orders WHERE customer_account_id = ?", (aid,))
        order_ids = [r[0] for r in cur.fetchall()]
        if conv_ids:
            ph = ",".join("?" * len(conv_ids))
            cur.execute(f"DELETE FROM conversation_messages WHERE conversation_id IN ({ph})", conv_ids)
        if order_ids:
            ph = ",".join("?" * len(order_ids))
            cur.execute(f"DELETE FROM order_messages WHERE order_id IN ({ph})", order_ids)
            cur.execute(f"DELETE FROM orders WHERE id IN ({ph})", order_ids)
        if conv_ids:
            ph = ",".join("?" * len(conv_ids))
            cur.execute(f"DELETE FROM conversations WHERE id IN ({ph})", conv_ids)
        cur.execute(
            "UPDATE ai_usage SET count = 0 WHERE feature = 'smart_prescription' AND account_id = ?",
            (aid,),
        )
    con.commit()
    con.close()
    print("[reset] cleared prior data")


def pharmacy_owner_gmail(pharmacy_id: str) -> str:
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
        raise RuntimeError(f"no owner for pharmacy {pharmacy_id}")
    return row[0]


def login(gmail: str, role: str) -> str:
    r = requests.post(f"{BASE}/api/auth/dev-login", json={"gmail": gmail, "role": role}, timeout=10)
    r.raise_for_status()
    return r.json()["access_token"]


def main() -> int:
    if not IMG.exists():
        print(f"missing {IMG}")
        return 2
    reset()

    step("dev-login customer + scan + handshake + dispatch")
    cust_tok = login(CUSTOMER, "customer")
    Hc = {"Authorization": f"Bearer {cust_tok}"}

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

    r = requests.post(
        f"{BASE}/api/ai/prescription-scan",
        headers={**Hc, "Content-Type": "application/json"},
        json={"image_url": image_url, "lat": LAT, "lng": LNG, "radius_km": 4.0},
        timeout=60,
    )
    r.raise_for_status()
    scan = r.json()
    if not scan.get("ok") or not scan["proposals"]:
        print(f"scan failed: {scan.get('code')} {scan.get('message')}")
        return 1
    p = scan["proposals"][0]
    pharm_tok = login(pharmacy_owner_gmail(p["pharmacy"]["id"]), "pharmacy")
    Hp = {"Authorization": f"Bearer {pharm_tok}"}

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

    # Direct dispatch (skip handshake — phase 1 already covers that path)
    r = requests.post(
        f"{BASE}/api/ai/prescription-dispatch",
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
    if r.status_code >= 400:
        print(r.text[:600]); return 1
    disp = r.json()
    conv_id = disp["conversation_id"]
    order_id = disp.get("order_id") or (disp.get("dispatched") or [{}])[0].get("order_id")
    assert order_id, "no order_id"
    print(f"order_id={order_id} conv={conv_id}")

    step("pharmacy confirms order → expect ai_modify_window_open card")
    r = requests.post(f"{BASE}/api/pharmacy/me/orders/{order_id}/confirm", headers=Hp, timeout=10)
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:600]); return 1

    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    r.raise_for_status()
    msgs = r.json()
    open_msg = next((m for m in msgs if m.get("preset_key") == "ai_modify_window_open"), None)
    assert open_msg is not None, "ai_modify_window_open missing"
    pl = open_msg.get("payload") or {}
    assert pl.get("order_id") == str(order_id), "order_id mismatch in open card"
    assert isinstance(pl.get("items"), list) and len(pl["items"]) > 0, "no items in card"
    print(f"OK — modify_window_open present, {len(pl['items'])} items, total={pl.get('total')}")

    step("customer modifies — bumps qty of first item by +1")
    new_items = []
    for it in items:
        copy = dict(it)
        new_items.append(copy)
    new_items[0]["qty"] = int(new_items[0]["qty"]) + 1
    modify_payload = {
        "items": [{"medicine_id": it["medicine_id"], "qty": it["qty"]} for it in new_items],
        "note": "একটা extra strip দিন please",
    }
    r = requests.post(
        f"{BASE}/api/customer/me/orders/{order_id}/modify",
        headers={**Hc, "Content-Type": "application/json"},
        json=modify_payload,
        timeout=10,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:600]); return 1
    mod = r.json()
    print(f"new total = {mod.get('total')} (was {p['total']}); changed={len(mod.get('changed', []))}")
    assert mod.get("ok"), "modify not ok"
    assert mod["total"] != p["total"], "total did not change after modify"

    step("verify ai_order_modified chat card present")
    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    r.raise_for_status()
    msgs = r.json()
    modi_msg = next((m for m in msgs if m.get("preset_key") == "ai_order_modified"), None)
    assert modi_msg is not None, "ai_order_modified missing"
    print(f"OK — ai_order_modified present, total={modi_msg.get('payload', {}).get('total')}")

    step("pharmacy moves to packaging → expect ai_modify_window_closed")
    r = requests.post(
        f"{BASE}/api/pharmacy/me/orders/{order_id}/status",
        headers={**Hp, "Content-Type": "application/json"},
        json={"status": "packaging"},
        timeout=10,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:600]); return 1

    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    r.raise_for_status()
    msgs = r.json()
    closed_msg = next((m for m in msgs if m.get("preset_key") == "ai_modify_window_closed"), None)
    assert closed_msg is not None, "ai_modify_window_closed missing"
    print("OK — modify_window_closed present")

    step("second modify attempt should be rejected (409)")
    r = requests.post(
        f"{BASE}/api/customer/me/orders/{order_id}/modify",
        headers={**Hc, "Content-Type": "application/json"},
        json=modify_payload,
        timeout=10,
    )
    print(f"status={r.status_code}")
    assert r.status_code == 409, f"expected 409 after packaging, got {r.status_code}"
    print(f"OK — modify blocked: {r.json().get('detail', '')[:120]}")

    print("\nPASS — pre-packaging modify window flow")
    return 0


if __name__ == "__main__":
    sys.exit(main())
