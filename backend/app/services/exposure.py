"""Tier exposure engine — the ONE place where a pharmacy's subscription
plan (C / B / A) translates into real customer-facing exposure.

The subscription cards make two concrete promises
(`pharmacy_ops.TIER_RULES`):

1. **"X / 50 customer impressions"** — in any listing shown to a customer
   (storefront nearby feed, symptom-search results) one pharmacy may occupy
   at most X of every 50 slots (C=10, B=20, A=30), and between pharmacies
   the slot SHARE follows the same 30:20:10 (= 3:2:1) weight ratio — an A
   pharmacy earns ~3× the impressions of a C pharmacy standing next to it.
2. **"Y / 4 prescription offers"** — out of every 4 Smart-Prescription
   offer rounds, the pharmacy is eligible to appear in the proposal list
   Y times (C=1, B=2, A=3). Customer safety valve: the gate NEVER hides
   the best-coverage option — prescriptions must be fulfillable first.

Design rules:
- Tier controls SHARE; quality (rating + distance) only nudges order
  WITHIN a tier (±15%, clamped so it can never flip adjacent tiers).
- Everything is pure and deterministic given (now, rng) so it is
  DB-free and unit-testable — see tools/test_tier_exposure.py.
"""
from __future__ import annotations

import hashlib
import random
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Sequence

from app.services.pharmacy_ops import tier_rules

# The customer feed re-rotates every 10 minutes: stable enough that a
# refresh doesn't jarringly reshuffle, fresh enough that same-tier
# pharmacies take turns at the top during the day.
FEED_ROTATION_SECONDS = 600

# Prescription offers run in 15-minute global rounds. Each pharmacy is
# staggered by a stable hash so all C-tier shops never blink out together.
RX_ROUND_SECONDS = 900

# Bayesian smoothing so a brand-new pharmacy (0 ratings) starts at the
# prior instead of 0 and can't be buried before its first review.
RATING_PRIOR_MEAN = 4.0
RATING_PRIOR_WEIGHT = 5.0

# Quality may nudge exposure ±15% within a tier — never enough to flip
# adjacent tiers (worst A: 30×0.85 = 25.5 still beats best B: 20×1.15 = 23).
QUALITY_MIN = 0.85
QUALITY_MAX = 1.15


def bayesian_rating(rating: float | None, rating_count: int | None) -> float:
    """Rating smoothed toward the prior — protects 0-review pharmacies."""
    r = float(rating or 0.0)
    n = max(0, int(rating_count or 0))
    return (r * n + RATING_PRIOR_MEAN * RATING_PRIOR_WEIGHT) / (n + RATING_PRIOR_WEIGHT)


def quality_score(
    rating: float | None,
    rating_count: int | None,
    distance_km: float | None = None,
    radius_km: float = 3.0,
) -> float:
    """Within-tier quality multiplier in [QUALITY_MIN, QUALITY_MAX].

    ±0.05 per star away from the prior mean, plus up to ±0.06 for being
    near/far inside the radius. Deliberately small: plan share dominates,
    quality only orders pharmacies inside the same plan.
    """
    q = 1.0 + (bayesian_rating(rating, rating_count) - RATING_PRIOR_MEAN) * 0.05
    if distance_km is not None and radius_km > 0:
        centred = 0.5 - min(max(distance_km, 0.0) / radius_km, 1.0)  # +0.5 near … -0.5 far
        q += centred * 0.06
    return max(QUALITY_MIN, min(QUALITY_MAX, q))


