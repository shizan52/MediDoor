# -*- coding: utf-8 -*-
"""Prove /api/geo/* degrades gracefully when Barikoi is dead (429/network),
instead of 502-ing and breaking every screen."""
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import sys
import asyncio
from pathlib import Path


import os
os.environ.setdefault("SECRET_KEY", "geo-fallback-test-key-xxxxxxxx")
os.environ.setdefault("BARIKOI_API_KEY", "fake-key-to-force-upstream-path")

from app.core.config import settings  # noqa: E402
settings.BARIKOI_API_KEY = "fake-key-to-force-upstream-path"

import httpx  # noqa: E402
from app.api.routes import geo  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


class FakeResp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


def patch_get(behaviour):
    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None, headers=None):
            return behaviour(url, params)

    geo.httpx.AsyncClient = FakeClient


async def main():
    # --- 1. Barikoi returns 429 (the real production failure) ---
    patch_get(lambda url, params: FakeResp(429, {"message": "rate limit"}))
    geo._REVERSE_CACHE.clear()

    r = await geo.reverse_geocode(lat=22.7012, lng=90.3678)
    check("reverse: 429 -> fallback (no 502)", r["source"] == "fallback", str(r))
    check("reverse: fallback carries coords", r["lat"] == 22.7012 and r["address_bn"] == "আপনার অবস্থান")
    check("reverse: fallback label is NEVER raw coordinates",
          r["label"] == "আপনার অবস্থান" and r["address"] is None, str(r))

    a = await geo.autocomplete(q="banani", city=None, limit=8)
    check("autocomplete: 429 -> empty items (no 502)", a["source"] == "fallback" and a["items"] == [], str(a))

    rt = await geo.route(from_lat=22.7, from_lng=90.3, to_lat=22.8, to_lng=90.4)
    check("route: 429 -> null geometry (no 502)", rt["source"] == "fallback" and rt["geometry"] is None, str(rt))

    # --- 2. Network blow-up (timeout / DNS) ---
    def boom(url, params):
        raise httpx.ConnectTimeout("upstream dead")

    patch_get(boom)
    geo._REVERSE_CACHE.clear()
    r2 = await geo.reverse_geocode(lat=23.79, lng=90.40)
    check("reverse: network error -> fallback (no 502)", r2["source"] == "fallback", str(r2))

    # --- 3. Happy path still works + gets cached (quota saver) ---
    calls = {"n": 0}

    def ok(url, params):
        calls["n"] += 1
        return FakeResp(200, {"place": {"address": "Banani, Dhaka", "area": "Banani", "city": "Dhaka"}})

    patch_get(ok)
    geo._REVERSE_CACHE.clear()
    a1 = await geo.reverse_geocode(lat=23.7937, lng=90.4066)
    check("reverse: happy path returns barikoi data", a1["source"] == "barikoi" and a1["address"] == "Banani, Dhaka")
    check("reverse: happy path carries a written label", a1["label"] == "Banani, Dhaka", str(a1))
    a2 = await geo.reverse_geocode(lat=23.79371, lng=90.40662)  # same ~11 m cell
    check("reverse: repeat lookup served from cache (quota saved)", calls["n"] == 1 and a2["address"] == "Banani, Dhaka",
          f"upstream calls={calls['n']}")

    # --- 4. Barikoi dead but OSM Nominatim alive → real road name, not numbers ---
    def barikoi_dead_osm_ok(url, params):
        if "nominatim" in url:
            return FakeResp(200, {
                "display_name": "Gorachand Das Road, Barishal, Barisal Division, 8200, Bangladesh",
                "address": {"road": "Gorachand Das Road", "city": "Barishal", "postcode": "8200",
                            "state": "Barisal Division", "country": "Bangladesh"},
            })
        return FakeResp(429, {"message": "rate limit"})

    patch_get(barikoi_dead_osm_ok)
    geo._REVERSE_CACHE.clear()
    o = await geo.reverse_geocode(lat=22.701, lng=90.3535)
    check("reverse: barikoi 429 -> OSM second chance gives road name",
          o["source"] == "osm" and o["label"] == "Gorachand Das Road, Barishal", str(o))

    # --- 5. _friendly_label never leaks coordinate strings ---
    check("label guard: coordinate address is rejected",
          geo._friendly_label({"address": "22.70123, 90.36789", "area": "Kawnia", "city": "Barishal"})
          == "Kawnia, Barishal")
    check("label guard: everything missing -> generic Bengali label",
          geo._friendly_label({}) == "আপনার অবস্থান")

    print()
    if FAILS:
        print(f"❌ {len(FAILS)} failed: {FAILS}")
        sys.exit(1)
    print("✅ geo endpoints degrade gracefully — Barikoi outage can no longer break the app.")


asyncio.run(main())
