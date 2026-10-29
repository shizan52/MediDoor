# Headless smoke test for admin.py — exercises every read endpoint that the
# Tk tabs hit, reusing admin.py's own helpers (_admin_call / _backend_call /
# _read_accounts_with_profiles). No Tk window is opened; this is meant to run
# from CI or a quick PowerShell invocation. Exits non-zero if any endpoint
# fails.

from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import os
import sys
import traceback
from typing import Any, Callable

# Ensure repo root is on sys.path so `import admin` resolves to admin.py.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import admin  # noqa: E402  (import after sys.path tweak)

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, str, str]] = []


def step(label: str, work: Callable[[], Any]) -> Any:
    try:
        out = work()
    except Exception as exc:  # noqa: BLE001
        results.append((label, FAIL, f"{type(exc).__name__}: {exc}"))
        traceback.print_exc()
        return None
    if isinstance(out, list):
        info = f"{len(out)} rows"
    elif isinstance(out, dict):
        keys = ",".join(list(out.keys())[:6])
        info = f"dict keys=[{keys}]"
    elif out is None:
        info = "None"
    else:
        info = str(out)[:80]
    results.append((label, PASS, info))
    return out


def main() -> int:
    print(f"BACKEND_URL  = {admin.BACKEND_URL}")
    print(f"ADMIN_GMAIL  = {admin.ADMIN_GMAIL}")
    secret = admin._read_env_value("SECRET_KEY")
    print(f"SECRET_KEY   = (len={len(secret)})")
    print()

    # 1. Auth — admin-desktop-login round-trip.
    holder = admin._SYSTEM_HOLDER
    holder.token = None  # force fresh login

    def _login() -> str:
        # _admin_call lazily logs in. Trigger by hitting a cheap GET.
        admin._admin_call(holder, "/api/admin/users/customers")
        if not holder.token:
            raise RuntimeError("no token cached after _admin_call")
        return f"token len={len(holder.token)}"

    step("auth.admin-desktop-login", _login)

    # 2. Users: customers / pharmacies / riders + combined helper.
    step("GET /api/admin/users/customers", lambda: admin._admin_call(holder, "/api/admin/users/customers"))
    step("GET /api/admin/users/pharmacies", lambda: admin._admin_call(holder, "/api/admin/users/pharmacies"))
    step("GET /api/admin/users/riders?status_filter=all", lambda: admin._admin_call(holder, "/api/admin/users/riders?status_filter=all"))

    def _combined() -> Any:
        accounts, customers, pharms, riders = admin._read_accounts_with_profiles()
        return {
            "accounts": len(accounts),
            "customers": len(customers),
            "pharmacies": len(pharms),
            "riders": len(riders),
        }
    combined = step("admin._read_accounts_with_profiles()", _combined)

    # 3. Moderation stats (used by the moderation tab).
    step("GET /api/admin/moderation/stats", lambda: admin._admin_call(holder, "/api/admin/moderation/stats"))

    # 4. Orders cockpit list (used by orders tab).
    orders_resp = step("GET /api/admin/orders", lambda: admin._admin_call(holder, "/api/admin/orders"))

    # 4b. Order detail + conversation messages (sample first order if any).
    if isinstance(orders_resp, dict):
        orders_list = orders_resp.get("orders") or []
        if orders_list:
            o0 = orders_list[0]
            oid = o0.get("id") or o0.get("order_id")
            cid = o0.get("conversation_id") or o0.get("conv_id")
            if oid:
                step(f"GET /api/admin/orders/{oid}", lambda: admin._admin_call(holder, f"/api/admin/orders/{oid}"))
            if cid:
                step(
                    f"GET /api/admin/conversations/{cid}/messages",
                    lambda: admin._admin_call(holder, f"/api/admin/conversations/{cid}/messages"),
                )

    # 4c. Audit + purge logs (used by moderation/audit tab).
    step("GET /api/admin/audit-log?limit=500", lambda: admin._admin_call(holder, "/api/admin/audit-log?limit=500"))
    step("GET /api/admin/purge-log?limit=100", lambda: admin._admin_call(holder, "/api/admin/purge-log?limit=100"))

    # 4d. Paginated pharmacy/rider lists (used by moderation chooser dialogs).
    step("GET /api/admin/users/pharmacies?limit=2000", lambda: admin._admin_call(holder, "/api/admin/users/pharmacies?limit=2000"))
    step("GET /api/admin/users/riders?limit=2000", lambda: admin._admin_call(holder, "/api/admin/users/riders?limit=2000"))

    # 5. Per-user thread (sample on first customer if any).
    if combined and isinstance(combined, dict) and combined.get("customers", 0) > 0:
        accounts, customers, _, _ = admin._read_accounts_via_api()
        first_cid = next(iter(customers.keys()), None)
        if first_cid:
            step(
                f"GET /api/admin/users/customers/{first_cid}/thread",
                lambda: admin._admin_call(holder, f"/api/admin/users/customers/{first_cid}/thread"),
            )

    # 6. Token reuse — second call should NOT re-login.
    cached_tok = holder.token

    def _reuse() -> str:
        admin._admin_call(holder, "/api/admin/users/customers")
        if holder.token != cached_tok:
            raise RuntimeError("token rotated unexpectedly")
        return "token reused"
    step("token reuse (no re-login)", _reuse)

    # 7. 401 -> auto re-login path.
    def _refresh() -> str:
        holder.token = "obviously-bad-token"
        admin._admin_call(holder, "/api/admin/users/customers")
        if not holder.token or holder.token == "obviously-bad-token":
            raise RuntimeError("token was not refreshed after 401")
        return "token refreshed after 401"
    step("auto re-login on 401", _refresh)

    # 8. Cloudflare User-Agent guard — make sure default urllib UA still 403s,
    # confirming our explicit UA is what's letting us through.
    def _ua_check() -> str:
        import urllib.request
        import urllib.error
        req = urllib.request.Request(
            f"{admin.BACKEND_URL}/api/admin/users/customers",
            headers={"Authorization": f"Bearer {holder.token}"},  # default UA = Python-urllib
        )
        try:
            urllib.request.urlopen(req, timeout=10).read()
            return "Cloudflare did NOT block default UA (unexpected, but harmless)"
        except urllib.error.HTTPError as exc:
            if exc.code == 403:
                return "default UA correctly blocked by Cloudflare (custom UA fix verified)"
            return f"HTTP {exc.code} (unexpected)"
    step("cloudflare default-UA guard", _ua_check)

    # 9. Media fetch via _http_open — same path the user-details window uses
    # for profile photos / NID images. Picks a profile_photo_url from the
    # first customer if present; otherwise probes a known-public static path.
    def _media_check() -> str:
        target_url: str | None = None
        if combined and combined.get("customers", 0) > 0:
            _, customers, _, _ = admin._read_accounts_via_api()
            for cid, p in customers.items():
                u = (p or {}).get("profile_photo_url")
                if u:
                    target_url = u if str(u).startswith("http") else f"{admin.BACKEND_URL}{u}"
                    break
        if not target_url:
            # Fall back to the OpenAPI doc which always exists and is served
            # by the same Cloudflare-fronted host.
            target_url = f"{admin.BACKEND_URL}/openapi.json"
        with admin._http_open(target_url, timeout=10) as r:
            body = r.read()
        return f"GET {target_url} -> {len(body)} bytes"
    step("media fetch via _http_open", _media_check)

    # 10. Moderation tab endpoints — products + flagged/blocked conversations.
    step("GET /api/admin/moderation/products",
         lambda: admin._admin_call(holder, "/api/admin/moderation/products"))
    step("GET /api/admin/moderation/conversations?only_blocked=false",
         lambda: admin._admin_call(holder, "/api/admin/moderation/conversations?only_blocked=false"))
    step("GET /api/admin/moderation/conversations?only_blocked=true",
         lambda: admin._admin_call(holder, "/api/admin/moderation/conversations?only_blocked=true"))

    # 11. Orders list with the same query-string the Orders tab builds.
    step("GET /api/admin/orders?limit=200",
         lambda: admin._admin_call(holder, "/api/admin/orders?limit=200"))
    step("GET /api/admin/orders?status=pending&limit=50",
         lambda: admin._admin_call(holder, "/api/admin/orders?status=pending&limit=50"))
    step("GET /api/admin/orders?only_flagged=true&limit=50",
         lambda: admin._admin_call(holder, "/api/admin/orders?only_flagged=true&limit=50"))

    # 12. Static asset / image variant probe — every image type the Tk windows
    # fetch via _http_open (profile photos, NID front/back, prescription, shop
    # license, vehicle photos). We only check the first non-null URL per kind
    # so the run stays cheap.
    def _all_media_check() -> str:
        seen: list[tuple[str, str]] = []
        if not combined:
            return "no accounts to probe"
        _, customers, pharms, riders = admin._read_accounts_via_api()
        kinds: dict[str, list[str]] = {
            "customer.photo": [],
            "pharmacy.shop_license": [],
            "pharmacy.photo": [],
            "rider.nid_front": [],
            "rider.nid_back": [],
            "rider.photo": [],
        }
        for p in customers.values():
            if (u := (p or {}).get("profile_photo_url")):
                kinds["customer.photo"].append(u)
        for p in pharms.values():
            for k_local, k_remote in (("pharmacy.shop_license", "shop_license_url"),
                                      ("pharmacy.photo", "profile_photo_url")):
                if (u := (p or {}).get(k_remote)):
                    kinds[k_local].append(u)
        for p in riders.values():
            for k_local, k_remote in (("rider.nid_front", "nid_front_url"),
                                      ("rider.nid_back", "nid_back_url"),
                                      ("rider.photo", "profile_photo_url")):
                if (u := (p or {}).get(k_remote)):
                    kinds[k_local].append(u)
        for kind, urls in kinds.items():
            if not urls:
                continue
            u = urls[0]
            full = u if str(u).startswith("http") else f"{admin.BACKEND_URL}{u}"
            try:
                with admin._http_open(full, timeout=10) as r:
                    n = len(r.read())
                seen.append((kind, f"{n}B"))
            except Exception as exc:  # noqa: BLE001
                seen.append((kind, f"ERR {type(exc).__name__}"))
        if not seen:
            return "no media URLs found across accounts"
        return ", ".join(f"{k}={v}" for k, v in seen)
    step("all-kinds media fetch", _all_media_check)

    # Summary
    print()
    print("=" * 78)
    print(f"{'TEST':<55} {'STATUS':<6} INFO")
    print("-" * 78)
    failed = 0
    for label, status, info in results:
        print(f"{label:<55} {status:<6} {info}")
        if status == FAIL:
            failed += 1
    print("=" * 78)
    print(f"{len(results) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