def rotation_rng(*salt: Any, now: float | None = None,
                 bucket_seconds: int = FEED_ROTATION_SECONDS) -> random.Random:
    """Deterministic RNG that rotates every `bucket_seconds`.

    Same inputs within one time bucket → same feed (cache/UX friendly);
    next bucket → new rotation. Replaces the old fixed Random(42) which
    never actually rotated anything.
    """
    bucket = int((now if now is not None else time.time()) // bucket_seconds)
    material = ":".join([str(bucket), *(str(s) for s in salt)])
    seed = int(hashlib.sha256(material.encode("utf-8")).hexdigest()[:16], 16)
    return random.Random(seed)


def _stable_hash(key: Any) -> int:
    """Process-independent stable hash (Python's hash() is salted per run)."""
    return int(hashlib.sha256(str(key).encode("utf-8")).hexdigest()[:8], 16)


# --------------------------------------------------------------------------
# Promise 1 — "X / 50 customer impressions"
# --------------------------------------------------------------------------

@dataclass
class PharmacyFeed:
    """One pharmacy's contribution to a customer listing."""
    key: Any                 # pharmacy id
    tier: str                # "A" | "B" | "C"
    quality: float           # quality_score(...) result
    items: List[Any]         # serialized items, best/rotated order first


def weighted_fair_feed(
    feeds: Sequence[PharmacyFeed],
    *,
    limit: int | None = None,
    rng: random.Random | None = None,
) -> List[Any]:
    """Merge per-pharmacy item lists into ONE customer feed.

    Smooth weighted round-robin (nginx SWRR) at the pharmacy level with
    weight = impressions_per_50(tier) × quality:

    - SHARE: each pharmacy's slot share is proportional to its weight —
      A ≈ 3× C, B ≈ 2× C, automatically redistributed when a tier is absent.
    - CAP: one pharmacy holds at most impressions_per_50 slots per response
      (C=10 / B=20 / A=30) — same hard cap the subscription card promises.
    - NO STARVATION: every pharmacy with eligible stock appears; SWRR
      spreads slots evenly instead of letting one shop monopolise the top.
    """
    rng = rng or random.Random()
    peers: List[Dict[str, Any]] = []
    for f in feeds:
        if not f.items:
            continue
        cap = int(tier_rules(f.tier)["impressions_per_50"])
        weight = cap * max(QUALITY_MIN, min(QUALITY_MAX, f.quality))
        peers.append({
            "feed": f,
            "idx": 0,
            "ew": weight,
            # Random initial credit rotates which same-tier shop leads.
            "cw": rng.uniform(0.0, weight),
            "cap": cap,
            "used": 0,
        })

    out: List[Any] = []
    while peers and (limit is None or len(out) < limit):
        live = [p for p in peers if p["used"] < p["cap"]]
        if not live:
            break  # every remaining pharmacy hit its per-response cap
        total = sum(p["ew"] for p in live)
        best: Dict[str, Any] | None = None
        for p in live:
            p["cw"] += p["ew"]
            if best is None or p["cw"] > best["cw"]:
                best = p
        assert best is not None
        best["cw"] -= total
        feed = best["feed"]
        out.append(feed.items[best["idx"]])
        best["idx"] += 1
        best["used"] += 1
        if best["idx"] >= len(feed.items):
            peers.remove(best)
    return out


# --------------------------------------------------------------------------
# Promise 2 — "Y / 4 prescription offers"
# --------------------------------------------------------------------------

def rx_offer_window_open(pharmacy_key: Any, tier: str | None,
                         *, now: float | None = None) -> bool:
    """True iff this pharmacy is inside one of its eligible offer rounds.

    Time is cut into RX_ROUND_SECONDS rounds; each pharmacy is offset by a
    stable hash and is eligible in `rx_offers_out_of_4` of every 4 rounds:
    C → 1/4 of the time, B → 2/4, A → 3/4.
    """
    allowed = int(tier_rules(tier)["rx_offers_out_of_4"])
    if allowed >= 4:
        return True
    rnd = int((now if now is not None else time.time()) // RX_ROUND_SECONDS)
    return (rnd + _stable_hash(pharmacy_key)) % 4 < allowed


def rx_rank_weight(tier: str | None, quality: float) -> float:
    """Tie-break weight for equally-covering rx proposals: offer share ×
    quality. Quality is clamped so tiers can never flip (3×0.85 > 2×1.15)."""
    share = int(tier_rules(tier)["rx_offers_out_of_4"])
    return share * max(QUALITY_MIN, min(QUALITY_MAX, quality))


def gate_rx_candidates(
    ranked: List[Any],
    *,
    is_open: Callable[[Any], bool],
    coverage: Callable[[Any], float],
    min_keep: int = 3,
) -> List[Any]:
    """Apply the offer-round gate to an already-ranked candidate list
    (best first) WITHOUT ever hurting the customer:

    - the best available coverage is never gated away — if every pharmacy
      holding the top coverage is out-of-round, they are restored;
    - at least `min_keep` candidates survive whenever that many exist
      (backfilled from gated-out ones in rank order).
    """
    if not ranked:
        return []
    best_cov = coverage(ranked[0])
    kept: List[Any] = []
    dropped: List[Any] = []
    for c in ranked:
        (kept if is_open(c) else dropped).append(c)

    if not kept or coverage(kept[0]) < best_cov:
        restore = [c for c in dropped if coverage(c) >= best_cov]
        kept = restore + kept
        dropped = [c for c in dropped if coverage(c) < best_cov]

    while len(kept) < min_keep and dropped:
        kept.append(dropped.pop(0))
    return kept
