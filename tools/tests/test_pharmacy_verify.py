"""End-to-end smoke test for DGDA pharmacy verification (v2 — pharmacist + expiry).

Test data uses the live DGDA registry:
  * MDh-005    - valid until 22-12-2026 (Owner: MD.Jabed Ali, Pharmacist: Md.Hajize udden / B-13727)
  * MDh-002    - valid until 15-05-2026 (Owner: Suresh chandra Shaha, Pharmacist: Md.Anil kumar Shaha / B-9593)
  * MDh-010    - valid until 13-06-2026 (Owner: Mr.Pradep sorkar, Pharmacist: Sree Pradep sorkar / B-7322)
  * Manik-82/AB - valid until 23-02-2025 (EXPIRED — Pharmacist: Sunil kumar Vaidya / B-00270)
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import asyncio
import uuid
import httpx

API = "http://127.0.0.1:8000"


async def dev_token(client, gmail):
    r = await client.post(
        f"{API}/api/auth/dev-login",
        json={"gmail": gmail, "role": "pharmacy"},
    )
    r.raise_for_status()
    return r.json()["access_token"]


async def register(client, token, *, license_no, owner, name, pharmacist, regno):
    return await client.post(
        f"{API}/api/auth/register/pharmacy",
        json={
            "pharmacy_name": name,
            "owner_name": owner,
            "business_name": name + " Ltd.",
            "pharmacy_license_no": license_no,
            "pharmacist_name": pharmacist,
            "pharmacist_reg_no": regno,
        },
        headers={"Authorization": f"Bearer {token}"},
    )


async def verification(client, token):
    r = await client.get(
        f"{API}/api/pharmacy/me/verification",
        headers={"Authorization": f"Bearer {token}"},
    )
    r.raise_for_status()
    return r.json()


async def wait_done(client, token, attempts=30, delay=0.7):
    for _ in range(attempts):
        v = await verification(client, token)
        if v["status"] != "pending":
            return v
        await asyncio.sleep(delay)
    return v


async def main():
    async with httpx.AsyncClient(timeout=45) as client:
        suffix = uuid.uuid4().hex[:6]

        # === case 1 — valid license, all correct → verified ===
        ta = await dev_token(client, f"verify+a-{suffix}@medidoor.app")
        r = await register(
            client, ta,
            license_no="MDh-005",
            owner="MD.Jabed Ali",
            name="M/S Subara Drag",
            pharmacist="Md.Hajize udden",
            regno="B-13727",
        )
        print("CASE 1 register:", r.status_code)
        assert r.status_code == 200, r.text
        v = await wait_done(client, ta)
        print("  ->", v["status"])
        print("  msg:", v["message"][:90])
        assert v["status"] == "verified", v
        assert v["dgda_record"]["is_expired"] is False
        assert v["dgda_record"]["valid_until_iso"] is not None

        # === case 2 — valid license but wrong pharmacist regno → mismatch ===
        tb = await dev_token(client, f"verify+b-{suffix}@medidoor.app")
        r = await register(
            client, tb,
            license_no="MDh-002",
            owner="Suresh chandra Shaha",
            name="M/S Kusum kumari madical Hall",
            pharmacist="Md.Anil kumar Shaha",
            regno="B-9999",  # WRONG — real is B-9593
        )
        assert r.status_code == 200, r.text
        v = await wait_done(client, tb)
        print("CASE 2 ->", v["status"], "|", v["mismatch_fields"])
        assert v["status"] == "mismatch"
        assert "pharmacist_reg_no" in v["mismatch_fields"]
        assert v["submitted"]["pharmacist_reg_no"] == "B-9999"

        # === case 3 — resubmit case 2 with correct regno → verified ===
        r = await client.post(
            f"{API}/api/pharmacy/me/verify-resubmit",
            json={
                "pharmacy_license_no": "MDh-002",
                "pharmacy_name": "M/S Kusum kumari madical Hall",
                "owner_name": "Suresh chandra Shaha",
                "pharmacist_name": "Md.Anil kumar Shaha",
                "pharmacist_reg_no": "B-9593",
            },
            headers={"Authorization": f"Bearer {tb}"},
        )
        print("CASE 3 resubmit:", r.status_code)
        assert r.status_code == 200, r.text
        v = await wait_done(client, tb)
        print("  ->", v["status"])
        assert v["status"] == "verified", v

        # === case 4 — expired license (all data correct) → expired ===
        tc = await dev_token(client, f"verify+c-{suffix}@medidoor.app")
        r = await register(
            client, tc,
            license_no="Manik-82/AB",
            owner="Sunil kumar Vaidya",
            name="Vaidya Medical Hall",
            pharmacist="Sunil kumar Vaidya",
            regno="B-00270",
        )
        assert r.status_code == 200, r.text
        v = await wait_done(client, tc)
        print("CASE 4 ->", v["status"])
        print("  msg:", v["message"][:120])
        assert v["status"] == "expired", v
        assert v["dgda_record"]["is_expired"] is True
        assert "valid_until" in v["mismatch_fields"]

        # === case 5 — /verify-retry on expired account stays expired ===
        r = await client.post(
            f"{API}/api/pharmacy/me/verify-retry",
            headers={"Authorization": f"Bearer {tc}"},
        )
        assert r.status_code == 200, r.text
        v = await wait_done(client, tc)
        print("CASE 5 retry expired ->", v["status"])
        assert v["status"] == "expired"

        # === case 6 — bogus license → not_found ===
        td = await dev_token(client, f"verify+d-{suffix}@medidoor.app")
        r = await register(
            client, td,
            license_no="DOES-NOT-EXIST-9999",
            owner="N/A", name="N/A", pharmacist="N/A", regno="N/A",
        )
        assert r.status_code == 200, r.text
        v = await wait_done(client, td)
        print("CASE 6 ->", v["status"])
        assert v["status"] == "not_found"

        # === case 7 — duplicate license claim → 409 ===
        te = await dev_token(client, f"verify+e-{suffix}@medidoor.app")
        r = await register(
            client, te,
            license_no="MDh-005",
            owner="someone else", name="copycat", pharmacist="x", regno="x",
        )
        print("CASE 7 dup ->", r.status_code)
        assert r.status_code == 409

        # === case 8 — resubmit not_found account → verified ===
        r = await client.post(
            f"{API}/api/pharmacy/me/verify-resubmit",
            json={
                "pharmacy_license_no": "MDh-010",
                "pharmacy_name": "M/S Sharkar Pharmacy",
                "owner_name": "Mr.Pradep sorkar",
                "pharmacist_name": "Sree Pradep sorkar",
                "pharmacist_reg_no": "B-7322",
            },
            headers={"Authorization": f"Bearer {td}"},
        )
        assert r.status_code == 200, r.text
        v = await wait_done(client, td)
        print("CASE 8 resubmit not_found -> ", v["status"])
        assert v["status"] == "verified"

        print("\nALL CASES PASSED ✅")


if __name__ == "__main__":
    asyncio.run(main())
