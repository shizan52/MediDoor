"""
E2E: medi AI trigger boundary for reused customer/pharmacy conversations.

Rules verified:
  1. Manual order chats do not create proactive medi AI rows.
  2. Explicit @mediai mentions are allowed in manual chats, and only use
     the explicit `ai_reply` path when Gemini is available.
  3. Smart Prescription context may create a customer-only medi AI question.
  4. A later manual order_request in the same reused conversation disables
     the old Smart Prescription proactive context and hides stale inbox cards.
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import json
import os
import sqlite3
import sys
import uuid
from pathlib import Path
from typing import Any

import requests


BASE = os.environ.get("MEDIDOOR_TEST_BASE", "http://localhost:8000")
DB_PATH = DB_PATH

CUSTOMER = "test.customer@medidoor.app"
PHARMACY = "test.pharmacy@medidoor.app"

PROACTIVE_PRESETS = {
    "ai_proxy_reply",
    "ai_question_for_customer",
    "ai_addon_prompt",
}


def step(title: str) -> None:
    print(f"\n=== {title} ===")


def as_uuid(value: str) -> str:
    return str(uuid.UUID(str(value)))


def reset_test_data() -> None:
    if not DB_PATH.exists():
        return
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("SELECT id FROM accounts WHERE gmail IN (?, ?)", (CUSTOMER, PHARMACY))
    acct_ids = [row[0] for row in cur.fetchall()]
    if not acct_ids:
        con.close()
        return

    placeholders = ",".join("?" * len(acct_ids))
    cur.execute(
        f"SELECT id FROM conversations WHERE customer_account_id IN ({placeholders})",
        acct_ids,
    )
    conv_ids = [row[0] for row in cur.fetchall()]

    cur.execute(
        f"SELECT id FROM orders WHERE customer_account_id IN ({placeholders})",
        acct_ids,
    )
    order_ids = [row[0] for row in cur.fetchall()]

    if order_ids:
        order_placeholders = ",".join("?" * len(order_ids))
        cur.execute(f"DELETE FROM rider_offers WHERE order_id IN ({order_placeholders})", order_ids)
        cur.execute(f"DELETE FROM order_messages WHERE order_id IN ({order_placeholders})", order_ids)
        cur.execute(f"DELETE FROM orders WHERE id IN ({order_placeholders})", order_ids)
    if conv_ids:
        conv_placeholders = ",".join("?" * len(conv_ids))
        cur.execute(
            f"DELETE FROM conversation_messages WHERE conversation_id IN ({conv_placeholders})",
            conv_ids,
        )
        cur.execute(f"DELETE FROM conversations WHERE id IN ({conv_placeholders})", conv_ids)

    cur.execute(
        f"UPDATE ai_usage SET count = 0 WHERE feature = 'smart_prescription' AND account_id IN ({placeholders})",
        acct_ids,
    )
    con.commit()
    con.close()
    print("[reset] cleared prior test conversations/orders")


def http(method: str, path: str, token: str | None = None, **kwargs: Any) -> requests.Response:
    headers = kwargs.pop("headers", {})
    headers.setdefault("Accept", "application/json")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = requests.request(method, f"{BASE}{path}", headers=headers, timeout=30, **kwargs)
    return response


def json_or_text(response: requests.Response) -> Any:
    try:
        return response.json()
    except Exception:
        return response.text


def require_ok(response: requests.Response, label: str) -> Any:
    if response.status_code >= 400:
        raise AssertionError(f"{label} failed: {response.status_code} {response.text[:500]}")
    return json_or_text(response)


def login(gmail: str, role: str) -> str:
    data = require_ok(
        http("POST", "/api/auth/dev-login", json={"gmail": gmail, "role": role}),
        f"login {gmail}",
    )
    return data["access_token"]


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
        raise RuntimeError("test pharmacy profile missing; run python -m app.db.seed_test_accounts")
    return as_uuid(row[0])


def start_conversation(customer_token: str, pharmacy_id: str) -> str:
    data = require_ok(
        http("POST", "/api/conversations", token=customer_token, json={"pharmacy_id": pharmacy_id}),
        "start conversation",
    )
    return data["id"]


def send(token: str, conv_id: str, body: dict[str, Any]) -> dict[str, Any]:
    return require_ok(
        http("POST", f"/api/conversations/{conv_id}/messages", token=token, json=body),
        f"send {body.get('preset_key') or 'text'}",
    )


def messages(token: str, conv_id: str) -> list[dict[str, Any]]:
    return require_ok(
        http("GET", f"/api/conversations/{conv_id}/messages", token=token),
        "list messages",
    )


def ai_questions(token: str) -> list[dict[str, Any]]:
    return require_ok(
        http("GET", "/api/conversations/ai-proxy-questions", token=token),
        "list ai questions",
    )


def new_messages(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = {row["id"] for row in before}
    return [row for row in after if row["id"] not in seen]


def presets(rows: list[dict[str, Any]]) -> list[str | None]:
    return [row.get("preset_key") for row in rows]


def assert_no_proactive(rows: list[dict[str, Any]], label: str) -> None:
    leaked = [row for row in rows if row.get("preset_key") in PROACTIVE_PRESETS]
    if leaked:
        found = [(row.get("preset_key"), row.get("body", "")[:80]) for row in leaked]
        raise AssertionError(f"{label}: proactive medi AI leaked: {found}")
    print(f"OK - {label}: no proactive medi AI rows")


def order_payload(source: str, name: str) -> dict[str, Any]:
    return {
        "source": source,
        "items": [{"name": name, "qty": 1, "unit_price": 10}],
        "subtotal": 10,
        "delivery_fee": 30,
        "total": 40,
        "note": f"{source} boundary test",
        "delivery_address": "Test Customer Address",
        "delivery_lat": 22.7009,
        "delivery_lng": 90.3676,
    }


def post_order_request(token: str, conv_id: str, source: str, name: str) -> None:
    send(
        token,
        conv_id,
        {
            "body": f"Order request: {name}",
            "preset_key": "order_request",
            "payload": order_payload(source, name),
        },
    )


def main() -> int:
    reset_test_data()

    step("login + start reused conversation")
    customer_token = login(CUSTOMER, "customer")
    pharmacy_token = login(PHARMACY, "pharmacy")
    pharmacy_id = pharmacy_id_for(PHARMACY)
    conv_id = start_conversation(customer_token, pharmacy_id)
    print(f"conversation = {conv_id}")

    step("manual order stays silent")
    post_order_request(customer_token, conv_id, "manual", "Napa 500")
    before = messages(customer_token, conv_id)
    send(pharmacy_token, conv_id, {"body": "fever koto din?"})
    send(pharmacy_token, conv_id, {"body": "anything else lagbe?"})
    after = messages(customer_token, conv_id)
    manual_new = new_messages(before, after)
    print("new presets:", presets(manual_new))
    assert_no_proactive(manual_new, "manual order")
    manual_questions = [q for q in ai_questions(customer_token) if q.get("conversation_id") == conv_id]
    assert not manual_questions, "manual order exposed ai-proxy questions"
    print("OK - manual order has no medi AI inbox card")

    step("explicit @mediai mention uses only explicit path")
    before = messages(customer_token, conv_id)
    send(pharmacy_token, conv_id, {"body": "@mediai Napa 500 ki kaje lage?"})
    after = messages(customer_token, conv_id)
    mention_new = new_messages(before, after)
    mention_presets = presets(mention_new)
    print("new presets:", mention_presets)
    assert_no_proactive(mention_new, "explicit @mediai mention")
    if "ai_reply" in mention_presets:
        print("OK - explicit @mediai produced ai_reply")
    else:
        print("OK - explicit @mediai accepted; Gemini unavailable/no ai_reply in this environment")

    step("Smart Prescription may ask customer privately")
    post_order_request(customer_token, conv_id, "ai_prescription", "Smart Rx Napa 500")
    before = messages(customer_token, conv_id)
    send(pharmacy_token, conv_id, {"body": "fever koto din?"})
    after_customer = messages(customer_token, conv_id)
    smart_new = new_messages(before, after_customer)
    print("new presets:", presets(smart_new))
    question = next((row for row in smart_new if row.get("preset_key") == "ai_question_for_customer"), None)
    assert question is not None, "Smart Rx context did not create customer-only AI question"
    assert question.get("visibility") == "customer_only", "AI question is not customer_only"
    after_pharmacy = messages(pharmacy_token, conv_id)
    assert question["id"] not in {row["id"] for row in after_pharmacy}, "pharmacy can see customer-only AI question"
    active_questions = [q for q in ai_questions(customer_token) if q.get("conversation_id") == conv_id]
    assert active_questions, "Smart Rx AI question missing from customer inbox"
    print("OK - Smart Rx question is customer-only and appears in inbox")

    step("later manual order disables old Smart Rx context")
    post_order_request(customer_token, conv_id, "manual", "Manual Seclo 20")
    before = messages(customer_token, conv_id)
    send(pharmacy_token, conv_id, {"body": "price kom dile hobe?"})
    send(pharmacy_token, conv_id, {"body": "anything else?"})
    after = messages(customer_token, conv_id)
    override_new = new_messages(before, after)
    print("new presets:", presets(override_new))
    assert_no_proactive(override_new, "manual override after Smart Rx")
    stale_questions = [q for q in ai_questions(customer_token) if q.get("conversation_id") == conv_id]
    assert not stale_questions, "later manual order did not hide stale Smart Rx AI inbox cards"
    print("OK - later manual order hides stale medi AI inbox cards")

    print("\nPASS - medi AI boundary invariant holds")
    return 0


if __name__ == "__main__":
    sys.exit(main())