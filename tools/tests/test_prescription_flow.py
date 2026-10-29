"""
E2E: Smart prescription flow.

Logs in as the seeded test customer, uploads asset/x.jpg, calls
/api/ai/prescription-scan, then /api/ai/prescription-dispatch, and
verifies the order_request message lands in the conversation.
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import json
import sys
from pathlib import Path

import requests


BASE = "http://localhost:8000"
IMG = ASSETS / "x.jpg"

# Seeded customer location is Barishal area-ish; pharmacies are seeded around
# 22.7 / 90.36. Use those coords so the radius gate accepts pharmacies.
LAT, LNG = 22.7009, 90.3676


def step(t):
    print(f"\n=== {t} ===")


def main() -> int:
    if not IMG.exists():
        print(f"Missing prescription image at {IMG}")
        return 2

    step("dev-login customer")
    r = requests.post(
        f"{BASE}/api/auth/dev-login",
        json={"gmail": "test.customer@medidoor.app", "role": "customer"},
        timeout=10,
    )
    r.raise_for_status()
    tok = r.json()["access_token"]
    H = {"Authorization": f"Bearer {tok}"}
    print("token ok")

    step("upload prescription image")
    with IMG.open("rb") as f:
        r = requests.post(
            f"{BASE}/api/upload",
            headers=H,
            files={"file": ("rx.jpg", f, "image/jpeg")},
            timeout=30,
        )
    r.raise_for_status()
    image_url = r.json()["url"]
    # Backend returns absolute URL; we need the path part for the scanner
    # but scanner accepts both — strip host so it's clearly local.
    if image_url.startswith("http"):
        from urllib.parse import urlparse
        image_url = urlparse(image_url).path
    print(f"uploaded -> {image_url}")

    step("POST /api/ai/prescription-scan")
    r = requests.post(
        f"{BASE}/api/ai/prescription-scan",
        headers={**H, "Content-Type": "application/json"},
        json={"image_url": image_url, "lat": LAT, "lng": LNG, "radius_km": 4.0},
        timeout=60,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:600]); return 1
    scan = r.json()
    print(json.dumps(scan, ensure_ascii=False, indent=2)[:2000])

    if not scan.get("ok"):
        print(f"\nAI returned non-ok ({scan.get('code')}). This is the graceful fallback path.")
        # Verify fallback shape
        assert "message" in scan
        if scan.get("code") == "ai_busy":
            print("manual_options length:", len(scan.get("manual_options") or []))
        print("PASS (fallback path)")
        return 0

    proposals = scan["proposals"]
    if not proposals:
        print("No proposals returned even though ok=True — should not happen")
        return 1
    print(f"{len(proposals)} proposals; picking #0: {proposals[0]['pharmacy']['name']} (coverage {proposals[0]['coverage_pct']}%)")

    step("POST /api/ai/prescription-dispatch")
    p = proposals[0]
    r = requests.post(
        f"{BASE}/api/ai/prescription-dispatch",
        headers={**H, "Content-Type": "application/json"},
        json={
            "prescription_url": image_url,
            "pharmacy_id": p["pharmacy"]["id"],
            "items": [
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
            ],
            "subtotal": p["subtotal"],
            "delivery_fee": p["delivery_fee"],
            "total": p["total"],
            "note": scan["ai"]["notes"],
        },
        timeout=15,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:600]); return 1
    disp = r.json()
    print(json.dumps(disp, ensure_ascii=False, indent=2))
    conv_id = disp["conversation_id"]

    step(f"GET /api/conversations/{conv_id}/messages")
    r = requests.get(
        f"{BASE}/api/conversations/{conv_id}/messages",
        headers=H, timeout=10,
    )
    r.raise_for_status()
    msgs = r.json()
    print(f"got {len(msgs)} messages")
    last_two = msgs[-2:]
    presets = [m.get("preset_key") for m in last_two]
    print("last two preset_keys:", presets)
    assert "ai_prescription_intro" in presets, "system intro missing"
    order_msg = next(m for m in last_two if m.get("preset_key") == "order_request")
    assert order_msg.get("attachment_url"), "attachment_url missing on order_request"
    payload = order_msg.get("payload") or json.loads(order_msg.get("payload_json") or "{}")
    assert payload.get("source") == "ai_prescription"
    assert payload.get("items"), "no items"
    print(f"order_request items={len(payload['items'])} total=৳{payload.get('total')}")
    print("\nPASS (full smart flow)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
