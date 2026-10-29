"""Unit tests for the tier exposure engine (backend/app/services/exposure.py).

Pure-function tests — no server, no DB. Run with the backend venv:

    backend\\.venv\\Scripts\\python.exe tools\\test_tier_exposure.py

Verifies the two subscription promises end to end:
  1. "X / 50 customer impressions"  — per-response caps (C=10/B=20/A=30) and
     the 3:2:1 slot-share ratio between tiers in the feed prefix.
  2. "Y / 4 prescription offers"    — each pharmacy is eligible in exactly
     rx_offers_out_of_4 of every 4 consecutive offer rounds, and the gate
     never hides the best-coverage proposal.
"""
from __future__ import annotations
from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402

import os
import random
import sys
from pathlib import Path

# Settings needs SECRET_KEY at import time; these tests never touch the DB
# or JWTs, so any placeholder ≥16 chars works when backend/.env isn't loaded.
os.environ.setdefault("SECRET_KEY", "tier-exposure-unit-test-key")

from app.services.exposure import (  # noqa: E402
    QUALITY_MAX, QUALITY_MIN, RX_ROUND_SECONDS, PharmacyFeed,
    bayesian_rating, gate_rx_candidates, quality_score, rotation_rng,
    rx_offer_window_open, rx_rank_weight, weighted_fair_feed,
)

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def feed(key: str, tier: str, n_items: int, quality: float = 1.0) -> PharmacyFeed:
    return PharmacyFeed(key=key, tier=tier, quality=quality,
                        items=[f"{key}#{i}" for i in range(n_items)])


def owner(item: str) -> str:
    return item.split("#", 1)[0]


# ---------------------------------------------------------------- feed caps
def test_per_response_caps() -> None:
    out = weighted_fair_feed(
        [feed("A1", "A", 100), feed("B1", "B", 100), feed("C1", "C", 100)],
        rng=random.Random(7),
    )
    counts = {k: sum(1 for it in out if owner(it) == k) for k in ("A1", "B1", "C1")}
    check("caps: A=30 B=20 C=10 exactly",
          counts == {"A1": 30, "B1": 20, "C1": 10}, str(counts))
    check("caps: total feed = 60", len(out) == 60, str(len(out)))


def test_solo_pharmacy_cap() -> None:
    out = weighted_fair_feed([feed("C1", "C", 100)], rng=random.Random(1))
    check("solo C capped at 10 per response", len(out) == 10, str(len(out)))


# ------------------------------------------------------------- feed shares
def test_share_ratio_in_prefix() -> None:
    """Before caps bind, slot share must follow tier weights ≈ 3:2:1."""
    fs = [feed("A1", "A", 1000), feed("B1", "B", 1000), feed("C1", "C", 1000)]
    out = weighted_fair_feed(fs, limit=24, rng=random.Random(11))
    counts = {k: sum(1 for it in out if owner(it) == k) for k in ("A1", "B1", "C1")}
    # Ideal over 24 slots: A=12, B=8, C=4. Allow ±2 SWRR jitter.
    check("prefix share A ≈ 12/24", abs(counts["A1"] - 12) <= 2, str(counts))
    check("prefix share B ≈ 8/24", abs(counts["B1"] - 8) <= 2, str(counts))
    check("prefix share C ≈ 4/24", abs(counts["C1"] - 4) <= 2, str(counts))
    check("prefix share order A > B > C",
          counts["A1"] > counts["B1"] > counts["C1"], str(counts))


def test_no_starvation() -> None:
    fs = [feed(f"A{i}", "A", 50) for i in range(5)] + [feed("C1", "C", 50)]
    out = weighted_fair_feed(fs, rng=random.Random(3))
    seen = {owner(it) for it in out}
    check("no starvation: every pharmacy appears",
          seen == {f"A{i}" for i in range(5)} | {"C1"}, str(seen))


def test_same_tier_rotation() -> None:
    """Two same-tier shops must both lead sometimes across rotation buckets."""
    fs = lambda: [feed("A1", "A", 50), feed("A2", "A", 50)]  # noqa: E731
    leaders = set()
    for bucket in range(12):
        rng = rotation_rng("t", now=bucket * 600 + 1)
        leaders.add(owner(weighted_fair_feed(fs(), limit=1, rng=rng)[0]))
    check("same-tier shops take turns leading", leaders == {"A1", "A2"}, str(leaders))


def test_absent_tier_redistributes() -> None:
    out = weighted_fair_feed(
        [feed("B1", "B", 100), feed("C1", "C", 100)], rng=random.Random(5))
    counts = {k: sum(1 for it in out if owner(it) == k) for k in ("B1", "C1")}
    check("no A present: B and C still fill their caps",
          counts == {"B1": 20, "C1": 10}, str(counts))


# ------------------------------------------------------------ rotation rng
def test_rotation_determinism() -> None:
    a = rotation_rng("x", now=1000).random()
    b = rotation_rng("x", now=1100).random()      # same 600 s bucket
    c = rotation_rng("x", now=1700).random()      # next bucket
    d = rotation_rng("y", now=1000).random()      # different salt
    check("same bucket + salt → same rotation", a == b)
    check("next bucket → new rotation", a != c)
    check("different salt → different rotation", a != d)


