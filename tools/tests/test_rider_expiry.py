"""
Phase 5 + 6 E2E:
  - Phase 5: when rider accepts an offer, MediAI auto-posts an
    `ai_rider_expiry_check` chat card tagging the rider to verify every
    medicine's expiry date before pickup.
  - Phase 6: simultaneously, MediAI posts an `ai_customer_location_prompt`
    card asking the customer to share live location for the rider.

Flow:
  1) Customer Smart Prescription scan + direct dispatch → real Order + Conv.
  2) Pharmacy confirm → packaging → ready.
  3) Seed a verified rider directly in SQLite, dev-login as rider, ping a
     position inside the 800m broadcast radius of the pharmacy.
  4) Pharmacy POST /me/orders/{id}/dispatch → expect ≥1 RiderOffer for rider.
  5) Rider POST /api/rider/offers/{offer_id}/accept.
  6) Read conversation messages and assert both `ai_rider_expiry_check` and
     `ai_customer_location_prompt` are present with valid payloads.
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import json
import sqlite3
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse

import requests


BASE = "http://localhost:8000"
IMG = ASSETS / "a.jpg"
DB_PATH = DB_PATH

LAT, LNG = 22.7009, 90.3676
CUSTOMER = "test.customer@medidoor.app"
RIDER_GMAIL = "test.rider@medidoor.app"


def step(t: str) -> None:
    print(f"\n=== {t} ===")


def reset_customer() -> None:
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
        if order_ids:
            ph = ",".join("?" * len(order_ids))
            cur.execute(f"DELETE FROM rider_offers WHERE order_id IN ({ph})", order_ids)
            cur.execute(f"DELETE FROM order_messages WHERE order_id IN ({ph})", order_ids)
            cur.execute(f"DELETE FROM orders WHERE id IN ({ph})", order_ids)
        if conv_ids:
            ph = ",".join("?" * len(conv_ids))
            cur.execute(f"DELETE FROM conversation_messages WHERE conversation_id IN ({ph})", conv_ids)
            cur.execute(f"DELETE FROM conversations WHERE id IN ({ph})", conv_ids)
        cur.execute(
            "UPDATE ai_usage SET count = 0 WHERE feature = 'smart_prescription' AND account_id = ?",
            (aid,),
        )
    con.commit()
    con.close()
    print("[reset] cleared prior customer orders")


def seed_rider() -> None:
    """Ensure a verified rider exists for RIDER_GMAIL.

    Account is created on first dev-login; this only attaches a rider_profile
    row + flips verified=true.
    """
    # dev-login first so the Account row exists.
    r = requests.post(
        f"{BASE}/api/auth/dev-login",
        json={"gmail": RIDER_GMAIL, "role": "rider"},
        timeout=10,
    )
    r.raise_for_status()

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("SELECT id FROM accounts WHERE gmail = ?", (RIDER_GMAIL,))
    row = cur.fetchone()
    assert row, "rider account missing after dev-login"
    aid = row[0]
    cur.execute("SELECT id FROM rider_profiles WHERE account_id = ?", (aid,))
    prof = cur.fetchone()
    if not prof:
        rpid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO rider_profiles
              (id, account_id, full_name, nick_name, phone_number, age,
               nid_number, is_verified)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (rpid, aid, "Test Rider", "TR", "+8801700000099", 28,
             f"NID-TR-{aid[:8]}"),
        )
        print(f"[seed] rider profile inserted ({rpid})")
    else:
        cur.execute(
            "UPDATE rider_profiles SET is_verified = 1, last_lat = NULL, last_lng = NULL WHERE id = ?",
            (prof[0],),
        )
        print(f"[seed] rider profile already exists, reset location")
    # Remove any stale offers for this rider.
    cur.execute("DELETE FROM rider_offers WHERE rider_id IN (SELECT id FROM rider_profiles WHERE account_id = ?)", (aid,))
    con.commit()
    con.close()


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


def pharmacy_latlng(pharmacy_id: str) -> tuple[float, float]:
    pid_no_dash = pharmacy_id.replace("-", "")
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(
        "SELECT lat, lng FROM pharmacy_profiles WHERE id = ? OR id = ?",
        (pharmacy_id, pid_no_dash),
    )
    row = cur.fetchone()
    con.close()
    assert row and row[0] is not None and row[1] is not None, "pharmacy has no location"
    return float(row[0]), float(row[1])


def login(gmail: str, role: str) -> str:
    r = requests.post(f"{BASE}/api/auth/dev-login", json={"gmail": gmail, "role": role}, timeout=10)
    r.raise_for_status()
    return r.json()["access_token"]


def main() -> int:
    if not IMG.exists():
        print(f"missing {IMG}")
        return 2

    reset_customer()
    seed_rider()

    step("dev-login customer + scan + dispatch")
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
    pharm_gmail = pharmacy_owner_gmail(p["pharmacy"]["id"])
    pharm_tok = login(pharm_gmail, "pharmacy")
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

    step("pharmacy confirm → packaging → ready")
    for endpoint, body in [
        (f"/api/pharmacy/me/orders/{order_id}/confirm", None),
        (f"/api/pharmacy/me/orders/{order_id}/status", {"status": "packaging"}),
        (f"/api/pharmacy/me/orders/{order_id}/status", {"status": "ready"}),
    ]:
        rr = requests.post(
            f"{BASE}{endpoint}",
            headers={**Hp, "Content-Type": "application/json"},
            json=body,
            timeout=10,
        )
        if rr.status_code >= 400:
            print(f"FAIL {endpoint}: {rr.text[:300]}")
            return 1
    print("OK — order ready")

    step("rider pings location inside pharmacy 800m radius")
    rider_tok = login(RIDER_GMAIL, "rider")
    Hr = {"Authorization": f"Bearer {rider_tok}"}
    plat, plng = pharmacy_latlng(p["pharmacy"]["id"])
    # ~50m offset = well inside 800m
    rlat, rlng = plat + 0.0004, plng + 0.0004
    rr = requests.post(
        f"{BASE}/api/rider/me/ping",
        headers={**Hr, "Content-Type": "application/json"},
        json={"lat": rlat, "lng": rlng},
        timeout=10,
    )
    if rr.status_code >= 400:
        print(rr.text[:300]); return 1
    print(f"OK — rider pinged @ ({rlat:.5f},{rlng:.5f})")

    step("pharmacy dispatch — broadcasts to nearby riders")
    rr = requests.post(f"{BASE}/api/pharmacy/me/orders/{order_id}/dispatch", headers=Hp, timeout=10)
    if rr.status_code >= 400:
        print(f"status={rr.status_code}")
        Path("h:/MediDoor/_dispatch_err.txt").write_text(rr.text, encoding="utf-8")
        print(rr.text); return 1
    sent = rr.json().get("offers_sent", 0)
    print(f"OK — offers_sent={sent}")
    assert sent >= 1, f"expected ≥1 offer broadcast, got {sent}"

    step("rider lists offers + accepts")
    rr = requests.get(f"{BASE}/api/rider/offers", headers=Hr, timeout=10)
    rr.raise_for_status()
    offers = rr.json().get("offers") or rr.json().get("items") or []
    if isinstance(rr.json(), list):
        offers = rr.json()
    # try common shapes
    if isinstance(rr.json(), dict) and "offers" not in rr.json() and "items" not in rr.json():
        offers = list(rr.json().values())[0] if rr.json() else []
    assert offers, f"no offers found for rider: {rr.json()}"
    offer_id = offers[0]["id"] if isinstance(offers[0], dict) else offers[0]
    rr = requests.post(f"{BASE}/api/rider/offers/{offer_id}/accept", headers=Hr, timeout=10)
    if rr.status_code >= 400:
        print(rr.text[:400]); return 1
    print(f"OK — offer {offer_id} accepted")

    step("verify AI auto-posts both Phase 5 + Phase 6 cards in chat")
    rr = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    rr.raise_for_status()
    msgs = rr.json()
    expiry = next((m for m in msgs if m.get("preset_key") == "ai_rider_expiry_check"), None)
    locprompt = next((m for m in msgs if m.get("preset_key") == "ai_customer_location_prompt"), None)
    rider_joined = next((m for m in msgs if m.get("preset_key") == "rider_joined"), None)

    print(f"rider_joined present: {bool(rider_joined)}")
    print(f"ai_rider_expiry_check present: {bool(expiry)}")
    print(f"ai_customer_location_prompt present: {bool(locprompt)}")
    # Note: ai_rider_expiry_check has visibility=pharmacy_rider, so the
    # *customer* GET may not see it. Pull from pharmacy side to verify.
    rr = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hp, timeout=10)
    rr.raise_for_status()
    msgs_pharm = rr.json()
    expiry_pharm = next((m for m in msgs_pharm if m.get("preset_key") == "ai_rider_expiry_check"), None)
    assert expiry_pharm is not None, "ai_rider_expiry_check missing from pharmacy view"
    pl = expiry_pharm.get("payload") or {}
    assert pl.get("order_id") == str(order_id), "wrong order_id in expiry card"
    assert isinstance(pl.get("items"), list) and len(pl["items"]) > 0, "no items in expiry card"
    print(f"OK — expiry card has {len(pl['items'])} items: {pl['items'][:3]}")

    assert locprompt is not None, "ai_customer_location_prompt missing from customer view"
    lp = locprompt.get("payload") or {}
    assert lp.get("order_id") == str(order_id), "wrong order_id in location prompt"
    assert "rider_id" in lp, "rider_id missing in location prompt payload"
    print(f"OK — location prompt payload keys: {sorted(lp.keys())}")

    print("\nPASS — Phase 5 (expiry check) + Phase 6 (location prompt) auto-fire on rider accept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
