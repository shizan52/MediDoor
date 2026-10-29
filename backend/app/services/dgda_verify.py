"""
DGDA (Directorate General of Drug Administration, Bangladesh) automated
pharmacy verification.

Source: https://www.dgdagov.info/index.php/pharmacies/allopathic-retail-pharmacy

That page renders a server-side DataTables grid; the actual data endpoint is
`POST /administrator/components/com_jcode/source/serverProcessing.php`
(form-encoded). We pass `action=getPharmacyDataView` and `sSearch=<license>`
and parse the `aaData` rows.

aaData row layout (observed from the live `pharmacy_view-02.js` and HAR):
    [ 0]  internal_id
    [ 1]  serial number
    [ 2]  division_name
    [ 3]  district / upazila
    [ 4]  pharmacy_name           <-- "Sayem Medical Hall"
    [ 5]  license_no              <-- "BS-0011/AB"
    [ 6]  pharmacy_code           <-- "BAR-000007"
    [ 7]  issue_date
    [ 8]  "<span ...>valid_until</span>"
    [ 9]  "<img class='pMore' .../>"
    [10]  region
    [11]  drug_seller_name        <-- "A K M Habibur Rahman"  (Pharmacist Name)
    [12]  owner_name              <-- "Gouranga Chandra Talukder" (Proprietor Name)
    [13]  address
    [14]  ""
    [15]  drug_seller_code
    [16]  division_id
    [17]  district_id
    [18]  upazila_id
    [19]  "0000-00-00"
    [20]  ""

The DGDA detail popup labels `[11]` as Pharmacist Name and `[12]` as
Proprietor Name; keep that mapping strict so owner and pharmacist fields are
not accidentally accepted when swapped.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from html import unescape
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

DGDA_ENDPOINT = (
    "https://www.dgdagov.info/administrator/components/com_jcode/source/"
    "serverProcessing.php"
)
DGDA_REFERER = (
    "https://www.dgdagov.info/index.php/pharmacies/allopathic-retail-pharmacy"
)
DGDA_TIMEOUT = 20.0
# Token-based (Jaccard) name match thresholds. Tightened (N3) to reduce
# impersonation via public DGDA data — a closer match is now required before
# owner/pharmacy/pharmacist names are accepted.
NAME_MATCH_THRESHOLD = 0.75       # owner (was 0.62)
PHARMACY_MATCH_THRESHOLD = 0.67   # pharmacy (was 0.55)
PHARMACIST_NAME_THRESHOLD = 0.67  # pharmacist (was 0.55)
MIN_ACCEPTABLE_RENEWAL_DATE = date(2013, 1, 1)  # legacy floor (kept for ref)

# N2 — licenses in Bangladesh are often not kept renewed. We accept a license
# whose validity expired up to this many years ago, but flag it so the
# pharmacy is told to renew. Older than this → rejected as too stale.
LICENSE_GRACE_YEARS = 6

# N6 — DGDA rows whose pharmacy name is a placeholder (no real name). Compared
# after lower-casing and stripping spaces.
_PLACEHOLDER_PHARMACY_NAMES = {"nameofpharmacy", "pharmacyname", "name", "n/a", "na", "-"}


def _years_ago(d: date, years: int) -> date:
    """`d` minus `years`, safely handling Feb 29."""
    try:
        return d.replace(year=d.year - years)
    except ValueError:
        return d.replace(year=d.year - years, day=28)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class VerificationResult:
    status: str  # "verified" | "expired" | "mismatch" | "not_found" | "error"
    message: str
    mismatch_fields: list[str] = field(default_factory=list)
    dgda_record: Optional[dict[str, Any]] = None
    # True when verified-but-expired (within the grace window) — the caller
    # should nudge the pharmacy to renew its DGDA license.
    needs_renewal: bool = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_PUNCT_RE = re.compile(r"[^a-z0-9\u0980-\u09ff\s]+")
_WS_RE = re.compile(r"\s+")
# Common English honorifics / generic suffixes that shouldn't dominate matching.
_NAME_STOPWORDS = {
    "md", "mst", "mr", "mrs", "ms", "dr", "mohammad", "muhammad", "mohd",
    "alhaj", "haji", "hajee", "shri", "sri", "smt",
}
_PHARMACY_STOPWORDS = {
    "medical", "hall", "pharmacy", "medicine", "drug", "house", "center",
    "centre", "store", "stores", "corner", "store", "limited", "ltd", "co",
    "and", "the", "a", "an", "of",
}


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "")


def _normalize(text: str) -> str:
    s = unescape(text or "").lower()
    s = _strip_html(s)
    # Remove dot-after-honorific etc., but keep bengali range.
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


def _tokenize_name(text: str, *, stopwords: set[str]) -> set[str]:
    norm = _normalize(text)
    return {tok for tok in norm.split() if tok and tok not in stopwords and len(tok) > 1}


def _name_similarity(a: str, b: str, *, stopwords: set[str]) -> float:
    """Jaccard similarity of significant tokens. 0..1."""
    ta = _tokenize_name(a, stopwords=stopwords)
    tb = _tokenize_name(b, stopwords=stopwords)
    if not ta or not tb:
        return 0.0
    inter = ta & tb
    union = ta | tb
    return len(inter) / len(union)


def _normalize_license(license_no: str) -> str:
    """Licenses are case- and space-insensitive ("BS-0011/AB" == "bs0011/ab")."""
    s = (license_no or "").strip().lower()
    s = re.sub(r"\s+", "", s)
    return s


def _normalize_reg_no(reg_no: str) -> str:
    """Pharmacist registration numbers ("B-00270", "C-44554", "17660")
    are matched case-insensitive with all separators removed and any leading
    zeroes stripped from the numeric tail. The DGDA registry sometimes
    omits the prefix entirely (just "17660") so we also keep a
    digits-only variant for fallback comparison."""
    s = (reg_no or "").strip().lower()
    s = re.sub(r"[\s\-_/.,]+", "", s)
    return s


def _reg_no_matches(user: str, registry: str) -> bool:
    a = _normalize_reg_no(user)
    b = _normalize_reg_no(registry)
    if not a or not b:
        return False
    if a == b:
        return True
    # Strip leading zeros from numeric tail and compare digits-only fallback.
    a_digits = re.sub(r"\D", "", a).lstrip("0")
    b_digits = re.sub(r"\D", "", b).lstrip("0")
    return bool(a_digits) and a_digits == b_digits


_DATE_PATTERNS = ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y")


def _parse_dgda_date(raw: str) -> date | None:
    """Parse the DGDA registry's date strings (typically DD-MM-YYYY).
    Returns None for empty/garbage values like "0000-00-00"."""
    s = (raw or "").strip()
    if not s or s.startswith("0000"):
        return None
    for fmt in _DATE_PATTERNS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# DGDA HTTP client
# ---------------------------------------------------------------------------


async def _query_dgda(license_no: str) -> list[list[Any]]:
    """Hit the DGDA serverProcessing endpoint with `sSearch=<license>` and
    return the raw `aaData` list. Raises httpx errors on transport failure."""
    form = {
        "sEcho": "1",
        "iColumns": "10",
        "sColumns": "",
        "iDisplayStart": "0",
        "iDisplayLength": "25",
        "sSearch": license_no.strip(),
        "bRegex": "false",
        "iSortingCols": "0",
        "action": "getPharmacyDataView",
        "DistrictId": "",
        "UpazilaId": "",
        "validuptoDateId": "",
        "Ptype": "Al",
    }
    # DataTables also expects per-column sSearch_* / bSearchable_* fields. The
    # endpoint accepts the request fine without them in our HAR-replay tests,
    # so we keep the payload minimal.
    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Origin": "https://www.dgdagov.info",
        "Referer": DGDA_REFERER,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
        ),
    }
    async with httpx.AsyncClient(timeout=DGDA_TIMEOUT, follow_redirects=True) as client:
        resp = await client.post(DGDA_ENDPOINT, data=form, headers=headers)
        resp.raise_for_status()
        try:
            data = resp.json()
        except json.JSONDecodeError:
            # The endpoint sometimes returns text/html with a JSON body.
            data = json.loads(resp.text)
    aa = data.get("aaData") if isinstance(data, dict) else None
    if not isinstance(aa, list):
        return []
    return aa


def _row_to_record(row: list[Any]) -> dict[str, Any]:
    """Project the DGDA row into a sane dict (best-effort, defensive)."""
    def at(i: int) -> str:
        try:
            return str(row[i]) if row[i] is not None else ""
        except IndexError:
            return ""
    valid_until_raw = _strip_html(at(8)).strip()
    valid_until_date = _parse_dgda_date(valid_until_raw)
    # N2 — evaluate the validity date against TODAY with a grace window.
    today = date.today()
    grace_cutoff = _years_ago(today, LICENSE_GRACE_YEARS)
    is_currently_expired = bool(valid_until_date and valid_until_date < today)
    expired_beyond_grace = bool(valid_until_date and valid_until_date < grace_cutoff)
    # Verified but expired within the grace window → ask them to renew.
    needs_renewal = is_currently_expired and not expired_beyond_grace
    return {
        "dgda_id": at(0),
        "division": at(2),
        "district": at(3),
        "pharmacy_name": at(4),
        "license_no": at(5),
        "pharmacy_code": at(6),
        "issue_date": at(7),
        "valid_until": valid_until_raw,
        "valid_until_iso": valid_until_date.isoformat() if valid_until_date else None,
        # `is_expired`/`renewal_too_old` now mean "too stale to accept at all"
        # (expired beyond the grace window) — kept names for backward compat.
        "is_expired": expired_beyond_grace,
        "renewal_too_old": expired_beyond_grace,
        "is_currently_expired": is_currently_expired,
        "expired_beyond_grace": expired_beyond_grace,
        "needs_renewal": needs_renewal,
        "owner_name": at(12),
        "drug_seller_name": at(11),
        "address": at(13),
        "drug_seller_code": at(15),
    }


# ---------------------------------------------------------------------------
# Public verification entry point
# ---------------------------------------------------------------------------


async def verify_pharmacy(
    *,
    license_no: str,
    owner_name: str,
    pharmacy_name: str,
    pharmacist_name: str = "",
    pharmacist_reg_no: str = "",
) -> VerificationResult:
    """Look the license up at DGDA and compare the supplied owner + pharmacy +
    pharmacist details. Returns a structured result; never raises
    (errors → status="error").

    Match rules:
      * pharmacy_name  → fuzzy against registry [4]  pharmacy_name
    * owner_name     → fuzzy against registry [12] proprietor_name
    * pharmacist_name→ fuzzy against registry [11] drug_seller_name
      * pharmacist_reg_no→ normalized exact against registry [15] drug_seller_code
    * valid_until    → block only if before 2013; newer historical renewals are accepted
    """
    license_no = (license_no or "").strip()
    owner_name = (owner_name or "").strip()
    pharmacy_name = (pharmacy_name or "").strip()
    pharmacist_name = (pharmacist_name or "").strip()
    pharmacist_reg_no = (pharmacist_reg_no or "").strip()
    if not license_no or not owner_name or not pharmacy_name:
        return VerificationResult(
            status="error",
            message="License number, owner name এবং pharmacy name — তিনটাই দরকার।",
        )

    target_license = _normalize_license(license_no)
    # Try the search; if the network fails we surface "error" and the
    # background worker can retry.
    try:
        rows = await _query_dgda(license_no)
    except (httpx.HTTPError, asyncio.TimeoutError, json.JSONDecodeError) as exc:
        logger.warning("dgda lookup failed: %s", exc)
        return VerificationResult(
            status="error",
            message="DGDA সার্ভারে এখন সংযোগ করা যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করা হবে।",
        )

    # Find the row whose license matches exactly (normalized).
    matching = None
    for row in rows:
        try:
            if _normalize_license(str(row[5])) == target_license:
                matching = row
                break
        except (IndexError, TypeError):
            continue

    if matching is None:
        return VerificationResult(
            status="not_found",
            message=(
                f"DGDA registry-তে এই license number '{license_no}' খুঁজে পাওয়া যায়নি। "
                "সঠিক DGDA Pharmacy License Number লিখে আবার চেষ্টা করুন।"
            ),
            mismatch_fields=["pharmacy_license_no"],
        )

    record = _row_to_record(matching)

    mismatch: list[str] = []

    # --- pharmacy name ---
    pharmacy_score = _name_similarity(
        pharmacy_name, record["pharmacy_name"], stopwords=_PHARMACY_STOPWORDS
    )
    # N6 — when the registry row carries a placeholder pharmacy name
    # ("nameofpharmacy") there is nothing real to match against. Previously the
    # check was *skipped*, so ANY name passed. Instead, flag it so it cannot
    # auto-verify and falls to manual admin document review.
    placeholder_pharmacy = (
        record["pharmacy_name"].strip().lower().replace(" ", "") in _PLACEHOLDER_PHARMACY_NAMES
    )
    if placeholder_pharmacy:
        mismatch.append("pharmacy_name")
    elif pharmacy_score < PHARMACY_MATCH_THRESHOLD:
        mismatch.append("pharmacy_name")

    # --- owner ---
    owner_score = _name_similarity(
        owner_name, record["owner_name"], stopwords=_NAME_STOPWORDS
    )
    if owner_score < NAME_MATCH_THRESHOLD:
        mismatch.append("owner_name")

    # --- pharmacist (only when supplied; legacy callers may omit) ---
    if pharmacist_name:
        ph_score = _name_similarity(
            pharmacist_name, record["drug_seller_name"], stopwords=_NAME_STOPWORDS
        )
        if ph_score < PHARMACIST_NAME_THRESHOLD:
            mismatch.append("pharmacist_name")
    if pharmacist_reg_no:
        if not _reg_no_matches(pharmacist_reg_no, record["drug_seller_code"]):
            mismatch.append("pharmacist_reg_no")

    if mismatch:
        bn_field = {
            "pharmacy_name": "Pharmacy name",
            "owner_name": "Owner name",
            "pharmacist_name": "Pharmacist name",
            "pharmacist_reg_no": "Pharmacist registration no.",
        }
        wrong = " ও ".join(bn_field.get(f, f) for f in mismatch)
        if placeholder_pharmacy and mismatch == ["pharmacy_name"]:
            # N6 — only the (placeholder) name couldn't be confirmed; everything
            # else matched. Route to manual review instead of a blunt rejection.
            msg = (
                "License + owner + pharmacist তথ্য DGDA registry-তে মিলে গেছে, কিন্তু "
                "registry-তে এই license-এর pharmacy নাম placeholder হিসেবে আছে — তাই নাম "
                "auto-verify করা যাচ্ছে না। MediDoor admin আপনার upload করা license "
                "document দেখে manually verify করবে।"
            )
        else:
            msg = (
                f"License number সঠিক, কিন্তু DGDA registry-তে আপনার দেওয়া {wrong} মিলছে না। "
                "সঠিক তথ্য দিয়ে আবার submit করুন।"
            )
        return VerificationResult(
            status="mismatch",
            message=msg,
            mismatch_fields=mismatch,
        )

    # All identity fields matched — now check the validity date (N2). We accept
    # licenses that are still valid, never had a date, or expired within the
    # last LICENSE_GRACE_YEARS years. Only reject ones that are *too stale*.
    if record.get("expired_beyond_grace"):
        return VerificationResult(
            status="expired",
            message=(
                f"আপনার সব তথ্য DGDA registry-তে মিলে গেছে, কিন্তু license-এর মেয়াদ "
                f"({record['valid_until']}) {LICENSE_GRACE_YEARS} বছরেরও আগে শেষ হয়ে গেছে — "
                "এত পুরোনো record approve করা হয় না। DGDA থেকে renew করে আবার submit করুন।"
            ),
            mismatch_fields=["valid_until"],
            dgda_record=record,
        )

    needs_renewal = bool(record.get("needs_renewal"))
    base_msg = (
        f"DGDA registry-তে আপনার pharmacy verified। "
        f"License: {record['license_no']} — মেয়াদ: {record['valid_until'] or 'অজানা'}। "
        f"ফার্মাসিস্ট: {record['drug_seller_name']} ({record['drug_seller_code']})।"
    )
    if needs_renewal:
        base_msg += (
            " ⚠️ আপনার license-এর মেয়াদ শেষ হয়ে গেছে — অনুগ্রহ করে DGDA থেকে renew "
            "করে নিন (আপাতত আপনি চালু রাখতে পারবেন)।"
        )
    return VerificationResult(
        status="verified",
        message=base_msg,
        dgda_record=record,
        needs_renewal=needs_renewal,
    )
