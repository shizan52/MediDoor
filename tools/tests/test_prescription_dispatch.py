"""
Verifies the /prescription-dispatch endpoint with a synthetic order built
from real seeded medicines (so it doesn't depend on the AI happy path).
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import io, json, sys
from pathlib import Path
import requests

BASE = "http://localhost:8000"
IMG = ASSETS / "x.jpg"


def main() -> int:
    r = requests.post(f"{BASE}/api/auth/dev-login",
                      json={"gmail": "test.customer@medidoor.app", "role": "customer"},
                      timeout=10)
    r.raise_for_status()
    H = {"Authorization": f"Bearer {r.json()['access_token']}"}

    with IMG.open("rb") as f:
        r = requests.post(f"{BASE}/api/upload", headers=H,
                          files={"file": ("rx.jpg", f, "image/jpeg")}, timeout=15)
    r.raise_for_status()
    image_url = r.json()["url"]
    from urllib.parse import urlparse
    if image_url.startswith("http"):
        image_url = urlparse(image_url).path
    print(f"Uploaded: {image_url}")

    # Pick a real medicine + its pharmacy from the storefront
    r = requests.get(f"{BASE}/api/storefront/nearby?lat=22.7009&lng=90.3676&radius_km=5",
                     headers=H, timeout=10)
    r.raise_for_status()
    data = r.json()
    items = data.get("items") or []
    if not items:
        print("No storefront items"); return 1
    med = items[0]
    print(f"Using med: {med['name']} from pharmacy {med['pharmacy']['name']}")

    body = {
        "prescription_url": image_url,
        "pharmacy_id": med["pharmacy"]["id"],
        "items": [{
            "medicine_id": med["id"],
            "name": med["name"],
            "qty": 2,
            "unit_price": med["price"],
            "prescription_required": med.get("prescription_required", False),
            "rx_strength": "500 mg",
            "rx_instructions": "1+0+1, খাবার পরে",
        }],
        "subtotal": med["price"] * 2,
        "delivery_fee": 30.0,
        "total": med["price"] * 2 + 30.0,
        "note": "AI-generated test dispatch",
    }
    r = requests.post(f"{BASE}/api/ai/prescription-dispatch", headers=H, json=body, timeout=15)
    print(f"dispatch status={r.status_code}")
    if r.status_code >= 400:
        print(r.text); return 1
    disp = r.json()
    print(json.dumps(disp, ensure_ascii=False, indent=2))

    conv_id = disp["conversation_id"]
    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=H, timeout=10)
    r.raise_for_status()
    msgs = r.json()
    presets = [m.get("preset_key") for m in msgs[-2:]]
    print(f"last 2 preset_keys: {presets}")
    assert "ai_prescription_intro" in presets, "system intro missing"
    order = next(m for m in msgs[-2:] if m.get("preset_key") == "order_request")
    assert order.get("attachment_url"), "attachment missing"
    p = order.get("payload") or json.loads(order.get("payload_json") or "{}")
    assert p.get("source") == "ai_prescription", f"unexpected payload: {p}"
    print(f"PASS — items={len(p['items'])} total=৳{p['total']} attachment={order['attachment_url']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
