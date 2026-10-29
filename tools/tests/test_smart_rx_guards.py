"""Regression checks for Smart Prescription guard rails.

Verifies:
  1. A banned customer cannot start a pharmacy stock-check handshake.
  2. A just-confirmed handshake is not reused by the duplicate-handshake guard.
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests


BASE = "http://127.0.0.1:8000"
DB_PATH = DB_PATH
IMG = ASSETS / "a.jpg"

CUSTOMER = "test.customer@medidoor.app"
PHARMACY = "test.pharmacy@medidoor.app"
LAT, LNG = 22.7009, 90.3676


def step(title: str) -> None:
    print(f"\n=== {title} ===")


def db_exec(sql: str, args: tuple = ()) -> list[tuple]:
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(sql, args)
    rows = cur.fetchall()
    con.commit()
    con.close()
    return rows


def login(gmail: str, role: str) -> str:
    res = requests.post(
        f"{BASE}/api/auth/dev-login",
        json={"gmail": gmail, "role": role},
        timeout=10,
    )
    res.raise_for_status()
    return res.json()["access_token"]


def upload_rx(headers: dict[str, str]) -> str:
    with IMG.open("rb") as file_obj:
        res = requests.post(
            f"{BASE}/api/upload",
            headers=headers,
            files={"file": ("rx.jpg", file_obj, "image/jpeg")},
            timeout=20,
        )
    res.raise_for_status()
    url = res.json()["url"]
    return urlparse(url).path if url.startswith("http") else url


def make_plan(headers: dict[str, str]) -> dict:
    res = requests.get(
        f"{BASE}/api/storefront/nearby?lat={LAT}&lng={LNG}&radius_km=5",
        headers=headers,
        timeout=10,
    )
    res.raise_for_status()
    items = res.json().get("items") or []
    med = next(
        item for item in items
        if "test pharmacy" in (item.get("pharmacy", {}).get("name") or "").lower()
    )
    delivery_fee = float(med.get("delivery_fee") or 30)
    return {
        "pharmacy_id": med["pharmacy"]["id"],
        "items": [
            {
                "medicine_id": med["id"],
                "name": med["name"],
                "qty": 1,
                "unit_price": med["price"],
                "prescription_required": bool(med.get("prescription_required")),
                "rx_strength": "",
                "rx_instructions": "",
            }
        ],
        "subtotal": float(med["price"]),
        "delivery_fee": delivery_fee,
        "total": float(med["price"] + delivery_fee),
    }


def main() -> int:
    if not IMG.exists():
        print(f"missing {IMG}")
        return 2

    customer_rows = db_exec("SELECT id FROM accounts WHERE gmail = ?", (CUSTOMER,))
    if not customer_rows:
        print("missing test customer; run seed_test_accounts")
        return 2
    customer_id = customer_rows[0][0]

    db_exec(
        "UPDATE customer_profiles SET is_banned = 0, ban_notice = NULL WHERE account_id = ?",
        (customer_id,),
    )
    db_exec(
        "UPDATE ai_usage SET count = 0 WHERE account_id = ? AND feature = 'smart_prescription'",
        (customer_id,),
    )

    customer_token = login(CUSTOMER, "customer")
    pharmacy_token = login(PHARMACY, "pharmacy")
    customer_headers = {"Authorization": f"Bearer {customer_token}"}
    pharmacy_headers = {"Authorization": f"Bearer {pharmacy_token}"}
    image_url = upload_rx(customer_headers)
    plan = make_plan(customer_headers)

    step("banned customer cannot start handshake")
    db_exec(
        "UPDATE customer_profiles SET is_banned = 1, ban_notice = 'regression test' WHERE account_id = ?",
        (customer_id,),
    )
    try:
        res = requests.post(
            f"{BASE}/api/ai/prescription-handshake",
            headers={**customer_headers, "Content-Type": "application/json"},
            json={"prescription_url": image_url, "plans": [plan]},
            timeout=10,
        )
        print(f"status={res.status_code}")
        assert res.status_code == 423, res.text[:300]
    finally:
        db_exec(
            "UPDATE customer_profiles SET is_banned = 0, ban_notice = NULL WHERE account_id = ?",
            (customer_id,),
        )

    step("confirmed handshake is not reused")
    res = requests.post(
        f"{BASE}/api/ai/prescription-handshake",
        headers={**customer_headers, "Content-Type": "application/json"},
        json={
            "prescription_url": image_url,
            "plans": [plan],
            "delivery_lat": LAT,
            "delivery_lng": LNG,
        },
        timeout=10,
    )
    res.raise_for_status()
    first = res.json()
    conv_id = first["conversation_id"]
    first_handshake_id = first["handshake_id"]

    res = requests.post(
        f"{BASE}/api/conversations/{conv_id}/messages",
        headers={**pharmacy_headers, "Content-Type": "application/json"},
        json={
            "body": "ok",
            "preset_key": "pharmacy_handshake_ok",
            "payload": {"handshake_id": first_handshake_id},
        },
        timeout=10,
    )
    res.raise_for_status()

    res = requests.post(
        f"{BASE}/api/ai/prescription-dispatch",
        headers={**customer_headers, "Content-Type": "application/json"},
        json={
            "prescription_url": image_url,
            "plans": [plan],
            "handshake_ids": [first_handshake_id],
            "delivery_lat": LAT,
            "delivery_lng": LNG,
        },
        timeout=10,
    )
    res.raise_for_status()

    res = requests.post(
        f"{BASE}/api/ai/prescription-handshake",
        headers={**customer_headers, "Content-Type": "application/json"},
        json={
            "prescription_url": image_url,
            "plans": [plan],
            "delivery_lat": LAT,
            "delivery_lng": LNG,
        },
        timeout=10,
    )
    res.raise_for_status()
    second = res.json()
    duplicate = second["conversations"][0].get("duplicate")
    print(f"first={first_handshake_id}")
    print(f"second={second['handshake_id']} duplicate={duplicate}")
    assert second["handshake_id"] != first_handshake_id
    assert not duplicate

    print("\nPASS - Smart Rx guard regressions")
    return 0


if __name__ == "__main__":
    sys.exit(main())