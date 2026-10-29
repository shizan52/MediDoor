"""Unit tests for the platform location policy (backend/app/services/geo_policy.py).

Pure-function tests — no server, no DB. Run with the backend venv:

    backend\\.venv\\Scripts\\python.exe tools\\test_geo_policy.py
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ.setdefault("SECRET_KEY", "geo-policy-unit-test-key")

from fastapi import HTTPException  # noqa: E402

from app.services.geo_policy import (  # noqa: E402
    CONNECT_RADIUS_KM,
    RIDER_BROADCAST_RADIUS_KM,
    ensure_within_connect_radius,
    rider_location_is_fresh,
)

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


class FakePharmacy:
    def __init__(self, lat, lng):
        self.lat = lat
        self.lng = lng


def expect_http(name: str, fn, status: int, code: str | None = None) -> None:
    try:
        fn()
    except HTTPException as e:
        ok = e.status_code == status
        if ok and code is not None:
            ok = isinstance(e.detail, dict) and e.detail.get("code") == code
        check(name, ok, f"got {e.status_code} {e.detail}")
        return
    check(name, False, "no exception raised")


def main() -> None:
    # Barishal test-pharmacy coords.
    p = FakePharmacy(22.7009, 90.3676)
    # ~1 km north (0.009° lat ≈ 1 km).
    d = ensure_within_connect_radius(22.7009 + 0.009, 90.3676, p)
    check("1 km point passes and returns distance", d is not None and 0.9 < d < 1.1, str(d))
    # ~4.9 km — inside.
    d = ensure_within_connect_radius(22.7009 + 0.0441, 90.3676, p)
    check("4.9 km point passes", d is not None and d < CONNECT_RADIUS_KM, str(d))
    # ~6 km — outside.
    expect_http(
        "6 km point → 403 out_of_range",
        lambda: ensure_within_connect_radius(22.7009 + 0.054, 90.3676, p),
        403, "out_of_range",
    )
    # Missing location.
    expect_http(
        "missing coords → 400 location_required",
        lambda: ensure_within_connect_radius(None, None, p),
        400, "location_required",
    )
    check(
        "missing coords tolerated when not required",
        ensure_within_connect_radius(None, None, p, require_location=False) is None,
    )
    # Pharmacy without coords can never pass.
    expect_http(
        "pharmacy without coords → out_of_range",
        lambda: ensure_within_connect_radius(22.7, 90.36, FakePharmacy(None, None)),
        403, "out_of_range",
    )

    check("rider broadcast radius == connect radius (5 km)",
          RIDER_BROADCAST_RADIUS_KM == CONNECT_RADIUS_KM == 5.0)

    now = datetime.now(timezone.utc)
    check("fresh ping (2 min) is fresh",
          rider_location_is_fresh(now - timedelta(minutes=2), now=now))
    check("stale ping (30 min) is not fresh",
          not rider_location_is_fresh(now - timedelta(minutes=30), now=now))
    check("no ping is not fresh", not rider_location_is_fresh(None, now=now))
    # Naive datetimes (SQLite) are treated as UTC.
    naive = (now - timedelta(minutes=2)).replace(tzinfo=None)
    check("naive UTC timestamp handled", rider_location_is_fresh(naive, now=now))

    print()
    if FAILURES:
        print(f"❌ {len(FAILURES)} check(s) failed: {FAILURES}")
        sys.exit(1)
    print("✅ All geo-policy checks passed.")


if __name__ == "__main__":
    main()