# ------------------------------------------------------------ quality band
def test_quality_bounds_and_tier_dominance() -> None:
    worst = quality_score(0.0, 1000, 3.0, 3.0)
    best = quality_score(5.0, 1000, 0.0, 3.0)
    check("quality lower bound clamped", worst == QUALITY_MIN, str(worst))
    check("quality stays within upper bound", 1.0 < best <= QUALITY_MAX, str(best))
    new_shop = quality_score(0.0, 0, None)
    check("0-review shop sits at neutral quality ~1.0",
          abs(new_shop - 1.0) < 0.001, str(new_shop))
    check("bayesian prior for new shop", bayesian_rating(0, 0) == 4.0)
    # Plan share must dominate quality: worst A beats best B, worst B beats best C.
    check("tier dominance A>B", 30 * QUALITY_MIN > 20 * QUALITY_MAX)
    check("tier dominance B>C", 20 * QUALITY_MIN > 10 * QUALITY_MAX)
    check("rx rank weight dominance A>B",
          rx_rank_weight("A", QUALITY_MIN) > rx_rank_weight("B", QUALITY_MAX))
    check("rx rank weight dominance B>C",
          rx_rank_weight("B", QUALITY_MIN) > rx_rank_weight("C", QUALITY_MAX))


# --------------------------------------------------------------- rx rounds
def test_rx_offer_round_frequencies() -> None:
    for key in ("pharm-1", "pharm-2", "9f3a", "৫৫-বনানী"):
        for tier, want in (("C", 1), ("B", 2), ("A", 3)):
            got = sum(
                rx_offer_window_open(key, tier, now=r * RX_ROUND_SECONDS + 5)
                for r in range(4)
            )
            check(f"rx rounds {tier}={want}/4 (key={key})", got == want, str(got))
    # Long-run share over 4000 rounds ≈ 25% / 50% / 75%.
    for tier, pct in (("C", 0.25), ("B", 0.5), ("A", 0.75)):
        got = sum(
            rx_offer_window_open("p", tier, now=r * RX_ROUND_SECONDS)
            for r in range(4000)
        ) / 4000
        check(f"rx long-run share {tier} ≈ {pct}", abs(got - pct) < 0.01, str(got))


def test_rx_stagger_between_pharmacies() -> None:
    """All C shops must not blink out simultaneously — phases differ by key."""
    keys = [f"pharmacy-{i}" for i in range(40)]
    some_round = 7 * RX_ROUND_SECONDS
    open_now = sum(rx_offer_window_open(k, "C", now=some_round) for k in keys)
    check("C shops staggered (some open every round)", 0 < open_now < 40, str(open_now))


# ----------------------------------------------------------------- rx gate
def cand(key: str, tier: str, cov: float) -> dict:
    return {"key": key, "tier": tier, "cov": cov}


def run_gate(ranked: list[dict], now: float, min_keep: int = 3) -> list[dict]:
    return gate_rx_candidates(
        ranked,
        is_open=lambda c: rx_offer_window_open(c["key"], c["tier"], now=now),
        coverage=lambda c: c["cov"],
        min_keep=min_keep,
    )


def test_gate_never_loses_best_coverage() -> None:
    # Find a round where this C pharmacy is CLOSED, then prove the gate
    # still keeps it because it holds the best coverage.
    c_key = "only-full-coverage-C"
    closed_round = next(
        r * RX_ROUND_SECONDS for r in range(8)
        if not rx_offer_window_open(c_key, "C", now=r * RX_ROUND_SECONDS)
    )
    ranked = [cand(c_key, "C", 100.0), cand("a1", "A", 60.0), cand("b1", "B", 40.0)]
    kept = run_gate(ranked, closed_round)
    check("gate keeps closed-round C with best coverage",
          kept and kept[0]["key"] == c_key, str([c["key"] for c in kept]))


def test_gate_min_keep_backfill() -> None:
    # Whatever the round, at least min(3, len) candidates must survive.
    ranked = [cand(f"p{i}", "C", 80.0 - i) for i in range(5)]
    for r in range(6):
        kept = run_gate(ranked, r * RX_ROUND_SECONDS)
        check(f"gate keeps ≥3 candidates (round {r})", len(kept) >= 3, str(len(kept)))
        check(f"gate best coverage survives (round {r})",
              kept[0]["cov"] == 80.0, str(kept[0]))


def test_gate_open_candidates_keep_rank_order() -> None:
    ranked = [cand("x", "A", 90.0), cand("y", "A", 90.0),
              cand("z", "A", 70.0), cand("w", "A", 50.0)]
    # A-tier: find a round where all four are open (75% each → common).
    for r in range(16):
        now = r * RX_ROUND_SECONDS
        if all(rx_offer_window_open(c["key"], "A", now=now) for c in ranked):
            kept = run_gate(ranked, now)
            check("gate preserves rank order when all open",
                  [c["key"] for c in kept] == ["x", "y", "z", "w"],
                  str([c["key"] for c in kept]))
            return
    check("found a round with all A open", False)


def main() -> None:
    test_per_response_caps()
    test_solo_pharmacy_cap()
    test_share_ratio_in_prefix()
    test_no_starvation()
    test_same_tier_rotation()
    test_absent_tier_redistributes()
    test_rotation_determinism()
    test_quality_bounds_and_tier_dominance()
    test_rx_offer_round_frequencies()
    test_rx_stagger_between_pharmacies()
    test_gate_never_loses_best_coverage()
    test_gate_min_keep_backfill()
    test_gate_open_candidates_keep_rank_order()

    print()
    if FAILURES:
        print(f"❌ {len(FAILURES)} check(s) failed: {FAILURES}")
        sys.exit(1)
    print("✅ All tier-exposure checks passed.")


if __name__ == "__main__":
    main()
