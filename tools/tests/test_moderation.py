from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import json, urllib.request

API = "http://localhost:8000"
def post(path, body, token=None):
    req = urllib.request.Request(f"{API}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type":"application/json", **({"Authorization":f"Bearer {token}"} if token else {})},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def get(path, token=None):
    req = urllib.request.Request(f"{API}{path}",
        headers={"Authorization":f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, json.loads(r.read().decode())

# 1. Login as test customer
_, cust = post("/api/auth/dev-login", {"gmail":"test.customer@medidoor.app","role":"customer"})
ctok = cust["access_token"]
print("customer logged in")

# 2. Find test pharmacy
_, near = get("/api/storefront/nearby?lat=22.7009&lng=90.3676&radius_km=5")
test_p = next((p for p in near.get("pharmacies", []) if "TEST" in (p.get("license_no","") or "").upper() or "Test" in (p.get("pharmacy_name","") or "")), None)
if not test_p:
    test_p = (near.get("pharmacies") or [None])[0]
if not test_p:
    # Fallback: find the test pharmacy via storefront single-pharmacy by ID
    # using DB-backed Account lookup
    print("nearby returned no pharmacies — falling back to direct DB lookup")
    import sqlite3
    db = sqlite3.connect(str(DB_PATH))
    row = db.execute("SELECT id, pharmacy_name FROM pharmacy_profiles WHERE pharmacy_license_no='BD-PH-TEST-001'").fetchone()
    db.close()
    if row:
        # ID is stored as 32-char hex (CHAR(32))
        pid = row[0]
        # convert hex → uuid string
        if len(pid) == 32:
            pid = f"{pid[0:8]}-{pid[8:12]}-{pid[12:16]}-{pid[16:20]}-{pid[20:32]}"
        test_p = {"id": pid, "pharmacy_name": row[1]}
print("pharmacy:", test_p["pharmacy_name"], test_p["id"])

# 3. Start conversation
_, conv = post("/api/conversations", {"pharmacy_id": test_p["id"]}, ctok)
cid = conv["id"]
print("conv:", cid)

# 4. Send normal message
print("\n--- Normal message ---")
status, m = post(f"/api/conversations/{cid}/messages", {"body":"Hi, do you have Napa 500mg in stock?"}, ctok)
print(status, "moderation_risk=", m.get("moderation_risk") if isinstance(m, dict) else m)

# 5. Send fraud attempt message
print("\n--- Fraud attempt (off-platform) ---")
status, m = post(f"/api/conversations/{cid}/messages", {"body":"app na use kore amake direct call koro 01711-123456 e bKash kore deyo"}, ctok)
print(status, "moderation_risk=", m.get("moderation_risk") if isinstance(m, dict) else m, "reason=", m.get("moderation_reason") if isinstance(m, dict) else "")

# 6. Send harassment
print("\n--- Harassment ---")
status, m = post(f"/api/conversations/{cid}/messages", {"body":"tui ekta khanki magi, baal er pharmacy"}, ctok)
print(status, "moderation_risk=", m.get("moderation_risk") if isinstance(m, dict) else "BLOCKED:", m if isinstance(m, str) else "")

# 7. Try sending again — should be locked
print("\n--- Try sending after potential block ---")
status, m = post(f"/api/conversations/{cid}/messages", {"body":"hello"}, ctok)
print(status, m if isinstance(m, str) else m)

# 8. Test @mediai mention
# (only works if not blocked, so reset by checking)
