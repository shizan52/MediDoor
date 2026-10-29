"""Test admin moderation endpoints + @mediai mention."""
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import json, urllib.request

API = "http://localhost:8000"

def http(method, path, body=None, token=None):
    headers = {"Accept":"application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

# Admin login
_, admin = http("POST","/api/auth/dev-login", {"gmail":"admin@medidoor.app","role":"customer"})
atok = admin["access_token"]
print("admin token ok")

# Stats
print("\n--- Stats ---")
print(http("GET","/api/admin/moderation/stats", token=atok))

# Flagged convs
print("\n--- Flagged conversations ---")
status, convs = http("GET","/api/admin/moderation/conversations", token=atok)
print(status, "found", len(convs), "convs")
for c in convs[:3]:
    print(f"  - {c['pharmacy_name']} <-> {c['customer_name']} | blocked={bool(c['blocked_at'])} flags={c['flag_count']}")
    if c.get("last_flagged_message"):
        lfm = c["last_flagged_message"]
        print(f"    last: [{lfm['moderation_risk']}/{lfm['moderation_category']}] {lfm['body'][:60]}")

if not convs:
    print("nothing to unblock")
    raise SystemExit(0)

# Unblock the first blocked one
target = next((c for c in convs if c["blocked_at"]), None)
if target:
    cid = target["id"]
    print(f"\n--- Unblocking {cid} ---")
    print(http("POST", f"/api/admin/moderation/conversations/{cid}/unblock", body={"note":"test reviewed"}, token=atok))

    # Test customer can now send again
    _, cust = http("POST","/api/auth/dev-login", {"gmail":"test.customer@medidoor.app","role":"customer"})
    ctok = cust["access_token"]
    print("\n--- After unblock: customer sends again ---")
    print(http("POST", f"/api/conversations/{cid}/messages", body={"body":"sorry, ki kortei hobe?"}, token=ctok))

    # @mediai mention test
    print("\n--- @mediai mention ---")
    status, m = http("POST", f"/api/conversations/{cid}/messages",
        body={"body":"@mediai Napa 500mg er normal dose ki?"}, token=ctok)
    print(status, "ok" if isinstance(m,dict) else m)

    # Check messages — should include AI reply
    print("\n--- Latest 5 messages ---")
    _, msgs = http("GET", f"/api/conversations/{cid}/messages", token=ctok)
    for m in msgs[-5:]:
        print(f"  [{m['sender_role']}/{m.get('preset_key','-')}] {m['body'][:90]}")
