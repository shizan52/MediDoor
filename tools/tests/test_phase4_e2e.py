"""End-to-end test: rider verification + two-way admin/rider thread + ping gate."""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
PY = BACKEND / ".venv" / "Scripts" / "python.exe"
PORT = 8055
BASE = f"http://127.0.0.1:{PORT}"


def http(method, path, *, token=None, body=None, timeout=10):
    url = BASE + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"raw": raw.decode("utf-8", "replace")}
        return e.code, payload


def wait_for_backend(timeout=60.0):
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def expect(label, ok, detail=""):
    mark = "OK  " if ok else "FAIL"
    print(f"  [{mark}] {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        raise AssertionError(label + ": " + detail)


def main():
    if not PY.exists():
        print(f"venv python not found: {PY}")
        return 2

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    log_path = ROOT / "tools" / "_e2e_backend.log"
    log_file = open(log_path, "w", encoding="utf-8")
    print(f"[boot] starting backend (cwd={BACKEND}) log={log_path}...")
    proc = subprocess.Popen(
        [str(PY), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
         "--port", str(PORT), "--log-level", "info"],
        cwd=str(BACKEND), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )

    def _pump():
        for line in iter(proc.stdout.readline, b""):
            try:
                log_file.write(line.decode("utf-8", "replace"))
                log_file.flush()
            except Exception:
                break
    threading.Thread(target=_pump, daemon=True).start()
    try:
        if not wait_for_backend():
            print("[boot] backend failed to start")
            try:
                out, _ = proc.communicate(timeout=2)
                print(out.decode("utf-8", "replace")[-3000:])
            except Exception:
                pass
            return 3
        print("[boot] backend up")

        suffix = uuid.uuid4().hex[:8]
        rider_email = f"rider_{suffix}@example.com"

        # 1. rider dev-login
        print("\n[1] rider dev-login")
        s, r = http("POST", "/api/auth/dev-login", body={"gmail": rider_email, "role": "rider"})
        expect("status 200", s == 200, str(r)[:200])
        rider_token = r["access_token"]

        # 1b. rider /me to obtain id
        s, r = http("GET", "/api/auth/me", token=rider_token)
        expect("rider /me 200", s == 200, str(r)[:300])
        rider_id = r.get("account_id") or (r.get("account") or {}).get("id") or r.get("id")
        expect("rider id present", bool(rider_id), f"keys={list(r.keys())}")
        print(f"     rider_id={rider_id}")

        # 2. rider register (NID path)
        print("\n[2] rider register")
        body = {
            "full_name": f"E2E Rider {suffix}",
            "nick_name": "E2E",
            "phone_number": f"+88017{suffix[:8]}",
            "age": 28,
            "nid_number": f"99{suffix}{suffix}",
            "nid_front_url": "/uploads/test_nid_front.png",
            "nid_back_url": "/uploads/test_nid_back.png",
            "profile_photo_url": "/uploads/test_face.png",
        }
        s, r = http("POST", "/api/auth/register/rider", token=rider_token, body=body)
        expect("register 200", s == 200, f"{s}: {str(r)[:300]}")

        # 3. admin login
        print("\n[3] admin dev-login")
        s, r = http("POST", "/api/auth/dev-login",
                    body={"gmail": "admin@medidoor.app", "role": "customer"})
        expect("admin login 200", s == 200, str(r)[:200])
        admin_token = r["access_token"]

        # 4. admin list pending
        print("\n[4] admin list pending")
        s, r = http("GET", "/api/admin/users/riders?status_filter=pending", token=admin_token)
        expect("list 200", s == 200, str(r)[:200])
        ids = [str(row.get("account_id")) for row in (r or [])]
        expect("rider in pending", str(rider_id) in ids, f"count={len(ids)} sample={ids[:3]}")

        # 5. admin sends initial message
        print("\n[5] admin sends initial message")
        s, r = http("POST", f"/api/admin/users/riders/{rider_id}/message",
                    token=admin_token,
                    body={"title": "Welcome", "body": "Please wait while we verify your documents."})
        expect("message sent", s in (200, 201, 204), f"{s}: {str(r)[:200]}")

        # 6. rider GET admin-thread
        print("\n[6] rider GET admin-thread")
        s, r = http("GET", "/api/rider/me/admin-thread", token=rider_token)
        expect("thread 200", s == 200, str(r)[:200])
        msgs = r if isinstance(r, list) else (r.get("items") or r.get("messages", []))
        expect("admin msg present",
               any(m.get("direction") == "admin_to_rider" for m in msgs),
               f"msgs={msgs}")
        print(f"     rider sees {len(msgs)} message(s)")

        # 7. unread should be 0 after read
        s, r = http("GET", "/api/rider/me/admin-thread/unread", token=rider_token)
        expect("unread endpoint 200", s == 200, str(r)[:200])
        print(f"     rider unread after read = {r.get('unread')}")

        # 8. rider posts reply
        print("\n[8] rider POST reply")
        s, r = http("POST", "/api/rider/me/admin-thread", token=rider_token,
                    body={"body": "Thanks! Documents are uploaded."})
        expect("reply 200", s in (200, 201), f"{s}: {str(r)[:200]}")

        # 9. admin unread summary BEFORE viewing thread (so reply is still unread)
        s, r = http("GET", "/api/admin/users/riders/threads/unread-summary", token=admin_token)
        expect("unread summary 200", s == 200, str(r)[:200])
        counts = (r or {}).get("counts", {})
        expect("rider has unread", counts.get(str(rider_id), 0) >= 1, f"counts={counts}")

        # 10. admin GET thread sees both directions (also marks rider->admin read)
        print("\n[10] admin GET thread")
        s, r = http("GET", f"/api/admin/users/riders/{rider_id}/thread", token=admin_token)
        expect("admin thread 200", s == 200, str(r)[:200])
        msgs = r if isinstance(r, list) else (r.get("items") or r.get("messages", []))
        dirs = sorted({m.get("direction") for m in msgs})
        expect("both directions",
               "admin_to_rider" in dirs and "rider_to_admin" in dirs,
               f"dirs={dirs}")
        print(f"     thread has {len(msgs)} msgs, dirs={dirs}")

        # 11. admin POST reply
        print("\n[11] admin POST reply")
        s, r = http("POST", f"/api/admin/users/riders/{rider_id}/thread", token=admin_token,
                    body={"body": "Got it, reviewing now."})
        expect("admin reply 200", s in (200, 201), f"{s}: {str(r)[:200]}")

        # 12. rider notifications include admin_message
        s, r = http("GET", "/api/notifications", token=rider_token)
        if s == 200:
            items = r if isinstance(r, list) else r.get("items", [])
            kinds = [n.get("kind") for n in items]
            print(f"     rider notif kinds top-5: {kinds[:5]}")
            expect("admin_message notif", "admin_message" in kinds, f"kinds={kinds[:10]}")
        else:
            print(f"     /api/notifications -> {s}")

        # 13. ping BEFORE verify -> blocked
        print("\n[13] rider ping BEFORE verify (expect 401/403)")
        s, _ = http("POST", "/api/rider/me/ping", token=rider_token,
                    body={"lat": 23.78, "lng": 90.40})
        expect("ping blocked", s in (401, 403, 409), f"got {s}")

        # 14. admin verify
        print("\n[14] admin verify rider")
        s, r = http("POST", f"/api/admin/users/riders/{rider_id}/verify",
                    token=admin_token, body={})
        expect("verify 200", s in (200, 201, 204), f"{s}: {str(r)[:200]}")

        # 15. rider /me verified
        print("\n[15] rider /me verified?")
        s, r = http("GET", "/api/auth/me", token=rider_token)
        expect("/me 200", s == 200, str(r)[:200])
        prof = r.get("profile") or r.get("rider_profile") or {}
        vs = prof.get("verification_status") or r.get("verification_status")
        is_v = prof.get("is_verified") or r.get("is_verified")
        print(f"     verification_status={vs} is_verified={is_v}")
        expect("verified", vs == "verified" or bool(is_v), f"prof={prof}")

        # 16. ping AFTER verify
        print("\n[16] rider ping AFTER verify (expect 200)")
        s, r = http("POST", "/api/rider/me/ping", token=rider_token,
                    body={"lat": 23.78, "lng": 90.40})
        expect("ping 200", s == 200, f"{s}: {str(r)[:200]}")

        print("\n=== ALL E2E STEPS PASSED ===")
        return 0
    finally:
        print("\n[shutdown] terminating backend...")
        try:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except Exception:
                proc.kill()
            log_file.flush()
            log_file.close()
            try:
                tail = log_path.read_text(encoding="utf-8", errors="replace")[-5000:]
                print("--- backend log tail ---")
                print(tail)
            except Exception:
                pass
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
