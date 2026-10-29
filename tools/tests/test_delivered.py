from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import sqlite3, requests, json, traceback

DB = str(DB_PATH)
ORDER_HEX = "f5722fa359204d298486e9c6f35184e0"
ORDER_DASH = "f5722fa3-5920-4d29-8486-e9c6f35184e0"
CONV_HEX = "415f05774d3741939b12b22f7a4796a9"
RIDER_HEX = "ceaa7d26e7374e498cd8edc222592dcd"

def dump(tag):
    db = sqlite3.connect(DB)
    print(f"--- {tag} ---")
    for r in db.execute("SELECT id, status, conversation_id FROM orders WHERE id=?", (ORDER_HEX,)):
        print("  order:", r)
    for r in db.execute("SELECT id, rider_id, last_message_at FROM conversations WHERE id=?", (CONV_HEX,)):
        print("  conv :", r)
    for r in db.execute("SELECT count(*) FROM conversation_messages WHERE conversation_id=?", (CONV_HEX,)):
        print("  conv_msgs total:", r[0])
    for r in db.execute("SELECT preset_key, sender_role, created_at FROM conversation_messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 6", (CONV_HEX,)):
        print("  recent:", r)
    db.close()

# Reset state so /delivered can run fresh
db = sqlite3.connect(DB)
db.execute("UPDATE orders SET status=? WHERE id=?", ("dispatched", ORDER_HEX))
db.execute("UPDATE conversations SET rider_id=? WHERE id=?", (RIDER_HEX, CONV_HEX))
db.commit()
db.close()

dump("BEFORE")

try:
    r = requests.post("http://localhost:8000/api/auth/dev-login", json={"gmail":"test.rider@medidoor.app","role":"rider"}, timeout=10)
    print("dev-login:", r.status_code, r.text[:200])
    tok = r.json()["access_token"]
    r2 = requests.post(f"http://localhost:8000/api/rider/orders/{ORDER_DASH}/delivered",
                       headers={"Authorization": f"Bearer {tok}"}, timeout=10)
    print("delivered:", r2.status_code, r2.text[:500])
except Exception:
    traceback.print_exc()

dump("AFTER")
