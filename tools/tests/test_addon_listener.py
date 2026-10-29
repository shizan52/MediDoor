"""
E2E: Phase 3 — Smart Prescription-only AI proactive add-on listener.

1. Customer + pharmacy share a conversation (start fresh).
2. Pharmacy asks "আর কিছু নিবেন?" in a manual chat: server must stay silent.
3. Customer posts a Smart Prescription order_request context.
4. Pharmacy asks again: server may auto-post an `ai_addon_prompt` system card.
5. Customer hits /api/ai/addon-suggest and posts `ai_addon_suggestion` card
    with items from the pharmacy's catalog (mirrors what the chat UI does).
6. Re-trigger from pharmacy a second time within window — server must NOT
    double-post (anti-spam).
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import json
import sqlite3
import sys
from pathlib import Path

import requests


BASE = "http://localhost:8000"
DB_PATH = DB_PATH

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
        ph = ",".join("?" * len(acct_ids))
        cur.execute(
            f"SELECT id FROM conversations WHERE customer_account_id IN ({ph})",
            acct_ids,
        )
        conv_ids = [r[0] for r in cur.fetchall()]
        if conv_ids:
            ph2 = ",".join("?" * len(conv_ids))
            cur.execute(
                f"DELETE FROM conversation_messages WHERE conversation_id IN ({ph2})",
                conv_ids,
            )
            cur.execute(f"DELETE FROM conversations WHERE id IN ({ph2})", conv_ids)
    con.commit()
    con.close()
    print("[reset] cleared prior conversations for test users")


def login(gmail: str, role: str) -> str:
    r = requests.post(
        f"{BASE}/api/auth/dev-login", json={"gmail": gmail, "role": role}, timeout=10
    )
    r.raise_for_status()
    return r.json()["access_token"]


def pharmacy_id_for(gmail: str) -> str:
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(
        """
        SELECT pp.id FROM pharmacy_profiles pp
        JOIN accounts a ON a.id = pp.account_id
        WHERE a.gmail = ?
        """,
        (gmail,),
    )
    row = cur.fetchone()
    con.close()
    if not row:
        raise RuntimeError(f"no pharmacy for {gmail}")
    import uuid as _uuid
    return str(_uuid.UUID(row[0]))


def main() -> int:
    reset_test_data()

    step("dev-login customer + pharmacy")
    cust_tok = login(CUSTOMER, "customer")
    pharm_tok = login(PHARMACY, "pharmacy")
    Hc = {"Authorization": f"Bearer {cust_tok}"}
    Hp = {"Authorization": f"Bearer {pharm_tok}"}
    print("tokens ok")

    pharm_id = pharmacy_id_for(PHARMACY)
    print(f"pharmacy_id = {pharm_id}")

    step("customer starts conversation with pharmacy")
    r = requests.post(
        f"{BASE}/api/conversations",
        headers={**Hc, "Content-Type": "application/json"},
        json={"pharmacy_id": pharm_id},
        timeout=10,
    )
    r.raise_for_status()
    conv = r.json()
    conv_id = conv["id"]
    print(f"conv = {conv_id}")

    step("manual chat: add-on inquiry must stay silent")
    r = requests.post(
        f"{BASE}/api/conversations/{conv_id}/messages",
        headers={**Hp, "Content-Type": "application/json"},
        json={"body": "ধন্যবাদ। আর কিছু নিবেন?"},
        timeout=10,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:400])
        return 1

    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    r.raise_for_status()
    msgs = r.json()
    prompt_count = sum(1 for m in msgs if m.get("preset_key") == "ai_addon_prompt")
    print(f"manual ai_addon_prompt count = {prompt_count}")
    assert prompt_count == 0, "manual order/chat must not create ai_addon_prompt"

    step("customer creates Smart Prescription context")
    r = requests.post(
        f"{BASE}/api/conversations/{conv_id}/messages",
        headers={**Hc, "Content-Type": "application/json"},
        json={
            "body": "Smart Prescription test order",
            "preset_key": "order_request",
            "payload": {
                "source": "ai_prescription",
                "items": [{"name": "Napa 500", "qty": 1, "unit_price": 10}],
                "subtotal": 10,
                "delivery_fee": 30,
                "total": 40,
                "delivery_address": "Test Customer Address",
                "delivery_lat": 22.7009,
                "delivery_lng": 90.3676,
            },
        },
        timeout=10,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:400])
        return 1

    step("Smart Rx: pharmacy posts free-form add-on inquiry")
    r = requests.post(
        f"{BASE}/api/conversations/{conv_id}/messages",
        headers={**Hp, "Content-Type": "application/json"},
        json={"body": "ধন্যবাদ। আর কিছু নিবেন?"},
        timeout=10,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:400])
        return 1

    step("verify ai_addon_prompt auto-posted")
    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    r.raise_for_status()
    msgs = r.json()
    prompt = next((m for m in msgs if m.get("preset_key") == "ai_addon_prompt"), None)
    assert prompt is not None, "ai_addon_prompt missing"
    pl = prompt.get("payload") or {}
    assert pl.get("pharmacy_id"), "prompt missing pharmacy_id"
    assert "আর কিছু" in (pl.get("pharmacy_question") or ""), "pharmacy_question missing/wrong"
    print(f"OK — ai_addon_prompt present, question={pl.get('pharmacy_question')!r}")

    step("customer calls /api/ai/addon-suggest")
    r = requests.post(
        f"{BASE}/api/ai/addon-suggest",
        headers={**Hc, "Content-Type": "application/json"},
        json={"conversation_id": conv_id, "limit": 6},
        timeout=15,
    )
    print(f"status={r.status_code}")
    if r.status_code >= 400:
        print(r.text[:400])
        return 1
    sug = r.json()
    print(json.dumps(sug, ensure_ascii=False, indent=2)[:600])
    assert sug.get("ok"), "addon-suggest not ok"
    items = sug.get("items") or []
    print(f"got {len(items)} suggested items")
    # test.pharmacy may have 0 catalog items — that's ok (empty array is valid).

    step("anti-spam: pharmacy asks again — should NOT double-prompt")
    r = requests.post(
        f"{BASE}/api/conversations/{conv_id}/messages",
        headers={**Hp, "Content-Type": "application/json"},
        json={"body": "আর কিছু নিবেন? Insulin আছে আমার কাছে।"},
        timeout=10,
    )
    print(f"status={r.status_code}")
    r.raise_for_status()
    r = requests.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=Hc, timeout=10)
    msgs = r.json()
    prompt_count = sum(1 for m in msgs if m.get("preset_key") == "ai_addon_prompt")
    print(f"ai_addon_prompt count after second trigger = {prompt_count}")
    assert prompt_count == 1, f"expected 1 prompt (anti-spam), got {prompt_count}"

    print("\nPASS — proactive add-on listener flow")
    return 0


if __name__ == "__main__":
    sys.exit(main())
