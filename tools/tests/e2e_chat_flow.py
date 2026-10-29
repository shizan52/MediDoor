"""End-to-end test of the chat-driven order/rider workflow.

Drives the real HTTP API as the 3 seeded test users:
  test.customer@medidoor.app
  test.pharmacy@medidoor.app
  test.rider@medidoor.app

Reports any unexpected status / missing data so the dev can fix.
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import httpx

BASE = os.environ.get("MEDIDOOR_TEST_BASE", "http://localhost:8000")
DB_PATH = Path(__file__).resolve().parent.parent / "backend" / "medidoor.db"

CUSTOMER = "test.customer@medidoor.app"
PHARMACY = "test.pharmacy@medidoor.app"
RIDER = "test.rider@medidoor.app"

LAT, LNG = 22.7009, 90.3676

PASSED: list[str] = []
FAILED: list[str] = []


def _check(label: str, ok: bool, detail: str = "") -> None:
    line = f"  {'OK' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}"
    print(line)
    (PASSED if ok else FAILED).append(label)


def login(c: httpx.Client, gmail: str, role: str) -> str:
    r = c.post(f"{BASE}/api/auth/dev-login", json={"gmail": gmail, "role": role})
    assert r.status_code == 200, f"dev-login {role}: {r.status_code} {r.text}"
    return r.json()["access_token"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def main() -> int:
    print("=== MediDoor E2E chat-flow test ===\n")

    # Reset prior test runs: drop conversations/orders/offers between the
    # 3 test accounts so each run starts clean.
    if DB_PATH.exists():
        con = sqlite3.connect(DB_PATH)
        cur = con.cursor()
        cur.execute("SELECT id FROM accounts WHERE gmail IN (?, ?, ?)",
                    (CUSTOMER, PHARMACY, RIDER))
        acct_ids = [r[0] for r in cur.fetchall()]
        if acct_ids:
            cur.execute("SELECT id FROM pharmacy_profiles WHERE account_id IN (%s)"
                        % ",".join("?" * len(acct_ids)), acct_ids)
            pharm_ids = [r[0] for r in cur.fetchall()]
            cur.execute("SELECT id FROM rider_profiles WHERE account_id IN (%s)"
                        % ",".join("?" * len(acct_ids)), acct_ids)
            rider_ids = [r[0] for r in cur.fetchall()]
            cur.execute("SELECT id FROM conversations WHERE customer_account_id IN (%s)"
                        % ",".join("?" * len(acct_ids)), acct_ids)
            conv_ids = [r[0] for r in cur.fetchall()]
            cur.execute("SELECT id FROM orders WHERE customer_account_id IN (%s)"
                        % ",".join("?" * len(acct_ids)), acct_ids)
            order_ids = [r[0] for r in cur.fetchall()]
            for ids, table, col in [
                (order_ids, "rider_offers", "order_id"),
                (order_ids, "order_messages", "order_id"),
                (conv_ids, "conversation_messages", "conversation_id"),
            ]:
                if ids:
                    cur.execute(f"DELETE FROM {table} WHERE {col} IN (%s)"
                                % ",".join("?" * len(ids)), ids)
            if order_ids:
                cur.execute("DELETE FROM orders WHERE id IN (%s)"
                            % ",".join("?" * len(order_ids)), order_ids)
            if conv_ids:
                cur.execute("DELETE FROM conversations WHERE id IN (%s)"
                            % ",".join("?" * len(conv_ids)), conv_ids)
            # also any rider_offers leftover for this rider
            if rider_ids:
                cur.execute("DELETE FROM rider_offers WHERE rider_id IN (%s)"
                            % ",".join("?" * len(rider_ids)), rider_ids)
        con.commit()
        con.close()
        print("[reset] cleared prior conversations / orders / offers for test users\n")

    with httpx.Client(timeout=15) as c:
        # 1) login all three roles
        print("[1] dev-login all roles")
        try:
            cust_tok = login(c, CUSTOMER, "customer")
            pharm_tok = login(c, PHARMACY, "pharmacy")
            rider_tok = login(c, RIDER, "rider")
            _check("dev-login (3 users)", True)
        except AssertionError as e:
            _check("dev-login (3 users)", False, str(e))
            return 1

        # 2) verify /me payloads
        print("\n[2] /api/auth/me for each role")
        for label, tok in [("customer", cust_tok), ("pharmacy", pharm_tok), ("rider", rider_tok)]:
            r = c.get(f"{BASE}/api/auth/me", headers=auth(tok))
            ok = r.status_code == 200 and r.json().get("is_registered")
            _check(f"me({label}) ok+registered", ok, f"status={r.status_code}")
            if label == "rider" and ok:
                m = r.json()
                _check("me(rider) full_name present", bool(m.get("profile", {}).get("full_name")))
                _check("me(rider) is_verified=True", bool(m.get("profile", {}).get("is_verified")))

        # 3) rider ping → so 800m broadcast finds them
        print("\n[3] rider ping location")
        r = c.post(f"{BASE}/api/rider/me/ping", headers=auth(rider_tok), json={"lat": LAT, "lng": LNG})
        _check("rider /ping 200", r.status_code == 200, str(r.status_code))

        # 4) customer storefront/nearby
        print("\n[4] customer storefront/nearby")
        r = c.get(f"{BASE}/api/storefront/nearby", params={"lat": LAT, "lng": LNG, "radius_km": 3})
        ok = r.status_code == 200
        _check("nearby 200", ok, str(r.status_code))
        if ok:
            data = r.json()
            _check("nearby items >= 1", len(data["items"]) >= 1, f"items={len(data['items'])}")
            _check("nearby pharmacy_count >= 1", data["pharmacy_count"] >= 1)
            _check(
                "nearby category counts cover items",
                sum(c["count"] for c in data["categories"]) >= len(data["items"]),
                f"sum={sum(c['count'] for c in data['categories'])} items={len(data['items'])}",
            )
            # find the SEEDED test pharmacy (by name match) — there may be others nearby
            test_items = [it for it in data["items"]
                          if "test pharmacy" in (it["pharmacy"].get("name") or "").lower()]
            _check("test pharmacy visible in nearby", len(test_items) >= 1,
                   f"names={[it['pharmacy'].get('name') for it in data['items']]}")
            if not test_items:
                return 1
            pharm_id = test_items[0]["pharmacy"]["id"]
        else:
            return 1

        # 5) customer opens conversation with pharmacy
        print("\n[5] open conversation customer → pharmacy")
        r = c.post(f"{BASE}/api/conversations", headers=auth(cust_tok),
                   json={"pharmacy_id": pharm_id})
        ok = r.status_code in (200, 201)
        _check("create conv 200/201", ok, f"{r.status_code} {r.text[:120]}")
        if not ok:
            return 1
        conv = r.json()
        conv_id = conv["id"]

        def post_msg(token: str, body: str, preset: str | None = None,
                     payload: dict | None = None, visibility: str = "all"):
            j = {"body": body, "visibility": visibility}
            if preset:
                j["preset_key"] = preset
            if payload:
                j["payload"] = payload
            return c.post(f"{BASE}/api/conversations/{conv_id}/messages",
                          headers=auth(token), json=j)

        # 6) customer sends order_request
        print("\n[6] customer sends order_request")
        order_payload = {
            "items": [
                {"name": "Napa 500mg", "qty": 2, "price": 1.20},
                {"name": "Seclo 20mg", "qty": 1, "price": 5.00},
            ],
            "subtotal": 7.40,
            "delivery_fee": 30,
            "delivery_address": "Test Customer House, Banani 11",
            "delivery_lat": LAT + 0.001,
            "delivery_lng": LNG + 0.001,
        }
        r = post_msg(cust_tok, "📦 Order request", "order_request", order_payload)
        _check("order_request 200/201", r.status_code in (200, 201),
               f"{r.status_code} {r.text[:120]}")

        # 7) pharmacy confirms
        print("\n[7] pharmacy sends order_confirm")
        r = post_msg(pharm_tok, "✅ Confirmed", "order_confirm")
        _check("order_confirm 200/201", r.status_code in (200, 201),
               f"{r.status_code} {r.text[:120]}")

        # 8) pharmacy → preparing
        print("\n[8] pharmacy sends status_preparing")
        r = post_msg(pharm_tok, "🟢 Preparing", "order_status_preparing")
        _check("status_preparing 200/201", r.status_code in (200, 201))

        # 9) pharmacy → call_rider
        print("\n[9] pharmacy sends call_rider (should broadcast)")
        r = post_msg(pharm_tok, "📞 Calling rider", "call_rider")
        _check("call_rider 200/201", r.status_code in (200, 201),
               f"{r.status_code} {r.text[:120]}")

        # 10) rider /offers → should now have 1
        print("\n[10] rider sees offer")
        time.sleep(0.8)
        r = c.get(f"{BASE}/api/rider/offers", headers=auth(rider_tok))
        print(f"  raw status={r.status_code} body={r.text[:300]}")
        ok = r.status_code == 200 and len(r.json().get("items", [])) >= 1
        _check("rider has >=1 offer", ok, f"status={r.status_code}")
        if not ok:
            print("  RAW:", r.text[:300])
            return 1
        offer = r.json()["items"][0]
        _check("offer has pickup info", bool(offer.get("pickup")), str(offer.get("pickup")))
        _check("offer has drop info", bool(offer.get("drop")), str(offer.get("drop")))
        _check("offer pickup has lat/lng", offer["pickup"]["lat"] is not None and offer["pickup"]["lng"] is not None)
        _check("offer drop has address", bool(offer["drop"]["address"]))
        _check("offer drop address from payload",
               "Banani" in (offer["drop"]["address"] or ""),
               offer["drop"]["address"])

        # 11) rider accepts
        print("\n[11] rider accepts offer")
        r = c.post(f"{BASE}/api/rider/offers/{offer['id']}/accept", headers=auth(rider_tok))
        _check("accept 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

        # 12) conversation should now have rider_id, rider_joined system msg
        print("\n[12] conversation has rider_joined")
        r = c.get(f"{BASE}/api/conversations", headers=auth(cust_tok))
        cust_convs = r.json()
        my_conv = next((x for x in cust_convs if x["id"] == conv_id), None)
        _check("conv has rider_id", bool(my_conv and my_conv.get("rider_id")),
               str(my_conv.get("rider_id") if my_conv else None))

        # check rider_joined message exists
        r = c.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=auth(cust_tok))
        msgs = r.json()
        joined = [m for m in msgs if m.get("preset_key") == "rider_joined"]
        _check("rider_joined message present", len(joined) >= 1, f"found {len(joined)}")

        # 13) rider should now see the conversation in /api/conversations
        print("\n[13] rider sees the conversation")
        r = c.get(f"{BASE}/api/conversations", headers=auth(rider_tok))
        rider_convs = r.json()
        _check("rider sees >=1 conv", len(rider_convs) >= 1, f"got {len(rider_convs)}")

        # 14) customer @rider private message — pharmacy should NOT see it
        print("\n[14] customer @rider private")
        r = post_msg(cust_tok, "🤫 only for rider", visibility="customer_rider")
        _check("private msg 200/201", r.status_code in (200, 201))

        # pharmacy fetches → should NOT see the private body
        r = c.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=auth(pharm_tok))
        pharm_msgs = r.json()
        leaked = [m for m in pharm_msgs if m.get("body") == "🤫 only for rider"]
        _check("pharmacy does NOT see private msg", len(leaked) == 0, f"leaked={len(leaked)}")
        # rider SHOULD see it
        r = c.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=auth(rider_tok))
        rider_msgs = r.json()
        seen = [m for m in rider_msgs if m.get("body") == "🤫 only for rider"]
        _check("rider sees private msg", len(seen) == 1)

        # 15) pharmacy → handed_over
        print("\n[15] pharmacy sends handed_over")
        r = post_msg(pharm_tok, "🤝 Handed to rider", "handed_over")
        _check("handed_over 200/201", r.status_code in (200, 201))

        # 16) rider → delivery_complete
        print("\n[16] rider sends delivery_complete")
        r = post_msg(rider_tok, "✅ Delivered", "delivery_complete")
        _check("delivery_complete 200/201", r.status_code in (200, 201),
               f"{r.status_code} {r.text[:120]}")

        # 17) rider archive privacy after delivery complete
        print("\n[17] rider archive privacy after delivery")
        r = c.get(f"{BASE}/api/conversations", headers=auth(rider_tok))
        rider_after_delivery = r.json() if r.status_code == 200 else []
        rider_conv = next((x for x in rider_after_delivery if x.get("id") == conv_id), None)
        _check("rider still sees 73h archive", rider_conv is not None,
               f"status={r.status_code} count={len(rider_after_delivery) if isinstance(rider_after_delivery, list) else 'n/a'}")
        _check("rider archive is read-only", bool(rider_conv and rider_conv.get("rider_read_only")),
               str(rider_conv.get("rider_read_only") if rider_conv else None))

        followup_body = "Post-delivery customer↔pharmacy follow-up — rider must not see this"
        r = post_msg(cust_tok, followup_body)
        _check("customer follow-up after delivery 200/201", r.status_code in (200, 201),
               f"{r.status_code} {r.text[:120]}")

        r = c.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=auth(rider_tok))
        rider_msgs_after = r.json() if r.status_code == 200 else []
        leaked = [m for m in rider_msgs_after if m.get("body") == followup_body]
        _check("rider cannot see post-delivery follow-up", len(leaked) == 0,
               f"leaked={len(leaked)} status={r.status_code}")

        r = post_msg(rider_tok, "This should be blocked after delivery")
        _check("rider cannot send after delivery", r.status_code == 403,
               f"{r.status_code} {r.text[:160]}")

        # 18) same customer+pharmacy starts another order — former rider must
        # NOT be treated as a participant just because this is the same reused
        # conversation. They can rejoin only after accepting a fresh offer.
        print("\n[18] repeat order does not reopen former rider chat")
        second_payload = dict(order_payload)
        second_payload["note"] = "Second order after first delivery"
        r = post_msg(cust_tok, "📦 Second order request", "order_request", second_payload)
        _check("second order_request 200/201", r.status_code in (200, 201),
               f"{r.status_code} {r.text[:120]}")

        r = c.get(f"{BASE}/api/conversations", headers=auth(rider_tok))
        rider_repeat_list = r.json() if r.status_code == 200 else []
        rider_conv_after_repeat = next((x for x in rider_repeat_list if x.get("id") == conv_id), None)
        _check("former rider no longer sees reused chat before accepting new offer",
               rider_conv_after_repeat is None,
               f"status={r.status_code} count={len(rider_repeat_list) if isinstance(rider_repeat_list, list) else 'n/a'}")

        r = c.get(f"{BASE}/api/conversations/{conv_id}/messages", headers=auth(rider_tok))
        _check("former rider cannot open reused chat before new accept", r.status_code == 403,
               f"{r.status_code} {r.text[:160]}")

        r = post_msg(pharm_tok, "✅ Confirmed second order", "order_confirm")
        _check("second order_confirm 200/201", r.status_code in (200, 201),
               f"{r.status_code} {r.text[:120]}")
        r = post_msg(pharm_tok, "📞 Calling rider for second order", "call_rider")
        _check("second call_rider 200/201", r.status_code in (200, 201),
               f"{r.status_code} {r.text[:120]}")

        time.sleep(0.8)
        r = c.get(f"{BASE}/api/rider/offers", headers=auth(rider_tok))
        offers = r.json().get("items", []) if r.status_code == 200 else []
        _check("rider sees fresh second offer", len(offers) >= 1,
               f"status={r.status_code} offers={len(offers)}")
        if offers:
            r = c.post(f"{BASE}/api/rider/offers/{offers[0]['id']}/accept", headers=auth(rider_tok))
            _check("accept second offer 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

        r = c.get(f"{BASE}/api/conversations", headers=auth(rider_tok))
        rider_active_again = next((x for x in (r.json() if r.status_code == 200 else []) if x.get("id") == conv_id), None)
        _check("same rider sees chat only after accepting new offer", rider_active_again is not None,
               f"status={r.status_code}")
        _check("same rider is active, not archive, after new accept",
               bool(rider_active_again and not rider_active_again.get("rider_read_only")),
               str(rider_active_again.get("rider_read_only") if rider_active_again else None))

        r = post_msg(rider_tok, "আমি second delivery-এর জন্য joined আছি।")
        _check("same rider can message after accepting new offer", r.status_code in (200, 201),
               f"{r.status_code} {r.text[:120]}")

        # 19) verify Order.status == delivered
        print("\n[19] verify Order delivered (via pharmacy/me/orders if exists)")
        r = c.get(f"{BASE}/api/pharmacy/me/orders", headers=auth(pharm_tok))
        if r.status_code == 200:
            orders = r.json().get("items", [])
            delivered = [o for o in orders if o.get("status") == "delivered"]
            _check("at least 1 delivered order", len(delivered) >= 1, f"orders={len(orders)} delivered={len(delivered)}")

    print(f"\n=== {len(PASSED)} passed, {len(FAILED)} failed ===")
    if FAILED:
        print("\nFAILED:")
        for f in FAILED:
            print("  -", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
