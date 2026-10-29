"""
End-to-end smoke test for the new pharmacy publish flow + MediAI inbox.

Hits the running dev backend at http://localhost:8000.
Run with: python tools/test_publish_flow.py
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import json
import sys
import time
from pathlib import Path

import requests

BASE = "http://localhost:8000"
ASSET = ASSETS / "x.jpg"
PHARM_EMAIL = "test.pharmacy@medidoor.app"
CUST_EMAIL = "test.customer@medidoor.app"


def hr(t: str) -> None:
    print(f"\n{'=' * 6} {t} {'=' * (60 - len(t))}")


def dev_login(email: str, role: str) -> str:
    r = requests.post(
        f"{BASE}/api/auth/dev-login",
        json={"gmail": email, "role": role},
        timeout=15,
    )
    r.raise_for_status()
    tok = r.json()["access_token"]
    print(f"  ✓ dev-login {email} ({role}): token …{tok[-10:]}")
    return tok


def auth(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def upload(tok: str, path: Path) -> str:
    with path.open("rb") as f:
        r = requests.post(
            f"{BASE}/api/upload",
            files={"file": (path.name, f, "image/jpeg")},
            headers=auth(tok),
            timeout=30,
        )
    r.raise_for_status()
    url = r.json()["url"]
    print(f"  ✓ uploaded {path.name} → {url}")
    return url


def publish(tok: str, payload: dict) -> requests.Response:
    return requests.post(
        f"{BASE}/api/pharmacy/me/medicines",
        json=payload,
        headers={**auth(tok), "Content-Type": "application/json"},
        timeout=60,  # vision call
    )


def main() -> int:
    if not ASSET.exists():
        print(f"missing asset {ASSET}")
        return 2

    hr("LOGIN PHARMACY")
    p_tok = dev_login(PHARM_EMAIL, "pharmacy")

    hr("UPLOAD product image")
    img = upload(p_tok, ASSET)

    hr("CASE 1 — publish WITHOUT image must 400")
    r = publish(p_tok, {"name": "Napa 500mg", "price": 8, "stock": 50, "image_url": ""})
    print(f"  status={r.status_code} body={r.text[:200]}")
    assert r.status_code in (400, 422), "expected 400/422 for missing image"
    print("  ✓ blocked as expected")

    hr("CASE 2 — publish WITH image, blank short_desc + blank category")
    r = publish(p_tok, {
        "name": "Napa 500mg",
        "image_url": img,
        "price": 8,
        "stock": 100,
    })
    print(f"  status={r.status_code}")
    if r.status_code != 201:
        print(f"  body={r.text[:600]}")
        return 1
    m1 = r.json()
    print(f"  → id={m1['id']}, verdict={m1['approval_status']}")
    print(f"  → short_description = {m1.get('short_description')!r}")
    print(f"  → category          = {m1.get('category')!r}")
    print(f"  → AI reason         = {m1.get('approval_reason')!r}")

    hr("CASE 3 — publish WITH intentionally mismatched category")
    r = publish(p_tok, {
        "name": "Napa 500mg",
        "image_url": img,
        "short_description": "ব্যথা ও জ্বরের জন্য",
        "category": "Sunscreen (SPF)",  # obviously wrong
        "price": 8,
        "stock": 50,
    })
    print(f"  status={r.status_code}")
    if r.status_code != 201:
        print(f"  body={r.text[:400]}")
    else:
        m2 = r.json()
        print(f"  → verdict={m2['approval_status']} category={m2.get('category')!r}")

    hr("LIST notifications (should have ≥0; advice if AI flagged mismatch)")
    r = requests.get(f"{BASE}/api/pharmacy/me/notifications", headers=auth(p_tok), timeout=10)
    r.raise_for_status()
    notif = r.json()
    print(f"  unread={notif['unread']}, items={len(notif['items'])}")
    for n in notif["items"][:5]:
        print(f"    • [{n['kind']}] {n['title']}")
        print(f"      {n['body_bn'][:140]}")
        if n.get("payload"):
            print(f"      payload={json.dumps(n['payload'], ensure_ascii=False)[:200]}")

    hr("CATALOGUE search ?q=Pain")
    r = requests.get(f"{BASE}/api/pharmacy/categories/presets?q=pain", timeout=10)
    r.raise_for_status()
    cats = r.json()["items"]
    print(f"  {len(cats)} hits: {[c['name'] for c in cats[:5]]}")
    assert any("pain" in c["name"].lower() for c in cats), "expected pain match"
    print("  ✓ catalogue search works")

    hr("CATALOGUE empty q (top of list)")
    r = requests.get(f"{BASE}/api/pharmacy/categories/presets", timeout=10)
    r.raise_for_status()
    print(f"  {len(r.json()['items'])} total catalogue rows")

    hr("LOGIN CUSTOMER + smart-prescription with x.jpg")
    c_tok = dev_login(CUST_EMAIL, "customer")
    rx_url = upload(c_tok, ASSET)
    r = requests.post(
        f"{BASE}/api/ai/prescription-scan",
        json={"image_url": rx_url, "lat": 22.7009, "lng": 90.3676, "radius_km": 4.0},
        headers={**auth(c_tok), "Content-Type": "application/json"},
        timeout=60,
    )
    print(f"  status={r.status_code}")
    body = r.json()
    if body.get("ok"):
        ai = body.get("ai", {})
        print(f"  ✓ prescription parsed — {len(ai.get('medicines') or [])} medicines")
        for m in (ai.get("medicines") or [])[:5]:
            print(f"    • {m.get('generic_or_brand_name')} {m.get('strength')} qty={m.get('quantity')}")
        print(f"  proposals: {len(body.get('proposals') or [])}")
    else:
        print(f"  ⚠ {body.get('code')}: {body.get('message','')[:200]}")

    print("\n=== DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
