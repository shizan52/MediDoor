"""
Medi AI — Gemini-powered chat endpoint.

Knowledge + system prompt come from `backend/content/medi_ai.json`,
which is editable from the desktop `admin.py` app.

Endpoint:
    POST /api/ai/chat   { messages: [{role: "user"|"assistant", content: "..."}], }
                        -> { reply: "...", model: "..." }
"""
from __future__ import annotations

import base64
import difflib
import json
import math
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Literal
from urllib.parse import urlparse
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_account, get_db
from app.core.config import settings
from app.core.security import decode_token
from app.services.gemini_keys import key_pool
from app.services import ai_quota
from app.services.customer_policy import ensure_customer_not_banned
from app.services.delivery import delivery_fee_for_distance
from app.services.stock import reserve_items_stock
from app.models import (
    Account,
    Conversation,
    ConversationMessage,
    CustomerProfile,
    Medicine,
    MedicineCategory,
    Order,
    OrderMessage,
    OrderStatus,
    PharmacyProfile,
    RoleEnum,
    SenderRole,
)
from app.services.exposure import (
    PharmacyFeed, gate_rx_candidates, quality_score, rotation_rng,
    rx_offer_window_open, rx_rank_weight, weighted_fair_feed,
)
from app.services.geo_policy import (
    CONNECT_RADIUS_KM as GEO_CONNECT_RADIUS_KM,
    ensure_within_connect_radius,
    location_required_error,
)
from app.services.pharmacy_ops import is_open_now, tier_rules

router = APIRouter(prefix="/api/ai", tags=["ai"])

KNOWLEDGE_FILE = Path(__file__).resolve().parents[3] / "content" / "medi_ai.json"

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

# How long to keep a key out of rotation after a failure.
_KEY_COOLDOWN_RATELIMIT = 180.0   # 429 — quota / per-minute cap
_KEY_COOLDOWN_SERVER = 60.0       # 5xx — transient upstream
_KEY_COOLDOWN_TRANSPORT = 30.0    # network / timeout

# Status codes that should NOT trigger a key rotation (real client errors).
_NO_ROTATE_STATUS = {400, 404, 422}


async def _call_gemini(
    model: str,
    body: Dict[str, Any],
    *,
    timeout: float = 30.0,
) -> httpx.Response | None:
    """POST to Gemini with automatic key rotation.

    Tries every key in the pool once per call. On 429/5xx/transport errors
    the failing key is cooled-down for a few minutes and the next healthy
    key is tried. Returns the FIRST successful (status<400) response, or the
    LAST non-2xx response if every key failed, or None if no keys exist /
    every attempt raised a transport error.
    """
    if not key_pool.has_keys():
        return None

    url = GEMINI_URL.format(model=model)
    last_resp: httpx.Response | None = None
    tried: set[str] = set()
    # Bound the loop by the pool size + 1 so we never spin forever.
    max_attempts = max(1, len(settings.gemini_api_keys_list)) + 1

    async with httpx.AsyncClient(timeout=timeout) as client:
        for _ in range(max_attempts):
            key = key_pool.next()
            if not key or key in tried:
                break
            tried.add(key)
            try:
                resp = await client.post(url, params={"key": key}, json=body)
            except httpx.HTTPError as exc:
                print(f"[gemini] transport error on key …{key[-6:]}: {exc!r}")
                key_pool.mark_bad(key, cooldown=_KEY_COOLDOWN_TRANSPORT)
                continue

            if resp.status_code < 400:
                key_pool.mark_good(key)
                return resp

            last_resp = resp
            if resp.status_code == 429:
                print(f"[gemini] 429 on key …{key[-6:]} — rotating")
                key_pool.mark_bad(key, cooldown=_KEY_COOLDOWN_RATELIMIT)
                continue
            if resp.status_code >= 500:
                print(f"[gemini] {resp.status_code} on key …{key[-6:]} — rotating")
                key_pool.mark_bad(key, cooldown=_KEY_COOLDOWN_SERVER)
                continue
            if resp.status_code in _NO_ROTATE_STATUS:
                # client error (bad request etc.) — rotation won't help
                return resp
            # Unknown 4xx — try one more key just in case (e.g. 401 invalid key)
            print(f"[gemini] {resp.status_code} on key …{key[-6:]} — rotating")
            key_pool.mark_bad(key, cooldown=_KEY_COOLDOWN_SERVER)

    return last_resp


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatIn(BaseModel):
    messages: List[ChatMessage] = Field(min_length=1, max_length=20)


class ChatOut(BaseModel):
    reply: str
    model: str


def _load_knowledge() -> Dict[str, Any]:
    if not KNOWLEDGE_FILE.exists():
        return {"name": "medi AI", "system_prompt": "", "knowledge": []}
    try:
        return json.loads(KNOWLEDGE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"name": "medi AI", "system_prompt": "", "knowledge": []}


def _build_system_text(cfg: Dict[str, Any]) -> str:
    sp = (cfg.get("system_prompt") or "").strip()
    chunks = cfg.get("knowledge") or []
    knowledge_text = "\n".join(f"- {c}" for c in chunks if str(c).strip())
    if knowledge_text:
        return f"{sp}\n\nMediDoor knowledge:\n{knowledge_text}"
    return sp


def _client_ip(request: Request) -> str:
    """Best-effort real client IP, honoring Cloudflare / reverse-proxy headers.

    Behind the Cloudflare tunnel, `request.client.host` is the proxy's IP (same
    for everyone), so we must read the forwarded headers to identify the actual
    visitor — otherwise the per-IP guest limit would lump all guests together.
    """
    cf = request.headers.get("cf-connecting-ip")
    if cf and cf.strip():
        return cf.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff and xff.strip():
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _is_authenticated(authorization: str) -> bool:
    """True if a valid access token is present (no DB hit needed)."""
    if not authorization.lower().startswith("bearer "):
        return False
    payload = decode_token(authorization.split(" ", 1)[1].strip())
    return bool(payload and payload.get("type") == "access")


@router.post("/chat", response_model=ChatOut)
async def chat(
    payload: ChatIn,
    request: Request,
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> ChatOut:
    if not key_pool.has_keys():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Medi AI is not configured (no Gemini API key).",
        )

    # Cost gate: logged-in users chat freely (every message is AI-moderated);
    # guests get a small daily allowance per IP, then must log in. The bump is
    # only committed if the Gemini call succeeds (it rolls back on error).
    authed = _is_authenticated(authorization)
    if not authed:
        await ai_quota.check_and_bump_guest_chat(db, _client_ip(request))

    cfg = _load_knowledge()
    system_text = _build_system_text(cfg)

    contents: List[Dict[str, Any]] = []
    for m in payload.messages:
        contents.append(
            {
                "role": "user" if m.role == "user" else "model",
                "parts": [{"text": m.content}],
            }
        )

    body: Dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 220,
            "topP": 0.9,
        },
    }
    if system_text:
        body["systemInstruction"] = {"parts": [{"text": system_text}]}

    resp = await _call_gemini(settings.GEMINI_MODEL, body, timeout=30.0)
    if resp is None or resp.status_code >= 400:
        # N10 — never echo the raw upstream error to the client (it can leak
        # internal/config details). Log-friendly detail stays server-side.
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "medi AI এখন উত্তর দিতে পারছে না — একটু পরে আবার চেষ্টা করুন।",
        )

    data = resp.json()
    try:
        reply = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError):
        reply = "দুঃখিত, এখন উত্তর দিতে পারছি না।"

    # Persist the guest's consumed allowance only now that the call succeeded.
    if not authed:
        await db.commit()

    return ChatOut(reply=reply, model=settings.GEMINI_MODEL)


# ────────────────────────────────────────────────────────────────────────────
# Internal helpers used by the conversations router for in-chat moderation
# and `@mediai` mentions. These are best-effort — on failure they return
# safe defaults so message-sending never breaks because of an AI outage.
# ────────────────────────────────────────────────────────────────────────────

MENTION_TOKENS = ("@mediai", "@medi.ai", "@medi", "@ai")


def has_ai_mention(text: str) -> bool:
    if not text:
        return False
    low = text.lower()
    return any(tok in low for tok in MENTION_TOKENS)


async def _gemini_json(
    system_text: str,
    user_text: str,
    timeout: float = 30.0,
    *,
    temperature: float = 0.1,
) -> Dict[str, Any] | None:
    """Single-shot Gemini call that expects a JSON object back."""
    if not key_pool.has_keys():
        return None
    body = {
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": 250,
            "topP": 0.9,
            "responseMimeType": "application/json",
        },
        "systemInstruction": {"parts": [{"text": system_text}]},
    }
    resp = await _call_gemini(settings.GEMINI_MODEL, body, timeout=timeout)
    if resp is None:
        return None
    if resp.status_code >= 400:
        print(f"[gemini] {resp.status_code}: {resp.text[:200]}")
        return None
    try:
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)
    except Exception as exc:
        print(f"[gemini] parse error: {type(exc).__name__}: {exc}")
        return None


async def _gemini_text(system_text: str, user_text: str, max_tokens: int = 220) -> str | None:
    if not key_pool.has_keys():
        return None
    body = {
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": max_tokens,
            "topP": 0.9,
        },
        "systemInstruction": {"parts": [{"text": system_text}]},
    }
    resp = await _call_gemini(settings.GEMINI_MODEL, body, timeout=12.0)
    if resp is None or resp.status_code >= 400:
        return None
    try:
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception:
        return None


MODERATION_SYSTEM = (
    "You are MediDoor's safety classifier for a pharmacy delivery chat in "
    "Bangladesh. Customers, pharmacies, and riders write in Bengali, English, "
    "and Banglish (Bangla in Latin script). Read ONE message and decide if it "
    "tries to:\n"
    "(a) MOVE THE DEAL OFF-PLATFORM — sharing bKash / Nagad / Rocket account, "
    "posting a personal phone number, asking to call directly, meet in person, "
    "pay cash outside the app, or chat outside (WhatsApp/Messenger/IMO).\n"
    "(b) SELL CONTROLLED / PRESCRIPTION-ONLY medicine without a prescription "
    "— narcotics, opioids, benzodiazepines, sleeping pills, antibiotics, etc.\n"
    "(c) SELL FAKE / COUNTERFEIT medicine — ‘original noy’, ‘copy maal’, ‘India "
    "theke chora’, etc.\n"
    "(d) HARASS, threaten, abuse, or use slurs.\n"
    "\n"
    "Risk levels:\n"
    "  • high   — a clear, explicit attempt (phone numbers shared, payment app "
    "named with a number, ‘app er baire deal koro’, threats, slurs).\n"
    "  • medium — a strong hint or partial attempt (‘bahire payment koro’ "
    "without a number, asking for personal contact, suggesting to bypass the "
    "platform, repeated nudging).\n"
    "  • low    — mildly suspicious wording but ambiguous.\n"
    "  • none   — normal pharmacy/medicine/delivery conversation.\n"
    "\n"
    "EXAMPLES (every off-platform attempt must be flagged at least medium):\n"
    "  ‘amake direct call koro 01700000000’  → high / off_platform\n"
    "  ‘bKash koro amar nombore 01711...’      → high / off_platform\n"
    "  ‘app baad diye baire deal koren’         → medium / off_platform\n"
    "  ‘amar WhatsApp e message den’            → high / off_platform\n"
    "  ‘Napa 500 ache?’                          → none\n"
    "  ‘rider kobe ashbe?’                       → none\n"
    "  ‘Seclo lagbe 10ta’                        → none\n"
    "\n"
    "Respond ONLY in JSON: "
    '{"risk":"none|low|medium|high",'
    '"category":"off_platform|controlled|fake|harassment|none",'
    '"reason":"<one short Bengali sentence shown to the user>"}. '
    "Be decisive — do NOT default to ‘none’ when one of the patterns above "
    "matches."
)

# Regex pre-filter for off-platform attempts. If a message clearly contains a
# phone number, payment-app name with digits, or a phrase asking to bypass the
# platform, we mark it medium up-front so the user gets a warning even if
# Gemini momentarily mis-classifies it. Gemini can still upgrade it to high.
_OFF_PLATFORM_PHONE_RE = re.compile(r"(?:\+?880|0)?1[3-9]\d[\s\-]?\d{3}[\s\-]?\d{4}")
_OFF_PLATFORM_PAY_RE = re.compile(
    r"\b(bkash|b-?kash|বিকাশ|nagad|nogod|নগদ|rocket|রকেট|upay|উপে)\b",
    re.IGNORECASE,
)
_OFF_PLATFORM_PHRASE_RE = re.compile(
    r"(directly?\s*call|call\s*me\s*direct|app\s*er\s*baire|baire\s*deal|"
    r"app\s*chere|app\s*er\s*bairer|whats?app|ওয়াট্সঅ্যাপ|messenger|imo|telegram|"
    r"সরাসরি\s*কল|ফোন\s*(?:দিন|কর)|number\s*(?:de|den|dao|dao to|dio))",
    re.IGNORECASE,
)


def _regex_pre_check(text: str) -> Dict[str, Any] | None:
    """If the message obviously violates the off-platform policy, return a
    medium-risk verdict so the chat is at least warned even when Gemini is
    flaky. Returns None when nothing matches."""
    has_phone = bool(_OFF_PLATFORM_PHONE_RE.search(text))
    has_pay = bool(_OFF_PLATFORM_PAY_RE.search(text))
    has_phrase = bool(_OFF_PLATFORM_PHRASE_RE.search(text))
    if not (has_phone or has_pay or has_phrase):
        return None
    # Two or more signals = treat as high; one signal = medium.
    score = sum([has_phone, has_pay, has_phrase])
    risk = "high" if score >= 2 else "medium"
    return {
        "risk": risk,
        "category": "off_platform",
        "reason": "এই message app-এর বাইরে যোগাযোগের চেষ্টা বলে মনে হচ্ছে — "
                  "দয়া করে MediDoor-এই নিরাপদে কথা বলুন।",
    }


_RISK_ORDER = {"none": 0, "low": 1, "medium": 2, "high": 3}


async def moderate_message(text: str) -> Dict[str, Any]:
    """Returns {risk, category, reason}. Always safe.

    Strategy:
      1. Cheap regex pre-filter — instantly catches obvious off-platform
         attempts even if Gemini is slow/down. Verdict floor only.
      2. Gemini classification at temperature=0 (deterministic) with one
         retry if the first call returns null/none on a message that the
         regex flagged.
      3. Final risk = MAX(regex risk, Gemini risk).
    """
    safe = {"risk": "none", "category": "none", "reason": ""}
    if not text or len(text.strip()) < 2:
        return safe
    sample = text.strip()[:1500]

    pre = _regex_pre_check(sample)
    res = await _gemini_json(MODERATION_SYSTEM, sample, temperature=0.0)
    # If Gemini missed something the regex caught, retry once — sometimes a
    # single fresh attempt is enough to dislodge a stuck ‘none’ verdict.
    if pre and (not res or str(res.get("risk", "none")).lower() == "none"):
        res = await _gemini_json(MODERATION_SYSTEM, sample, temperature=0.0)

    ai_risk = "none"
    ai_cat = "none"
    ai_reason = ""
    if res:
        ai_risk = str(res.get("risk", "none")).lower()
        if ai_risk not in ("none", "low", "medium", "high"):
            ai_risk = "none"
        ai_cat = str(res.get("category", "none"))[:40]
        ai_reason = str(res.get("reason", ""))[:300]

    pre_risk = pre["risk"] if pre else "none"
    final_risk = ai_risk if _RISK_ORDER[ai_risk] >= _RISK_ORDER[pre_risk] else pre_risk
    if final_risk == "none":
        return safe
    if final_risk == ai_risk and ai_reason:
        return {"risk": final_risk, "category": ai_cat, "reason": ai_reason}
    # Fall back to the regex verdict (or override category if AI was 'none').
    return {
        "risk": final_risk,
        "category": ai_cat if ai_risk != "none" else (pre or {}).get("category", "off_platform"),
        "reason": ai_reason or (pre or {}).get("reason", ""),
    }


MENTION_SYSTEM = (
    "You are 'medi AI' — a helpful in-chat assistant inside a Bangladeshi "
    "pharmacy delivery app called MediDoor. The customer, pharmacy, or rider "
    "mentioned you with @mediai. Read the recent messages and answer the "
    "asker's question briefly (≤ 3 short sentences) in Bengali. "
    "Stay strictly within: medicine info (generic name, common use, basic "
    "dosing for adults), order/delivery clarifications, and MediDoor "
    "platform questions. NEVER prescribe, NEVER give doses for children/"
    "pregnant women, ALWAYS recommend consulting a registered pharmacist or "
    "doctor for medical advice. Do not output JSON — just plain text reply."
)


async def mediai_reply_for_chat(history: List[Dict[str, str]], question: str) -> str | None:
    """history = list of {role, body} for last few messages. question = the
    triggering message body. Returns plain-text reply or None."""
    convo_lines: List[str] = []
    for h in history[-8:]:
        role = h.get("role", "user")
        body = (h.get("body") or "").strip()
        if not body:
            continue
        convo_lines.append(f"{role}: {body[:300]}")
    convo_lines.append(f"asker: {question.strip()[:500]}")
    prompt = "Recent chat:\n" + "\n".join(convo_lines) + "\n\nReply:"
    return await _gemini_text(MENTION_SYSTEM, prompt, max_tokens=220)


# =====================================================================
# Product moderation — AI auto-approves new pharmacy listings.
# =====================================================================

PRODUCT_MODERATION_SYSTEM = (
    "You are MediDoor's product-listing classifier. MediDoor is a Bangladeshi "
    "pharmacy delivery platform that ONLY sells healthcare-related items. "
    "A pharmacy is trying to add a product to their store. Decide whether it "
    "should be APPROVED or REJECTED.\n"
    "\n"
    "APPROVE if the product clearly belongs to ANY of these healthcare buckets:\n"
    "  • prescription medicine (Rx drugs, antibiotics, insulin, etc.)\n"
    "  • OTC medicine (paracetamol, antacid, ORS, cough syrup, etc.)\n"
    "  • feminine hygiene (sanitary pad, tampon, menstrual cup)\n"
    "  • diabetes management (glucometer, test strips, insulin syringe)\n"
    "  • sexual & reproductive health (condom, contraceptive, pregnancy test)\n"
    "  • nutrition & supplements (vitamins, protein powder, oral rehydration)\n"
    "  • medical device (BP monitor, thermometer, nebulizer, oxygen)\n"
    "  • first aid (bandage, antiseptic, gauze, plaster)\n"
    "  • therapeutic skincare / dermatology (medicated cream, sunscreen SPF, "
    "anti-acne, eczema cream — NOT regular cosmetics/makeup)\n"
    "  • mental health / sleep aids (melatonin, calming supplements)\n"
    "  • baby care (formula milk, diaper, baby medicine)\n"
    "\n"
    "REJECT if it is clearly NON-healthcare:\n"
    "  • grocery / food (rice, oil, snacks, regular drinks)\n"
    "  • electronics (phone, charger, headphone)\n"
    "  • clothing / fashion / cosmetics (lipstick, perfume, jewellery)\n"
    "  • toys / stationery / household goods\n"
    "  • alcohol, cigarettes, recreational items\n"
    "\n"
    "BORDERLINE — make a careful judgement call:\n"
    "  • Energy drink (Red Bull, Sting) → REJECT (not therapeutic)\n"
    "  • Regular honey / glucose powder → REJECT (grocery)\n"
    "  • Manuka medical-grade honey → APPROVE (therapeutic claim)\n"
    "  • ORS / electrolyte sachet → APPROVE (rehydration therapy)\n"
    "  • Plain soap → REJECT; medicated antiseptic soap → APPROVE\n"
    "  • Plain shampoo → REJECT; anti-dandruff Ketoconazole shampoo → APPROVE\n"
    "If you cannot tell from the name + description, output \"pending\" and "
    "an admin will review.\n"
    "\n"
    "DO NOT decide whether a prescription is required — that is the "
    "pharmacy's manual choice. NEVER mention prescription requirements in "
    "your reason.\n"
    "\n"
    "Respond ONLY in JSON:\n"
    '{"verdict":"approved|rejected|pending",'
    '"category":"<one of: prescription_medicine|otc_medicine|feminine_hygiene|'
    "diabetes|sexual_health|nutrition|medical_device|first_aid|"
    "therapeutic_skincare|mental_health|baby_care|"
    'non_healthcare|borderline>",'
    '"reason":"<one short Bengali sentence — explain why approved or rejected, '
    'shown to the pharmacy>"}'
)


async def classify_product(
    name: str,
    short_description: str | None = None,
    description: str | None = None,
    category: str | None = None,
) -> Dict[str, Any]:
    """AI-classifies a product listing. Returns dict with keys:
    `verdict` ("approved"|"rejected"|"pending"), `category`, `reason`.
    Falls back to "pending" with reason "AI unavailable" if Gemini errors.
    """
    fallback = {
        "verdict": "pending",
        "category": "borderline",
        "reason": "AI পর্যালোচনা সম্পূর্ণ হয়নি — admin manually review করবে।",
    }
    name = (name or "").strip()
    if not name:
        return {**fallback, "reason": "Product নাম খালি।"}

    prompt_parts = [f"Product name: {name}"]
    if category:
        prompt_parts.append(f"Pharmacy-chosen category: {category.strip()[:80]}")
    if short_description:
        prompt_parts.append(f"Short description: {short_description.strip()[:280]}")
    if description:
        prompt_parts.append(f"Full description: {description.strip()[:600]}")
    user_text = "\n".join(prompt_parts)

    res = await _gemini_json(PRODUCT_MODERATION_SYSTEM, user_text)
    if not res:
        return fallback

    verdict = str(res.get("verdict", "")).lower().strip()
    if verdict not in ("approved", "rejected", "pending"):
        verdict = "pending"
    cat = str(res.get("category", "borderline"))[:40] or "borderline"
    reason = str(res.get("reason", ""))[:400].strip()
    if not reason:
        reason = (
            "AI আপনার product approve করেছে।"
            if verdict == "approved"
            else "AI পর্যালোচনা — admin দেখবে।"
        )
    return {"verdict": verdict, "category": cat, "reason": reason}


# ----------------------------------------------------------------------
# Vision-based product moderation — used by the pharmacy publish flow.
# The pharmacy uploads a product photo (mandatory). Gemini Vision:
#   1. Confirms the image really is a healthcare product.
#   2. Confirms the image visually matches the product name.
#   3. Generates a Bengali short-description if the pharmacy didn't.
#   4. Suggests 1-3 categories from the global catalogue.
#   5. If the pharmacy's chosen category / short_description disagrees
#      with what the AI sees, returns Bengali advice for the inbox.
# ----------------------------------------------------------------------

PRODUCT_VISION_SYSTEM_TMPL = (
    "You are MediDoor's product moderator for a Bangladeshi pharmacy "
    "delivery app. You receive a photo of a product the pharmacy wants to "
    "list. Decide if it belongs on a healthcare/medicine marketplace and "
    "describe it for Bangla-speaking customers.\n"
    "\n"
    "Allowed: prescription & OTC medicines, vitamins/supplements, medical "
    "devices (BP monitor, glucometer, thermometer, nebuliser, oximeter), "
    "first-aid (bandage, antiseptic), dermatology / skincare with a "
    "therapeutic purpose (sunscreen, anti-acne, eczema), feminine & "
    "sexual wellness, baby care (diapers/formula/baby medicine), elder "
    "care, ORS, masks/sanitiser, herbal/ayurvedic remedies.\n"
    "\n"
    "Rejected: groceries, snacks, electronics unrelated to health, "
    "cosmetics with no therapeutic claim (lipstick, perfume), tobacco, "
    "alcohol, weapons, anything obviously not a healthcare product, "
    "blank/unreadable images, screenshots of websites/apps.\n"
    "\n"
    "Pharmacy-supplied metadata (any field may be empty):\n"
    "  • name (always present)\n"
    "  • short_description (may be empty — AI must generate one if so)\n"
    "  • category (may be empty — AI must suggest if so)\n"
    "\n"
    "Available categories (the LIVE customer-facing taxonomy on this "
    "platform). **You MUST strongly prefer reusing one of these names** "
    "instead of inventing a new one \u2014 even if the wording is slightly "
    "different from how a doctor would say it (e.g. for a paracetamol "
    "tablet, reuse the existing 'Pain & Fever' bucket rather than coining "
    "'Fever Relief'). Only invent a brand-new category when NONE of the "
    "existing names is a reasonable fit. When inventing, use a short, "
    "professional, English-first name (\u22643 words, Title Case) that another "
    "pharmacist would also pick.\n"
    "{CATEGORY_LIST}\n"
    "\n"
    "Return 1\u20133 categories in `suggested_categories`. Order them best-fit "
    "first. A medicine with multiple legitimate uses (e.g. ibuprofen for "
    "fever AND for body pain) MAY appear in multiple categories \u2014 only "
    "do this when both buckets clearly apply to the same product, and "
    "still prefer existing names for each.\n"
    "\n"
    "Output ONLY this JSON:\n"
    '{"is_healthcare": true|false,'
    ' "image_matches_name": true|false,'
    ' "verdict": "approved"|"rejected"|"pending",'
    ' "generated_short_description": "<VERY SHORT Bengali micro-copy, '
    '18-45 characters, generated FRESH from the image — even if the pharmacy '
    'supplied one, give your own version here>",'
    ' "suggested_categories": ["Cat A", "Cat B", ...],'
    ' "user_metadata_matches": true|false,'
    ' "advice_bn": "<if user_metadata_matches=false, a polite Bengali '
    'advice message ≤220 chars suggesting better category and/or '
    'short-description; otherwise empty string>",'
    ' "reason": "<one short Bengali sentence — why approved or rejected>"}\n'
    "\n"
    "Rules:\n"
    "- If is_healthcare=false → verdict=\"rejected\".\n"
    "- If is_healthcare=true but image_matches_name=false → "
    "verdict=\"pending\" and explain in `reason`.\n"
    "- Otherwise verdict=\"approved\".\n"
    "- `user_metadata_matches`=true ONLY when the pharmacy's category "
    "(if any) is in your suggested_categories AND the pharmacy's "
    "short_description (if any) is consistent with the product. If "
    "either field is empty on the pharmacy side, treat that field as "
    "matching.\n"
    "- All Bengali text must be natural Bangla written for Bangladeshi "
    "customers. Avoid English words except brand names / dose units.\n"
    "- `generated_short_description` MUST fit a medicine card: one compact "
    "benefit/use phrase, not a sentence or paragraph. No dosage schedule, "
    "no ingredient explanation, no brand repetition. Good examples: "
    "'জ্বর ও ব্যথা কমাতে', 'চোখের অ্যালার্জিতে', 'হাড়ের যত্নে', "
    "'অ্যালার্জি উপশমে'.\n"
)

AI_SHORT_DESCRIPTION_MAX_CHARS = 56


def compact_generated_short_description(text: str | None) -> str:
    value = " ".join(str(text or "").replace("\n", " ").split()).strip()
    if not value:
        return ""

    for sentence_end in ("।", ".", "!", "?"):
        if sentence_end in value:
            first_sentence = value.split(sentence_end, 1)[0].strip()
            if first_sentence:
                value = first_sentence
            break

    if len(value) <= AI_SHORT_DESCRIPTION_MAX_CHARS:
        return value

    cut = value[:AI_SHORT_DESCRIPTION_MAX_CHARS].rstrip()
    for separator in (" ", ",", "、", "-"):
        position = cut.rfind(separator)
        if position >= 18:
            cut = cut[:position].rstrip(" ,-、")
            break
    return cut or value[:AI_SHORT_DESCRIPTION_MAX_CHARS].rstrip()


async def vision_classify_product(
    image_url: str,
    name: str,
    short_description: str | None,
    category: str | None,
    catalog_names: List[str] | None = None,
) -> Dict[str, Any]:
    """Vision-classify a product the pharmacy wants to publish.

    Returns:
      {
        verdict: "approved"|"rejected"|"pending",
        category: <legacy bucket label, kept for back-compat with the
                   admin moderation table>,
        reason: <Bengali sentence>,
        is_healthcare: bool,
        image_matches_name: bool,
        generated_short_description: <short Bengali card micro-copy>,
        suggested_categories: [str, …],   # 0-3 names
        user_metadata_matches: bool,
        advice_bn: str,                    # empty when nothing to advise
      }

    Falls back to verdict=\"pending\" with a sensible message when the
    image can't be loaded or Gemini is unavailable.
    """
    fallback = {
        "verdict": "pending",
        "category": "borderline",
        "reason": "AI পর্যালোচনা সম্পূর্ণ হয়নি — admin manually review করবে।",
        "is_healthcare": False,
        "image_matches_name": False,
        "generated_short_description": "",
        "suggested_categories": [],
        "user_metadata_matches": True,
        "advice_bn": "",
    }
    if not image_url:
        return {**fallback, "reason": "Product image নেই — image upload করে publish করুন।"}

    local_path = _resolve_upload_path(image_url)
    if not local_path:
        return {**fallback, "reason": "Product image খুঁজে পাওয়া যায়নি।"}

    suffix = local_path.suffix.lower()
    mime = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
    }.get(suffix, "image/jpeg")
    try:
        image_bytes = local_path.read_bytes()
    except OSError:
        return {**fallback, "reason": "Image পড়া যাচ্ছে না।"}

    catalog_text = ", ".join(catalog_names or []) or "(no preset list)"
    system_prompt = PRODUCT_VISION_SYSTEM_TMPL.replace("{CATEGORY_LIST}", catalog_text)

    user_text = (
        f"Pharmacy-supplied metadata:\n"
        f"  name: {name.strip()[:160]}\n"
        f"  short_description: {(short_description or '').strip()[:280] or '(empty)'}\n"
        f"  category: {(category or '').strip()[:80] or '(empty)'}\n"
        f"Now analyse the attached product image and respond as specified."
    )

    res = await _gemini_vision_json(
        image_bytes,
        mime,
        system_prompt=system_prompt,
        user_prompt=user_text,
        max_output_tokens=1500,
    )
    if not res:
        return fallback

    verdict = str(res.get("verdict", "")).lower().strip()
    if verdict not in ("approved", "rejected", "pending"):
        verdict = "pending"
    is_health = bool(res.get("is_healthcare"))
    matches_name = bool(res.get("image_matches_name"))
    # Hard safety guard: ignore the AI's verdict when it contradicts the
    # boolean signals (defence-in-depth against hallucinated approvals).
    if not is_health:
        verdict = "rejected"
    elif not matches_name and verdict == "approved":
        verdict = "pending"

    gen_short = compact_generated_short_description(
        str(res.get("generated_short_description", ""))[:200]
    )

    raw_cats = res.get("suggested_categories") or []
    suggested: List[str] = []
    seen_low: set[str] = set()
    for c in raw_cats:
        if not isinstance(c, str):
            continue
        c2 = c.strip()[:80]
        if not c2 or c2.lower() in seen_low:
            continue
        seen_low.add(c2.lower())
        suggested.append(c2)
        if len(suggested) >= 3:
            break

    user_ok = bool(res.get("user_metadata_matches", True))
    advice = str(res.get("advice_bn", ""))[:300].strip()
    if user_ok:
        advice = ""

    reason = str(res.get("reason", ""))[:400].strip()
    if not reason:
        reason = (
            "AI আপনার product approve করেছে।"
            if verdict == "approved"
            else ("AI image ও নামের মিল নিশ্চিত করতে পারেনি।"
                  if verdict == "pending"
                  else "AI বলছে এটি healthcare product নয়।")
        )

    # Map to the legacy bucket label kept on the Medicine row for the
    # admin moderation page. Best-effort.
    bucket = "borderline"
    if verdict == "approved":
        bucket = "medicine" if matches_name else "borderline"
    elif verdict == "rejected":
        bucket = "non_healthcare"

    return {
        "verdict": verdict,
        "category": bucket,
        "reason": reason,
        "is_healthcare": is_health,
        "image_matches_name": matches_name,
        "generated_short_description": gen_short,
        "suggested_categories": suggested,
        "user_metadata_matches": user_ok,
        "advice_bn": advice,
    }


# =====================================================================
# Smart prescription flow — customer uploads Rx → AI extracts medicines
# → finds nearby pharmacies that stock them → returns 3 ranked proposals
# → customer picks one → dispatch opens chat + auto-posts order_request.
# =====================================================================

# Vision-capable model. We try the user's preferred model first, then fall
# back to a known multimodal one if the first refuses (e.g. flash-lite is
# text-only). The same GEMINI_API_KEY handles both.
_VISION_MODELS = (
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
)

PRESCRIPTION_VISION_SYSTEM = (
    "You are MediDoor's prescription reader for a Bangladeshi pharmacy "
    "delivery app. The image is a photo or scan of a doctor's prescription "
    "(Bangla / English mixed handwriting is common, often hard to read). "
    "Read VERY CAREFULLY. Bangladeshi doctors usually prescribe well-known "
    "local brand names — NEVER invent a name you have never seen on the "
    "Bangladesh market. If a word is unreadable, output your best guesses "
    "in `alt_names` instead of fabricating one confident name.\n"
    "The user prompt may include NEARBY_INVENTORY_NAMES. Use those names "
    "ONLY as spelling hints for ambiguous handwriting. Do NOT add an "
    "inventory item unless a matching medicine line is visible on the "
    "prescription. If a written medicine is not in inventory, still extract "
    "it exactly with plausible `alt_names`.\n"
    "\n"
    "═══ STEP 1 — read the doctor heading carefully ═══\n"
    "Identify the doctor's specialty from the heading / degrees / chamber "
    "name (e.g. 'Eye Specialist', 'চক্ষু বিশেষজ্ঞ', 'M.B.B.S, D.O', "
    "'Ophthalmologist', 'ENT', 'Skin & VD', 'Cardiologist', 'Gynae', "
    "'Pediatric'). Put it in `doctor_specialty` (Bangla or English, ≤40 "
    "chars). The specialty STRONGLY constrains what forms / brands are "
    "likely:\n"
    "  • Eye / Ophthalmology → mostly EYE DROPS and ointments. Common BD "
    "    eye-drop brands: Refresh / Refresh Tears / Refresh Liquigel, "
    "    Aladay DS, AFM-T, Optifit, Optimox, Tobrex, Maxitrol, Ciprocin "
    "    eye drop, Bromogen, Nepafen, Lotemax, Pataday, Olopat, Predfort, "
    "    Genoptic, Moxifin, Carboxin. Default `form=drop` when unsure.\n"
    "    Exception: Fixal / Fexo / fexofenadine is an ORAL antihistamine "
    "    tablet/capsule/syrup, not an eye drop; compute tablet quantity "
    "    from days/dose if written.\n"
    "  • ENT → drops / sprays / tablets (e.g. Otex, Otrivin, Nasivion, "
    "    Fexofast, Histacin, Fixal).\n"
    "  • Derma / Skin → cream / ointment / lotion (e.g. Fungin, Pevisone, "
    "    Tecasone, Locoid, Dermovate). Default `form=cream`.\n"
    "  • General / Medicine → tablet / capsule / syrup. Common BD brands: "
    "    Napa / Napa Extra / Napa Extend, Ace, Paracetamol, Seclo, Losectil, "
    "    Maxpro, Pantonix, Histacin, Fexo / Fixal, Monas, Doxicap, Ciproxin, "
    "    Flagyl, Amodis, Sergel, Esonix, Rolac, Tufnil, Arotril, Disopan.\n"
    "  • Pediatric / Child → syrup, drops, sachet, paediatric strength. "
    "    Common hints: Napa Paediatric Drops, Ace Plus, DP, Ambrox, Tusca, "
    "    Zinc, ORS, Cef-3, Cefotil, Azithro, probiotics. Quantity is usually "
    "    1 bottle/strip unless written otherwise.\n"
    "  • Gynae / Obstetric → tablets/capsules/supplements/injections. Common "
    "    hints: Folic acid, Folison, Femicon, Normens, Duphaston, Progest, "
    "    Iron, Calcium, Cefixime, Metronidazole, Clotrimazole pessary.\n"
    "  • Cardiology / Hypertension → tablets. Common hints: Amlodipine, "
    "    Amdocal, Losartan, Losucon, Bisoprolol, Concor, Rosuva, Atorvastatin, "
    "    Ecosprin, Clopidogrel, Frusemide, Spironolactone.\n"
    "  • Diabetes / Endocrine → tablets/insulin. Common hints: Metformin, "
    "    Comet, Glucophage, Gliclazide, Sitagliptin, Dapagliflozin, insulin "
    "    pen/vial names. Preserve insulin units exactly if written.\n"
    "  • Gastro / Liver → tablets/capsules/sachets/syrup. Common hints: "
    "    Seclo, Sergel, Maxpro, Pantonix, DP, Motigut, Domperidone, Antacid, "
    "    Lactulose, ORS, probiotics.\n"
    "  • Neuro / Psychiatry → tablets/capsules. Common hints: Pregabalin, "
    "    Gabapentin, Amitriptyline, Clonazepam, Escitalopram, Sertraline, "
    "    Levetiracetam. Preserve controlled-drug names and strengths exactly.\n"
    "  • Orthopedic / Pain → tablets/capsules/gels. Common hints: Etoricoxib, "
    "    Naproxen, Diclofenac, Aceclofenac, Calcium, Vitamin D, DP, PPI.\n"
    "  • Dental → antibiotics, painkillers, mouthwash/gel. Common hints: "
    "    Amoxiclav, Metronidazole, Ibuprofen, Paracetamol, Chlorhexidine.\n"
    "  • Urology / Kidney → tablets/sachets. Common hints: Tamsulosin, "
    "    Alfuzosin, Potassium citrate, antibiotics, urinary alkaliser.\n"
    "\n"
    "═══ STEP 2 — extract every medicine line item ═══\n"
    "For each medicine output an object with these fields:\n"
    "  • generic_or_brand_name — best single guess. Drop dosing prefixes "
    "    like 'Tab.', 'Cap.', 'Syp.', 'Inj.', 'E/D' (eye drop), 'Oint.'.\n"
    "  • alt_names — ARRAY of 1–4 OTHER plausible readings of the same "
    "    handwritten word (BD brand names only, never invented). Examples: "
    "    if you read 'Refresb', alt_names should include 'Refresh'. "
    "    If you read 'Aladay SSN' or 'Aladay DSN', alt_names should "
    "    include 'Aladay DS' (that letter pair is almost always 'DS' on "
    "    BD eye drops). If you read 'AFM', alt_names should include "
    "    'AFM-T'. Always include the full brand form (e.g. 'Refresh "
    "    Liquigel', 'Refresh Tears'). LEAVE EMPTY only if the primary name "
    "    is fully obvious printed text.\n"
    "  • strength — e.g. '500 mg', '20 mg/ml', '0.5%' for drops. Empty if "
    "    unclear. Eye drops are usually % concentration, NOT mg/ml — "
    "    don't guess mg for an eye drop.\n"
    "  • form — drop | ointment | tablet | capsule | syrup | injection | "
    "    cream | spray | gel | other. PICK BASED ON SPECIALTY when "
    "    handwriting is unclear (eye doctor → drop; derma → cream).\n"
    "  • quantity — total units to buy. For drops/syrups/creams default 1; "
    "    for tablets/capsules default 10 if unclear (or compute from "
    "    'X+X+X × N days' dosing).\n"
    "  • instructions — short Bengali line ('1+0+1, খাবার পরে', "
    "    '১ ফোঁটা ৩ বার, ৭ দিন', '১৫ দিন') — never put a stray number alone.\n"
    "\n"
    "═══ STEP 3 — top-level fields ═══\n"
    "  • doctor_name (string, may be empty)\n"
    "  • doctor_specialty (string, may be empty — see Step 1)\n"
    "  • patient_name (string, may be empty)\n"
    "  • notes — one short Bengali sentence summarising why the doctor "
    "    likely prescribed these (≤ 140 chars).\n"
    "\n"
    "If the image is NOT a prescription (random photo, blank page, "
    "advertisement, ID card, etc.), respond with: "
    '{"is_prescription": false, "reason": "<short Bengali reason>"}.\n'
    "\n"
    "Otherwise respond ONLY in JSON:\n"
    '{"is_prescription": true,'
    ' "doctor_name": "...", "doctor_specialty": "...",'
    ' "patient_name": "...", "notes": "...",'
    ' "medicines": [{"generic_or_brand_name":"...","alt_names":["..."],'
    '"strength":"...","form":"...","quantity": 10,"instructions":"..."}, ...]}'
)


async def _gemini_vision_json(
    image_bytes: bytes,
    mime_type: str,
    *,
    system_prompt: str | None = None,
    user_prompt: str = "Extract the prescription as specified.",
    max_output_tokens: int = 4000,
) -> Dict[str, Any] | None:
    """Send an image + a system prompt to Gemini Vision and parse the JSON
    response. Tries multiple vision models until one accepts the request.
    Each model attempt itself rotates through the key pool on quota / 5xx
    / transport errors. Returns a parsed JSON dict or None on hard failure.

    `system_prompt` defaults to the prescription extractor — pass a custom
    one (e.g. the product moderator) for other vision tasks.
    """
    if not key_pool.has_keys():
        return None
    b64 = base64.b64encode(image_bytes).decode("ascii")
    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {"inlineData": {"mimeType": mime_type, "data": b64}},
                {"text": user_prompt},
            ],
        }],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": max_output_tokens,
            "topP": 0.9,
            "responseMimeType": "application/json",
        },
        "systemInstruction": {
            "parts": [{"text": system_prompt or PRESCRIPTION_VISION_SYSTEM}]
        },
    }
    last_err = ""
    for model in _VISION_MODELS:
        resp = await _call_gemini(model, body, timeout=45.0)
        if resp is None:
            last_err = "all_keys_failed"
            print(f"[gemini-vision/{model}] all keys failed")
            continue
        if resp.status_code >= 400:
            last_err = f"{resp.status_code}: {resp.text[:120]}"
            print(f"[gemini-vision/{model}] {last_err}")
            continue
        try:
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            cleaned = text.strip()
            if cleaned.startswith("```"):
                cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
                cleaned = re.sub(r"\s*```\s*$", "", cleaned)
            try:
                return json.loads(cleaned)
            except json.JSONDecodeError:
                m = re.search(r"\{.*\}", cleaned, re.DOTALL)
                if m:
                    try:
                        return json.loads(m.group(0))
                    except json.JSONDecodeError:
                        pass
                # Show the actual snippet so we can see what the model emitted
                # (truncated JSON is by far the most common cause).
                snippet = cleaned[:300].replace("\n", " \\n ")
                last_err = f"JSONDecodeError; raw[:300]={snippet!r}"
                print(f"[gemini-vision/{model}] parse error: {last_err}")
                continue
        except Exception as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            print(f"[gemini-vision/{model}] parse error: {last_err}")
            continue
    print(f"[gemini-vision] all models failed; last_err={last_err}")
    return None


def _resolve_upload_path(image_url: str) -> Path | None:
    """Map a /uploads/<file> URL (full or relative) to a local file path."""
    parsed = urlparse(image_url)
    path = parsed.path or image_url
    if not path.startswith("/uploads/"):
        return None
    fname = path[len("/uploads/"):]
    # prevent traversal
    if "/" in fname or "\\" in fname or fname.startswith(".."):
        return None
    upload_dir = Path(__file__).resolve().parents[3] / "uploads"
    candidate = upload_dir / fname
    if not candidate.exists() or not candidate.is_file():
        return None
    return candidate


def _norm(s: str | None) -> str:
    """Normalise medicine names for fuzzy matching: lowercase, strip
    punctuation/dosing units, collapse whitespace."""
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"\b(tab|tabs|cap|caps|syp|syrup|inj|injection|cream|drop|drops|liquigel|gel|ointment|oint|e\s*/?\s*d|eye|ear|nasal|spray)\b\.?", " ", s)
    s = re.sub(r"[^a-z0-9\u0980-\u09ff\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _strength_tokens(s: str | None) -> List[str]:
    """Extract dose tokens like '500mg', '20mg', '10ml' for a tighter match."""
    if not s:
        return []
    return re.findall(r"\d+\s*(?:mg|mcg|ml|g|iu|%)", s.lower().replace(" ", ""))


def _ratio(a: str, b: str) -> float:
    """Forgiving similarity: longest-common subsequence-ish ratio via
    difflib. 1.0 = identical, ~0.7 = clear typo, <0.5 = different word."""
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _name_match_score(rx_name: str, rx_strength: str, med_name: str) -> float:
    """Score 0..1 for how well a pharmacy `med_name` matches the
    prescription medicine `rx_name + rx_strength`. >=0.55 considered a hit.

    Uses three signals:
      1. token overlap (good for multi-word brand names)
      2. difflib fuzzy similarity on the FIRST significant token + on the
         full normalised string (catches OCR errors like 'Aladay SSN' vs
         'Aladay DS', 'Refresb' vs 'Refresh')
      3. substring containment (rx_name appears inside med_name or vice
         versa — very common: rx 'Refresh' vs stock 'Refresh Liquigel')
    The best of the three wins, with a +0.2 bonus when strengths match.
    """
    n_rx = _norm(rx_name)
    n_med = _norm(med_name)
    if not n_rx or not n_med:
        return 0.0

    rx_tokens = [t for t in n_rx.split() if t]
    med_tokens = [t for t in n_med.split() if t]
    if not rx_tokens or not med_tokens:
        return 0.0

    # 1. token overlap (keep tokens >=2 chars so short brands like "DS"
    #    still count, but ignore single letters)
    rx_set = {t for t in rx_tokens if len(t) >= 2}
    med_set = {t for t in med_tokens if len(t) >= 2}
    overlap_score = (len(rx_set & med_set) / len(rx_set)) if rx_set else 0.0

    # 2. fuzzy similarity — pick the BEST pairwise ratio between any rx
    #    token and any med token (catches one-letter OCR slips), and also
    #    the ratio of the full normalised strings.
    best_token = 0.0
    for rt in rx_tokens:
        if len(rt) < 3:
            continue
        for mt in med_tokens:
            if len(mt) < 3:
                continue
            r = _ratio(rt, mt)
            if r > best_token:
                best_token = r
    full_ratio = _ratio(n_rx, n_med)

    # 3. substring containment (Refresh ⊂ Refresh Liquigel)
    contain_score = 0.0
    if n_rx in n_med or n_med in n_rx:
        # Weight by how much of the rx name is covered
        contain_score = min(1.0, max(len(n_rx), 4) / max(len(n_med), len(n_rx)))
        contain_score = max(contain_score, 0.85)  # near-certain hit

    base = max(overlap_score, best_token, full_ratio, contain_score)

    # Strength bonus
    if rx_strength:
        rx_doses = _strength_tokens(rx_strength)
        med_doses = _strength_tokens(med_name)
        if rx_doses and any(d in med_doses for d in rx_doses):
            base = min(1.0, base + 0.2)

    return round(base, 3)


def _best_match(rx: Dict[str, Any], meds: List["Medicine"]) -> tuple[float, "Medicine | None"]:
    """Try the primary rx name AND every alt_name; return the best
    (score, medicine) across all candidates."""
    candidates: List[str] = []
    primary = (rx.get("name") or "").strip()
    if primary:
        candidates.append(primary)
    for alt in (rx.get("alt_names") or [])[:6]:
        alt = (alt or "").strip()
        if alt and alt.lower() != primary.lower():
            candidates.append(alt)
    rx_strength = rx.get("strength") or ""
    best_score = 0.0
    best_med: "Medicine | None" = None
    for cand in candidates:
        for m in meds:
            score = _name_match_score(cand, rx_strength, m.name)
            if score > best_score:
                best_score, best_med = score, m
    return best_score, best_med


EARTH_KM = 6371.0


def _km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(a))


async def _nearby_inventory_names(
    db: AsyncSession,
    lat: float | None,
    lng: float | None,
    radius_km: float,
    *,
    limit: int = 90,
) -> List[str]:
    """Return nearby active stock names as OCR/spelling hints for the
    prescription reader. The prompt treats these as hints only, not as a
    shopping list to hallucinate from."""
    rows = (await db.execute(
        select(Medicine)
        .options(selectinload(Medicine.pharmacy))
        .where(
            Medicine.is_active.is_(True),
            Medicine.stock > 0,
            Medicine.approval_status == "approved",
        )
    )).scalars().all()
    seen: set[str] = set()
    names: List[str] = []
    for med in rows:
        pharmacy = med.pharmacy
        if not pharmacy or not pharmacy.is_published or pharmacy.is_blocked or not is_open_now(pharmacy):
            continue
        if lat is not None and lng is not None and pharmacy.lat is not None and pharmacy.lng is not None:
            if _km(lat, lng, pharmacy.lat, pharmacy.lng) > radius_km:
                continue
        name = (med.name or "").strip()
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            names.append(name[:120])
        if len(names) >= limit:
            break
    return names


# ---------- Pydantic schemas ----------

class PrescriptionScanIn(BaseModel):
    image_url: str = Field(min_length=4, max_length=600)
    # Customer location is mandatory (platform 5 km connect rule) — without
    # it proposals could come from any distance. Radius is capped at the
    # connect radius; clients may only shrink it.
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    radius_km: float = Field(default=GEO_CONNECT_RADIUS_KM, ge=0.5, le=GEO_CONNECT_RADIUS_KM)


class PrescriptionDispatchPlan(BaseModel):
    """One pharmacy slice of a (potentially multi-pharmacy) prescription
    dispatch plan."""
    pharmacy_id: UUID
    items: List[Dict[str, Any]] = Field(min_length=1, max_length=30)
    subtotal: float = Field(ge=0)
    delivery_fee: float = Field(ge=0)
    total: float = Field(ge=0)


class PrescriptionDispatchIn(BaseModel):
    prescription_url: str = Field(min_length=4, max_length=600)
    # Single-pharmacy fields are accepted for older clients, but dispatch still
    # requires `handshake_ids` from a confirmed pharmacy stock check.
    pharmacy_id: UUID | None = None
    items: List[Dict[str, Any]] | None = Field(default=None, max_length=30)
    subtotal: float | None = Field(default=None, ge=0)
    delivery_fee: float | None = Field(default=None, ge=0)
    total: float | None = Field(default=None, ge=0)
    # New multi-pharmacy plan list (1 or 2 entries). Preferred.
    plans: List[PrescriptionDispatchPlan] | None = Field(default=None, max_length=3)
    note: str | None = Field(default=None, max_length=500)
    delivery_address: str | None = Field(default=None, max_length=500)
    delivery_lat: float | None = Field(default=None, ge=-90, le=90)
    delivery_lng: float | None = Field(default=None, ge=-180, le=180)
    # AI handshake mode (Phase C). When set, this dispatch is the FINAL
    # confirmation step that follows an earlier `/prescription-handshake`
    # call. The server uses these IDs to close out the `ai_handshake`
    # message(s) in each conversation so the chat UI can hide the pending
    # state and confirm to all parties that the order is now live.
    handshake_ids: List[str] | None = Field(default=None, max_length=3)


async def _canonical_prescription_plan(
    db: AsyncSession,
    pharmacy: PharmacyProfile,
    raw_items: List[Dict[str, Any]],
    *,
    delivery_lat: float | None,
    delivery_lng: float | None,
    fallback_delivery_fee: float | None = None,
    reserve_stock: bool = False,
) -> Dict[str, Any]:
    # 5 km connect gate — every Smart-Prescription handshake/dispatch must
    # carry the customer's delivery point (400 location_required) and the
    # chosen pharmacy must sit inside the connect radius (403 out_of_range).
    # Closes the loophole where a crafted dispatch named a far-away
    # pharmacy_id that scan proposals would never have offered. Runs BEFORE
    # any stock work so nothing is reserved for an invalid plan.
    ensure_within_connect_radius(delivery_lat, delivery_lng, pharmacy)

    requested: List[tuple[UUID, int, Dict[str, Any]]] = []
    qty_by_id: Dict[UUID, int] = {}
    for raw in raw_items[:30]:
        try:
            medicine_id = UUID(str((raw or {}).get("medicine_id") or ""))
        except Exception:
            raise HTTPException(400, "Invalid Smart Prescription item: medicine_id required")
        try:
            qty = max(1, min(200, int((raw or {}).get("qty") or 1)))
        except Exception:
            qty = 1
        requested.append((medicine_id, qty, raw or {}))
        qty_by_id[medicine_id] = qty_by_id.get(medicine_id, 0) + qty

    if not requested:
        raise HTTPException(400, f"No valid items for pharmacy {pharmacy.pharmacy_name}")

    rows = (await db.execute(
        select(Medicine).where(
            Medicine.id.in_(list(qty_by_id.keys())),
            Medicine.pharmacy_id == pharmacy.id,
        )
    )).scalars().all()
    medicines = {m.id: m for m in rows}
    for medicine_id, total_qty in qty_by_id.items():
        medicine = medicines.get(medicine_id)
        if not medicine or not medicine.is_active:
            raise HTTPException(400, f"Item {medicine_id} unavailable")
        if (getattr(medicine, "approval_status", "approved") or "approved") != "approved":
            raise HTTPException(409, f"{medicine.name}: product currently unavailable")
        if int(medicine.stock or 0) < total_qty:
            raise HTTPException(409, f"{medicine.name}: only {medicine.stock} in stock")

    items_clean: List[Dict[str, Any]] = []
    order_items: List[Dict[str, Any]] = []
    subtotal = 0.0
    for medicine_id, qty, raw in requested:
        medicine = medicines[medicine_id]
        unit_price = float(medicine.price or 0)
        rx_strength = str(raw.get("rx_strength") or "")[:60]
        rx_instructions = str(raw.get("rx_instructions") or "")[:200]
        item = {
            "medicine_id": str(medicine.id),
            "name": medicine.name,
            "qty": qty,
            "unit_price": unit_price,
            "image_url": medicine.image_url,
            "prescription_required": bool(getattr(medicine, "prescription_required", False)),
            "rx_strength": rx_strength,
            "rx_instructions": rx_instructions,
        }
        items_clean.append(item)
        order_items.append({
            "medicine_id": str(medicine.id),
            "name": medicine.name,
            "qty": qty,
            "price": unit_price,
            "unit_price": unit_price,
            "image_url": medicine.image_url,
            "prescription_required": bool(getattr(medicine, "prescription_required", False)),
        })
        subtotal += unit_price * qty

    if reserve_stock:
        # Centralized decrement (app/services/stock.py) — same path as manual
        # and chat orders, so stock math lives in exactly one place.
        await reserve_items_stock(db, order_items)

    # Flat 10 BDT/km from pharmacy to customer — same rule as the storefront.
    delivery_fee = 0.0
    if (
        delivery_lat is not None
        and delivery_lng is not None
        and pharmacy.lat is not None
        and pharmacy.lng is not None
    ):
        distance_km = _km(delivery_lat, delivery_lng, pharmacy.lat, pharmacy.lng)
        delivery_fee = delivery_fee_for_distance(distance_km)
    elif fallback_delivery_fee is not None:
        delivery_fee = float(fallback_delivery_fee or 0)

    subtotal = round(subtotal, 2)
    delivery_fee = round(float(delivery_fee or 0), 2)
    return {
        "items": items_clean,
        "order_items": order_items,
        "subtotal": subtotal,
        "delivery_fee": delivery_fee,
        "total": round(subtotal + delivery_fee, 2),
    }


# ---------- /prescription-scan ----------

@router.post("/prescription-scan")
async def prescription_scan(
    payload: PrescriptionScanIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Read a prescription image, extract medicines, find up to 3 nearby
    pharmacies that stock the most of them. Customer just picks one and the
    next call (`/prescription-dispatch`) opens the chat with a ready-made
    order_request — they only have to press Send.

    Returns one of:
      { ok: true, ai: {medicines, doctor_name, patient_name, notes},
        proposals: [ {pharmacy, items, missing, subtotal, delivery_fee,
                      total, distance_km, eta_min, coverage_pct} ... ] }
      { ok: false, code: "ai_busy" | "not_prescription" | "no_image" |
                          "no_pharmacies", message, manual_options?: [...] }
    """
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers can scan a prescription")
    ensure_customer_not_banned(account)

    # Location mandatory — proposals are only valid inside the customer's
    # 5 km connect radius (see app/services/geo_policy.py).
    if payload.lat is None or payload.lng is None:
        raise location_required_error()

    # Quota gate — credit is now consumed ONLY when the customer actually
    # dispatches an order (see /prescription-dispatch). Scanning / previewing
    # is free so customers can explore the feature without burning credits.
    # We still HARD-BLOCK scanning when the customer is already out of quota
    # so they cannot scan further once exhausted.
    await ai_quota.check_quota(db, account.id, "smart_prescription")

    local_path = _resolve_upload_path(payload.image_url)
    if not local_path:
        return {
            "ok": False,
            "code": "no_image",
            "message": "Prescription image খুঁজে পাওয়া যায়নি — আবার upload করুন।",
        }

    suffix = local_path.suffix.lower()
    mime = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
    }.get(suffix, "image/jpeg")
    image_bytes = local_path.read_bytes()

    inventory_names = await _nearby_inventory_names(
        db, payload.lat, payload.lng, payload.radius_km
    )
    hint_block = ""
    if inventory_names:
        hint_block = (
            "\n\nNEARBY_INVENTORY_NAMES (spelling hints only; do not add unless "
            "visible in the prescription):\n- " + "\n- ".join(inventory_names)
        )
    ai = await _gemini_vision_json(
        image_bytes,
        mime,
        user_prompt=(
            "Extract every visible prescription medicine as specified. "
            "Use the nearby inventory names only to correct ambiguous brand "
            "spellings and to populate alt_names; never invent extra items."
            f"{hint_block}"
        ),
    )
    if ai is None:
        # Quota / network / hard fail — give customer a manual fallback list
        manual = await _nearby_pharmacy_listing(db, payload.lat, payload.lng, payload.radius_km)
        return {
            "ok": False,
            "code": "ai_busy",
            "message": "AI এখন একটু busy — একটু পরে আবার চেষ্টা করুন, অথবা নিচ থেকে নিজে pharmacy বেছে নিন।",
            "manual_options": manual,
        }

    if not ai.get("is_prescription"):
        return {
            "ok": False,
            "code": "not_prescription",
            "message": (ai.get("reason") or "এটি prescription বলে মনে হচ্ছে না — "
                        "একটি স্পষ্ট prescription-এর ছবি upload করুন।")[:300],
        }

    raw_meds = ai.get("medicines") or []
    rx_meds: List[Dict[str, Any]] = []
    for m in raw_meds[:30]:
        nm = (m.get("generic_or_brand_name") or "").strip()
        if not nm:
            continue
        try:
            qty = max(1, min(200, int(m.get("quantity") or 1)))
        except Exception:
            qty = 1
        alts_raw = m.get("alt_names") or []
        if isinstance(alts_raw, str):
            alts_raw = [alts_raw]
        alt_names: List[str] = []
        for a in alts_raw[:6]:
            a = (str(a) or "").strip()
            if a and a.lower() != nm.lower() and a not in alt_names:
                alt_names.append(a[:120])
        rx_meds.append({
            "name": nm[:120],
            "alt_names": alt_names,
            "strength": (m.get("strength") or "")[:60],
            "form": (m.get("form") or "")[:40],
            "quantity": qty,
            "instructions": (m.get("instructions") or "")[:200],
        })

    if not rx_meds:
        return {
            "ok": False,
            "code": "not_prescription",
            "message": "Prescription-এ কোনও medicine পড়া গেল না — দয়া করে clear ছবি upload করুন।",
        }

    proposals = await _build_pharmacy_proposals(
        db, rx_meds, payload.lat, payload.lng, payload.radius_km
    )
    # NOTE: do NOT increment usage here — scanning/previewing is free.
    # Credit is charged in /prescription-dispatch when the order is sent.
    usage = await ai_quota.get_usage_summary(db, account.id)
    usage = usage.get("smart_prescription", usage)
    if not proposals:
        return {
            "ok": False,
            "code": "no_pharmacies",
            "message": (
                f"আপনার {payload.radius_km:.0f} km এর মধ্যে এই medicine গুলো পাওয়া "
                "যায়নি। একটু পরে আবার চেষ্টা করুন বা manually search করুন।"
            ),
            "ai": {
                "medicines": rx_meds,
                "doctor_name": (ai.get("doctor_name") or "")[:80],
                "doctor_specialty": (ai.get("doctor_specialty") or "")[:60],
                "patient_name": (ai.get("patient_name") or "")[:80],
                "notes": (ai.get("notes") or "")[:200],
            },
            "usage": usage,
        }

    return {
        "ok": True,
        "ai": {
            "medicines": rx_meds,
            "doctor_name": (ai.get("doctor_name") or "")[:80],
            "doctor_specialty": (ai.get("doctor_specialty") or "")[:60],
            "patient_name": (ai.get("patient_name") or "")[:80],
            "notes": (ai.get("notes") or "")[:200],
        },
        "proposals": proposals,
        "usage": usage,
    }


async def _nearby_pharmacy_listing(
    db: AsyncSession,
    lat: float | None,
    lng: float | None,
    radius_km: float,
) -> List[Dict[str, Any]]:
    """Lightweight fallback list when AI vision fails — just nearby open
    pharmacies the customer can manually pick."""
    rows = (await db.execute(
        select(PharmacyProfile).where(
            PharmacyProfile.is_published.is_(True),
            PharmacyProfile.is_blocked.is_(False),
        )
    )).scalars().all()
    out: List[Dict[str, Any]] = []
    for p in rows:
        if not is_open_now(p):
            continue
        dist: float | None = None
        if lat is not None and lng is not None and p.lat is not None and p.lng is not None:
            dist = _km(lat, lng, p.lat, p.lng)
            if dist > radius_km:
                continue
        out.append({
            "id": str(p.id),
            "name": p.pharmacy_name,
            "rating": round(p.rating, 1),
            "distance_km": round(dist, 2) if dist is not None else None,
            "delivery_fee": delivery_fee_for_distance(dist),
        })
    out.sort(key=lambda x: (x["distance_km"] is None, x["distance_km"] or 999))
    return out[:6]


async def _build_pharmacy_proposals(
    db: AsyncSession,
    rx_meds: List[Dict[str, Any]],
    lat: float | None,
    lng: float | None,
    radius_km: float,
) -> List[Dict[str, Any]]:
    """For each pharmacy in radius, see how many of the prescribed
    medicines they can fulfil and at what price. Candidates rank by
    (coverage desc, tier offer-share × quality desc, total asc, distance
    asc), then the "Y/4 prescription offers" round gate filters them
    (exposure.gate_rx_candidates — best coverage is never gated away).
    Returns the best plan, plus one split partner if that strictly
    improves coverage."""
    rows = (await db.execute(
        select(Medicine)
        .options(selectinload(Medicine.pharmacy))
        .where(
            Medicine.is_active.is_(True),
            Medicine.stock > 0,
            Medicine.approval_status == "approved",
        )
    )).scalars().all()

    # Group by pharmacy
    by_pharm: Dict[UUID, List[Medicine]] = {}
    for m in rows:
        if not m.pharmacy or not m.pharmacy.is_published or m.pharmacy.is_blocked or not is_open_now(m.pharmacy):
            continue
        by_pharm.setdefault(m.pharmacy_id, []).append(m)

    proposals: List[Dict[str, Any]] = []
    for pharm_id, meds in by_pharm.items():
        p = meds[0].pharmacy
        # distance gate
        dist: float | None = None
        if lat is not None and lng is not None and p.lat is not None and p.lng is not None:
            dist = _km(lat, lng, p.lat, p.lng)
            if dist > radius_km:
                continue

        items_found: List[Dict[str, Any]] = []
        items_missing: List[Dict[str, Any]] = []

        for rx in rx_meds:
            best_score, best_med = _best_match(rx, meds)
            if best_med is not None and best_score >= 0.55:
                qty = min(rx["quantity"], best_med.stock)
                items_found.append({
                    "medicine_id": str(best_med.id),
                    "name": best_med.name,
                    "rx_name": rx["name"],
                    "rx_strength": rx["strength"],
                    "rx_instructions": rx["instructions"],
                    "qty": qty,
                    "unit_price": float(best_med.price),
                    "image_url": best_med.image_url,
                    "prescription_required": bool(getattr(best_med, "prescription_required", False)),
                    "match_score": best_score,
                })
            else:
                items_missing.append({
                    "rx_name": rx["name"],
                    "rx_strength": rx["strength"],
                    "qty": rx["quantity"],
                    "instructions": rx["instructions"],
                })

        if not items_found:
            continue

        subtotal = sum(it["unit_price"] * it["qty"] for it in items_found)
        delivery_fee = delivery_fee_for_distance(dist)
        total = round(subtotal + delivery_fee, 2)
        coverage_pct = round(100 * len(items_found) / len(rx_meds), 1)
        eta_min = max(15, int(20 + (dist or 0) * 6))  # rough rider ETA

        proposals.append({
            "pharmacy": {
                "id": str(p.id),
                "name": p.pharmacy_name,
                "business_name": p.business_name,
                "banner_photo_url": p.banner_photo_url,
                "rating": round(p.rating, 1),
                "rating_count": p.rating_count,
                "is_verified": p.is_verified,
                "subscription_tier": p.subscription_tier,
                "phone_number": p.phone_number,
            },
            "items": items_found,
            "missing": items_missing,
            "coverage_pct": coverage_pct,
            "subtotal": round(subtotal, 2),
            "delivery_fee": delivery_fee,
            "total": total,
            "distance_km": round(dist, 2) if dist is not None else None,
            "eta_min": eta_min,
        })

    # Rank: most coverage first (prescriptions must be fulfillable — no
    # subscription plan may override that), then the tier offer-share ×
    # quality weight (A=3 > B=2 > C=1, rating/distance nudge within tier),
    # then cheapest, then nearest.
    proposals.sort(key=lambda x: (
        -x["coverage_pct"],
        -rx_rank_weight(
            x["pharmacy"]["subscription_tier"],
            quality_score(
                x["pharmacy"]["rating"], x["pharmacy"]["rating_count"],
                x["distance_km"], radius_km,
            ),
        ),
        x["total"],
        x["distance_km"] if x["distance_km"] is not None else 999.0,
    ))
    if not proposals:
        return []

    # "Y / 4 prescription offers" — each pharmacy is only eligible in
    # rx_offers_out_of_4 of every 4 offer rounds (C=1, B=2, A=3). The gate
    # never hides the best-coverage option and always keeps ≥3 candidates
    # when they exist, so the customer experience can't degrade.
    now_ts = time.time()
    proposals = gate_rx_candidates(
        proposals,
        is_open=lambda x: rx_offer_window_open(
            x["pharmacy"]["id"], x["pharmacy"]["subscription_tier"], now=now_ts,
        ),
        coverage=lambda x: x["coverage_pct"],
        min_keep=3,
    )

    best = proposals[0]
    # ------------------------------------------------------------------
    # MULTI-PHARMACY SPLIT (Phase B)
    # ------------------------------------------------------------------
    # If the best single pharmacy already covers ALL items, no split needed.
    # Otherwise, look for ONE more pharmacy that fills the most "missing"
    # items so the customer can order from 2 pharmacies in parallel rather
    # than going elsewhere. We strongly prefer a single-pharmacy plan; only
    # split when it gives strictly better coverage.
    if not best["missing"]:
        return [best]

    best_missing_keys: set[tuple[str, str]] = {
        ((m.get("rx_name") or "").strip().lower(),
         (m.get("rx_strength") or "").strip().lower())
        for m in best["missing"]
    }

    candidates: List[Dict[str, Any]] = []
    for prop in proposals[1:]:
        # Items from this pharmacy that fill best's missing slots
        covering_items: List[Dict[str, Any]] = []
        for it in prop["items"]:
            key = (
                (it.get("rx_name") or "").strip().lower(),
                (it.get("rx_strength") or "").strip().lower(),
            )
            if key in best_missing_keys:
                covering_items.append(it)
        if not covering_items:
            continue

        new_subtotal = sum(it["unit_price"] * it["qty"] for it in covering_items)
        new_delivery = prop["delivery_fee"]
        new_total = round(new_subtotal + new_delivery, 2)
        covered_keys = {
            ((it.get("rx_name") or "").strip().lower(),
             (it.get("rx_strength") or "").strip().lower())
            for it in covering_items
        }
        leftover_missing = [
            m for m in best["missing"]
            if ((m.get("rx_name") or "").strip().lower(),
                (m.get("rx_strength") or "").strip().lower()) not in covered_keys
        ]
        candidates.append({
            **prop,
            "items": covering_items,
            "missing": leftover_missing,
            "subtotal": round(new_subtotal, 2),
            "delivery_fee": new_delivery,
            "total": new_total,
            "coverage_pct": round(
                100 * len(covering_items) / max(len(rx_meds), 1), 1
            ),
        })

    if not candidates:
        return [best]

    candidates.sort(key=lambda x: (
        -len(x["items"]),
        -(x["pharmacy"]["rating"] or 0),
        x["total"],
        x["distance_km"] if x["distance_km"] is not None else 999.0,
    ))
    secondary = candidates[0]
    # Final sanity: only return the split if it strictly improves coverage
    if len(secondary["items"]) == 0:
        return [best]
    return [best, secondary]


# ---------- /prescription-handshake (Phase C) ----------
#
# Two-phase order placement:
#   Phase 1 (this endpoint) — customer clicks "Send to pharmacy" in the
#   Smart-Prescription modal. We open the chat(s) and post a single
#   `ai_handshake` message asking the pharmacy "do you have these meds?".
#   No quota is consumed yet, no Order row is created. The pharmacy
#   answers with `pharmacy_handshake_ok` / `pharmacy_handshake_reject`
#   (handled in conversations.py); on "ok" the server auto-posts an
#   `ai_customer_confirm_prompt` to that chat. The modal polls the
#   conversation(s) and lights up a Final-Confirm button as soon as the
#   pharmacy says yes.
#
#   Phase 2 — `/prescription-dispatch` with the `handshake_ids` field set.
#   This consumes the credit, creates real Order rows and `order_request`
#   chat messages exactly like the legacy single-step flow, and closes
#   the open handshake messages with an `ai_handshake_completed` note.
# -----------------------------------------------------------------------


@router.post("/prescription-handshake", status_code=201)
async def prescription_handshake(
    payload: PrescriptionDispatchIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Phase-1 of the AI brokered prescription order. Opens (or reuses) the
    customer↔pharmacy conversation(s) and posts an `ai_handshake` message
    asking the pharmacy to confirm stock availability. Does NOT consume the
    Smart-Prescription quota and does NOT create an Order row — that
    happens later in `/prescription-dispatch` when the customer hits the
    Final-Confirm button after the pharmacy says yes.
    """
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers can start a prescription handshake")
    ensure_customer_not_banned(account)

    # Hard-block when out of quota so the customer can't drag pharmacies
    # into a handshake they cannot finish.
    await ai_quota.check_quota(db, account.id, "smart_prescription")

    if not _resolve_upload_path(payload.prescription_url):
        raise HTTPException(400, "Invalid prescription URL")

    plan_specs: List[Dict[str, Any]] = []
    if payload.plans:
        for p in payload.plans:
            plan_specs.append({
                "pharmacy_id": p.pharmacy_id,
                "items": p.items,
                "subtotal": float(p.subtotal),
                "delivery_fee": float(p.delivery_fee),
                "total": float(p.total),
            })
    elif payload.pharmacy_id and payload.items:
        plan_specs.append({
            "pharmacy_id": payload.pharmacy_id,
            "items": payload.items,
            "subtotal": float(payload.subtotal or 0),
            "delivery_fee": float(payload.delivery_fee or 0),
            "total": float(payload.total or 0),
        })
    if not plan_specs:
        raise HTTPException(400, "No pharmacy plan supplied")
    if len(plan_specs) > 3:
        raise HTTPException(400, "Too many pharmacies in plan (max 3)")

    cust_profile = (
        await db.execute(
            select(CustomerProfile).where(CustomerProfile.account_id == account.id)
        )
    ).scalar_one_or_none()

    is_split = len(plan_specs) > 1
    opened: List[Dict[str, Any]] = []

    for plan_idx, spec in enumerate(plan_specs):
        pharmacy = (
            await db.execute(
                select(PharmacyProfile).where(PharmacyProfile.id == spec["pharmacy_id"])
            )
        ).scalar_one_or_none()
        if not pharmacy:
            raise HTTPException(404, f"Pharmacy {spec['pharmacy_id']} not found")
        if pharmacy.is_blocked:
            raise HTTPException(
                status.HTTP_423_LOCKED,
                detail={"code": "pharmacy_blocked",
                        "message": f"{pharmacy.pharmacy_name} আপাতত MediDoor-এ available নয়।"},
            )

        conv = (
            await db.execute(
                select(Conversation).where(
                    Conversation.pharmacy_id == pharmacy.id,
                    Conversation.customer_account_id == account.id,
                )
            )
        ).scalar_one_or_none()
        if not conv:
            customer_name = (
                (f"{cust_profile.first_name or ''} {cust_profile.last_name or ''}".strip()
                 or account.gmail or "Customer")
                if cust_profile else (account.gmail or "Customer")
            )
            conv = Conversation(
                pharmacy_id=pharmacy.id,
                customer_account_id=account.id,
                customer_name=customer_name,
            )
            db.add(conv)
            await db.flush()

        if conv.blocked_at is not None:
            raise HTTPException(
                status.HTTP_423_LOCKED,
                detail={"code": "conversation_blocked",
                        "message": "এই conversation locked — admin review পর্যন্ত order পাঠানো যাবে না।"},
            )

        canonical = await _canonical_prescription_plan(
            db,
            pharmacy,
            spec["items"],
            delivery_lat=payload.delivery_lat,
            delivery_lng=payload.delivery_lng,
            fallback_delivery_fee=spec.get("delivery_fee"),
        )
        items_clean = canonical["items"]

        # Bug #12 — duplicate handshake guard. If the same customer dispatched
        # an identical handshake (same items signature) to this pharmacy in
        # the last 60s and it is still awaiting_pharmacy / awaiting_customer,
        # reuse it instead of creating a new one.
        items_sig = tuple(sorted(
            (it["medicine_id"], int(it["qty"])) for it in items_clean
        ))
        recent_cutoff = datetime.utcnow() - timedelta(seconds=60)
        recent_handshakes = (await db.execute(
            select(ConversationMessage).where(
                ConversationMessage.conversation_id == conv.id,
                ConversationMessage.preset_key == "ai_handshake",
                ConversationMessage.created_at >= recent_cutoff,
            )
        )).scalars().all()
        dup_existing = None
        for rh in recent_handshakes:
            try:
                rp = json.loads(rh.payload_json) if rh.payload_json else {}
            except Exception:
                continue
            if rp.get("status") in ("confirmed", "rejected", "cancelled", "timeout"):
                continue
            rsig = tuple(sorted(
                (str(x.get("medicine_id") or ""), int(x.get("qty") or 1))
                for x in (rp.get("items") or [])
            ))
            if rsig == items_sig:
                dup_existing = (rh, rp)
                break
        if dup_existing is not None:
            _, dup_payload = dup_existing
            opened.append({
                "conversation_id": str(conv.id),
                "handshake_id": dup_payload.get("handshake_id"),
                "pharmacy_id": str(pharmacy.id),
                "pharmacy_name": pharmacy.pharmacy_name,
                "duplicate": True,
            })
            continue

        handshake_id = str(uuid4())

        # One-line headline only — full detail lives in the card payload.
        # The chat UI renders an interactive HandshakeCard from the payload
        # and ignores this body; the body is only the plain-text fallback
        # (notifications, search previews).
        split_tag = f" ({plan_idx + 1}/{len(plan_specs)})" if is_split else ""
        body_text = (
            f"🤝 Stock check — {len(items_clean)} টি ওষুধ · ৳{canonical['total']:.0f}{split_tag}"
        )

        handshake_payload = {
            "handshake_id": handshake_id,
            "items": items_clean,
            "subtotal": canonical["subtotal"],
            "delivery_fee": canonical["delivery_fee"],
            "total": canonical["total"],
            "prescription_url": payload.prescription_url,
            "pharmacy_id": str(pharmacy.id),
            "pharmacy_name": pharmacy.pharmacy_name,
            "note": payload.note,
            "delivery_address": payload.delivery_address,
            "delivery_lat": payload.delivery_lat,
            "delivery_lng": payload.delivery_lng,
            "split_part": plan_idx + 1 if is_split else None,
            "split_total": len(plan_specs) if is_split else None,
            "status": "awaiting_pharmacy",
        }

        # The handshake card itself — system message so it is clearly
        # marked as "AI on behalf of customer", but it carries an
        # attachment (the prescription) so the pharmacy can read it.
        db.add(ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.system,
            body=body_text,
            attachment_url=payload.prescription_url,
            preset_key="ai_handshake",
            payload_json=json.dumps(handshake_payload, ensure_ascii=False),
            visibility="all",
        ))
        now = datetime.utcnow()
        conv.last_message_at = now
        conv.customer_last_read_at = now

        opened.append({
            "conversation_id": str(conv.id),
            "handshake_id": handshake_id,
            "pharmacy_id": str(pharmacy.id),
            "pharmacy_name": pharmacy.pharmacy_name,
        })

    await db.commit()

    return {
        "ok": True,
        "is_split": is_split,
        "conversations": opened,
        # Convenience aliases for clients that expect single-pharmacy fields.
        "conversation_id": opened[0]["conversation_id"],
        "handshake_id": opened[0]["handshake_id"],
        "pharmacy_id": opened[0]["pharmacy_id"],
        "pharmacy_name": opened[0]["pharmacy_name"],
    }


# ---------- /prescription-dispatch ----------

@router.post("/prescription-dispatch", status_code=201)
async def prescription_dispatch(
    payload: PrescriptionDispatchIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Final-confirm a Smart Prescription order after pharmacy stock check.

    This opens/reuses the conversation and posts BOTH a friendly system note
    and the actual order_request message with the prescription image attached.
    """
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers can dispatch a prescription order")
    ensure_customer_not_banned(account)

    # Quota gate — Smart Prescription credit is consumed here, only when an
    # actual order is being sent. (Scanning/previewing is free — see
    # /prescription-scan.) Re-check the quota right before we commit so a
    # customer who exhausted quota between scan and dispatch is blocked.
    await ai_quota.check_quota(db, account.id, "smart_prescription")

    # Validate prescription URL points to a real upload
    if not _resolve_upload_path(payload.prescription_url):
        raise HTTPException(400, "Invalid prescription URL")

    # ------------------------------------------------------------------
    # Normalise: build a unified list of (pharmacy_id, items, subtotal,
    # delivery_fee, total) plans regardless of whether the client used the
    # new `plans` field or the legacy single-pharmacy fields. Phase B
    # multi-pharmacy split sends a `plans` list with 1 or 2 entries.
    # ------------------------------------------------------------------
    plan_specs: List[Dict[str, Any]] = []
    if payload.plans:
        for p in payload.plans:
            plan_specs.append({
                "pharmacy_id": p.pharmacy_id,
                "items": p.items,
                "subtotal": float(p.subtotal),
                "delivery_fee": float(p.delivery_fee),
                "total": float(p.total),
            })
    elif payload.pharmacy_id and payload.items:
        plan_specs.append({
            "pharmacy_id": payload.pharmacy_id,
            "items": payload.items,
            "subtotal": float(payload.subtotal or 0),
            "delivery_fee": float(payload.delivery_fee or 0),
            "total": float(payload.total or 0),
        })
    if not plan_specs:
        raise HTTPException(400, "No pharmacy plan supplied")
    if len(plan_specs) > 3:
        raise HTTPException(400, "Too many pharmacies in plan (max 3)")
    wanted_handshake_ids = {str(h) for h in (payload.handshake_ids or []) if h}
    if not wanted_handshake_ids:
        raise HTTPException(
            400,
            "Pharmacy stock confirmation required before placing Smart Prescription order",
        )

    # Pre-fetch customer profile once (used per plan)
    cust_profile = (
        await db.execute(
            select(CustomerProfile).where(CustomerProfile.account_id == account.id)
        )
    ).scalar_one_or_none()
    cust_name = (
        f"{cust_profile.first_name or ''} {cust_profile.last_name or ''}".strip()
        if cust_profile else (account.gmail or "Customer")
    ) or "Customer"
    cust_phone = (cust_profile.phone_number if cust_profile else None) or "+8800000000000"
    delivery_addr = (payload.delivery_address or "").strip() or "AI prescription order — see chat"

    is_split = len(plan_specs) > 1
    dispatched: List[Dict[str, Any]] = []
    credit_already_consumed = False
    credit_already_consumed = (await db.execute(
        select(Order.id).where(
            Order.customer_account_id == account.id,
            Order.prescription_url == payload.prescription_url,
            Order.created_at >= datetime.utcnow() - timedelta(hours=2),
        ).limit(1)
    )).scalar_one_or_none() is not None

    for plan_idx, spec in enumerate(plan_specs):
        pharmacy = (
            await db.execute(
                select(PharmacyProfile).where(PharmacyProfile.id == spec["pharmacy_id"])
            )
        ).scalar_one_or_none()
        if not pharmacy:
            raise HTTPException(404, f"Pharmacy {spec['pharmacy_id']} not found")
        if pharmacy.is_blocked:
            raise HTTPException(
                status.HTTP_423_LOCKED,
                detail={"code": "pharmacy_blocked",
                        "message": f"{pharmacy.pharmacy_name} আপাতত MediDoor-এ available নয়।"},
            )

        # ---- open or reuse conversation ----
        conv = (
            await db.execute(
                select(Conversation).where(
                    Conversation.pharmacy_id == pharmacy.id,
                    Conversation.customer_account_id == account.id,
                )
            )
        ).scalar_one_or_none()
        if not conv:
            customer_name = (
                (f"{cust_profile.first_name or ''} {cust_profile.last_name or ''}".strip()
                 or account.gmail or "Customer")
                if cust_profile else (account.gmail or "Customer")
            )
            conv = Conversation(
                pharmacy_id=pharmacy.id,
                customer_account_id=account.id,
                customer_name=customer_name,
            )
            db.add(conv)
            await db.flush()

        if conv.blocked_at is not None:
            raise HTTPException(
                status.HTTP_423_LOCKED,
                detail={"code": "conversation_blocked",
                        "message": "এই conversation locked — admin review পর্যন্ত order পাঠানো যাবে না।"},
            )

        if wanted_handshake_ids:
            handshake_rows = (await db.execute(
                select(ConversationMessage).where(
                    ConversationMessage.conversation_id == conv.id,
                    ConversationMessage.preset_key == "ai_handshake",
                ).order_by(ConversationMessage.created_at.desc())
            )).scalars().all()
            matched_handshake: Dict[str, Any] | None = None
            for row in handshake_rows:
                try:
                    row_payload = json.loads(row.payload_json) if row.payload_json else {}
                except Exception:
                    row_payload = {}
                if row_payload.get("handshake_id") not in wanted_handshake_ids:
                    continue
                if row_payload.get("pharmacy_id") != str(pharmacy.id):
                    continue
                matched_handshake = row_payload
                break
            if matched_handshake is None:
                raise HTTPException(409, f"No matching pharmacy confirmation for {pharmacy.pharmacy_name}")
            if str(matched_handshake.get("status") or "") not in ("pharmacy_ok", "awaiting_customer"):
                raise HTTPException(409, f"{pharmacy.pharmacy_name} has not confirmed stock yet")

        canonical = await _canonical_prescription_plan(
            db,
            pharmacy,
            spec["items"],
            delivery_lat=payload.delivery_lat,
            delivery_lng=payload.delivery_lng,
            fallback_delivery_fee=spec.get("delivery_fee"),
            reserve_stock=True,
        )
        items_clean = canonical["items"]

        # Headline body only — order_request card renders the itemised table
        # from the payload (items + totals + attachment + note).
        split_tag = f" ({plan_idx + 1}/{len(plan_specs)})" if is_split else ""
        body_text = f"📋 AI prescription order — {len(items_clean)} টি ওষুধ · ৳{canonical['total']:.0f}{split_tag}"

        # All rows written inside this single transaction would otherwise share
        # one `func.now()` timestamp (Postgres now() = transaction start), which
        # makes the chat order-state machine's created_at ordering ambiguous.
        # Assign explicit, strictly-increasing timestamps so the frontend can
        # reliably scope intro → request → confirm.
        base_ts = datetime.utcnow()

        # Quiet system pill — most chats will collapse this into a single line.
        ai_intro = "🤖 medi AI placed this order on customer's behalf."
        sys_msg = ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.system,
            body=ai_intro,
            preset_key="ai_prescription_intro",
            visibility="all",
            created_at=base_ts,
        )
        db.add(sys_msg)

        # The actual customer order_request with attachment
        order_msg = ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.customer,
            body=body_text,
            attachment_url=payload.prescription_url,
            preset_key="order_request",
            payload_json=json.dumps({
                "items": items_clean,
                "subtotal": canonical["subtotal"],
                "delivery_fee": canonical["delivery_fee"],
                "total": canonical["total"],
                "source": "ai_prescription",
                "split_part": plan_idx + 1 if is_split else None,
                "split_total": len(plan_specs) if is_split else None,
                "delivery_address": payload.delivery_address,
                "delivery_lat": payload.delivery_lat,
                "delivery_lng": payload.delivery_lng,
            }),
            visibility="all",
            created_at=base_ts + timedelta(milliseconds=10),
        )
        db.add(order_msg)

        # ---- Materialise a real Order row immediately ----
        # This dispatch is the FINAL confirm step of the AI handshake: the
        # pharmacy already accepted stock ("Accept — স্টক আছে") and the customer
        # already hit "Final Confirm". So the order is a fully-agreed, CONFIRMED
        # order — not a fresh request awaiting pharmacy approval. Create it as
        # `confirmed` and post a matching `order_confirm` chat event so the
        # pharmacy's next action is "🟢 Packing শুরু" (not a redundant
        # "Confirm request" that could never advance the workflow).
        items_for_order = canonical["order_items"]
        new_order = Order(
            pharmacy_id=pharmacy.id,
            customer_account_id=account.id,
            customer_name=cust_name,
            customer_phone=cust_phone,
            delivery_address=delivery_addr,
            delivery_lat=payload.delivery_lat,
            delivery_lng=payload.delivery_lng,
            items_json=json.dumps(items_for_order, ensure_ascii=False),
            prescription_url=payload.prescription_url,
            note=payload.note,
            subtotal=float(canonical["subtotal"]),
            delivery_fee=float(canonical["delivery_fee"]),
            total=float(canonical["total"]),
            status=OrderStatus.confirmed,
            conversation_id=conv.id,
            stock_reserved=True,  # canonical plan reserved stock — restore on cancel/reject
            # Keep the Order at/after the order_request timestamp so the later
            # `_ensure_chat_order` reuse check (existing.created_at >=
            # last_request.created_at) re-uses THIS order instead of creating a
            # duplicate when the pharmacy clicks "Call rider".
            created_at=base_ts + timedelta(milliseconds=40),
        )
        db.add(new_order)
        await db.flush()
        db.add(OrderMessage(
            order_id=new_order.id,
            sender_role=SenderRole.system,
            body=f"নতুন AI prescription order #{str(new_order.id)[:8]} — stock confirmed, packing এর অপেক্ষায়।",
            preset_key="confirmed",
        ))

        # Chat-side confirm event so `lastOrderState`/`OrderQuickActions` treat
        # this AI order as already confirmed and jump straight to Packing.
        db.add(ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.pharmacy,
            body=f"✅ স্টক আছে — অর্ডার confirm, প্যাকিং শুরু করছি (মোট ৳{canonical['total']:.0f})।",
            preset_key="order_confirm",
            visibility="all",
            created_at=base_ts + timedelta(milliseconds=20),
        ))
        conv.last_message_at = base_ts + timedelta(milliseconds=30)

        dispatched.append({
            "conversation_id": str(conv.id),
            "order_id": str(new_order.id),
            "pharmacy_id": str(pharmacy.id),
            "pharmacy_name": pharmacy.pharmacy_name,
        })

    # ---- Phase-C: close any open handshake messages for these conversations.
    # When this dispatch is the Final-Confirm step of a `/prescription-handshake`,
    # mark the `ai_handshake` and `ai_customer_confirm_prompt` rows so the
    # chat UI can switch them from "awaiting" → "confirmed".
    if payload.handshake_ids:
        wanted = {str(h) for h in payload.handshake_ids if h}
        if wanted:
            conv_ids = [UUID(d["conversation_id"]) for d in dispatched]
            open_rows = (await db.execute(
                select(ConversationMessage).where(
                    ConversationMessage.conversation_id.in_(conv_ids),
                    ConversationMessage.preset_key.in_(
                        ("ai_handshake", "ai_customer_confirm_prompt")
                    ),
                )
            )).scalars().all()
            for row in open_rows:
                try:
                    pl = json.loads(row.payload_json) if row.payload_json else {}
                except Exception:
                    pl = {}
                hid = pl.get("handshake_id")
                if hid and hid in wanted:
                    pl["status"] = "confirmed"
                    row.payload_json = json.dumps(pl, ensure_ascii=False)
                    db.add(row)
            # Post a single closing system note per conversation.
            # Include matching handshake_id(s) so the chat UI can mark the
            # corresponding handshake / confirm-prompt cards as resolved.
            # Build a per-conv map of handshake_ids that were just confirmed.
            confirmed_by_conv: dict[str, list[str]] = {}
            for row in open_rows:
                try:
                    pl = json.loads(row.payload_json) if row.payload_json else {}
                except Exception:
                    pl = {}
                hid = pl.get("handshake_id")
                if hid and hid in wanted:
                    confirmed_by_conv.setdefault(str(row.conversation_id), []).append(hid)
            for d in dispatched:
                hids = confirmed_by_conv.get(d["conversation_id"], [])
                primary_hid = hids[0] if hids else None
                db.add(ConversationMessage(
                    conversation_id=UUID(d["conversation_id"]),
                    sender_role=SenderRole.system,
                    body="✅ Customer final confirm — order placed.",
                    preset_key="ai_handshake_completed",
                    payload_json=json.dumps({
                        "order_id": d["order_id"],
                        "handshake_id": primary_hid,
                        "handshake_ids": hids,
                    }),
                    visibility="all",
                ))

    # Consume ONE smart-prescription credit for the whole plan, even if it
    # was split across multiple pharmacies (customer pays per use, not per
    # pharmacy).
    if credit_already_consumed:
        usage_summary = await ai_quota.get_usage_summary(db, account.id)
        usage = usage_summary.get("smart_prescription", usage_summary)
    else:
        usage = await ai_quota.increment(db, account.id, "smart_prescription")

    await db.commit()
    # Primary fields point to the FIRST dispatched plan so legacy clients
    # that expect single-pharmacy fields keep working.
    first = dispatched[0]
    return {
        "ok": True,
        "is_split": is_split,
        "dispatched": dispatched,
        "conversation_id": first["conversation_id"],
        "order_id": first["order_id"],
        "pharmacy_id": first["pharmacy_id"],
        "pharmacy_name": first["pharmacy_name"],
        "usage": usage,
    }


# ---------- /addon-suggest (Phase 3) ----------
# Customer taps "Suggest items" on an `ai_addon_prompt` system card. Server
# loads top medicines from that pharmacy's catalog (active, in-stock,
# approved) and returns them so the chat can render a 1-tap shop card.

class AddonSuggestIn(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=80)
    limit: int = Field(default=6, ge=1, le=12)


@router.post("/addon-suggest")
async def addon_suggest(
    payload: AddonSuggestIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    if account.role != RoleEnum.customer:
        raise HTTPException(status_code=403, detail="Only customers can request add-on suggestions.")
    try:
        conv_id = UUID(payload.conversation_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid conversation_id.")
    conv = (await db.execute(
        select(Conversation).where(
            Conversation.id == conv_id,
            Conversation.customer_account_id == account.id,
        )
    )).scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    rows = (await db.execute(
        select(Medicine).where(
            Medicine.pharmacy_id == conv.pharmacy_id,
            Medicine.is_active.is_(True),
            Medicine.stock > 0,
            Medicine.approval_status == "approved",
            Medicine.prescription_required.is_(False),
        ).order_by(desc(Medicine.stock)).limit(payload.limit)
    )).scalars().all()

    items = [
        {
            "medicine_id": str(m.id),
            "name": m.name,
            "image_url": m.image_url,
            "price": float(m.price or 0),
            "category": m.category,
            "prescription_required": bool(m.prescription_required),
            "stock": int(m.stock),
        }
        for m in rows
    ]
    return {"ok": True, "items": items, "pharmacy_id": str(conv.pharmacy_id)}


# ---------- /symptom-search ----------

class SymptomSearchIn(BaseModel):
    q: str = Field(min_length=1, max_length=160)
    # Location mandatory (5 km connect rule); radius capped at the connect radius.
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    radius_km: float = Field(default=GEO_CONNECT_RADIUS_KM, ge=0.5, le=GEO_CONNECT_RADIUS_KM)


SYMPTOM_SYSTEM_TEXT = """\
You are MediDoor's symptom-to-medicine assistant for Bangladesh OTC pharmacy
search. The user types a short query in Bengali, Banglish or English. Decide:

A) Plain medicine name (e.g. "Napa", "Paracetamol", "Seclo 20", "Montair") —
   set is_symptom=false. Do NOT invent suggestions.
B) Symptom or condition (e.g. "জ্বর", "jor", "fever", "মাথা ব্যথা",
   "matha betha", "headache", "পেট খারাপ", "diarrhea", "সর্দি কাশি",
   "cold cough", "চোখ জ্বালা", "eye irritation") — set is_symptom=true and
   return safe over-the-counter generic names + plausible category names that
   a Bangladesh customer would expect to see.

When is_symptom=true, populate:
  - condition: short English label (e.g. "Fever", "Headache").
  - generic_names: array of 3–8 OTC generic / brand names commonly stocked
    in Bangladesh (e.g. ["paracetamol", "napa", "ace", "fast"] for fever).
    Use lowercase. Include both generic and very common brand names.
  - categories: 1–3 likely category names from a typical pharmacy catalog
    (e.g. "Pain Relief", "Fever", "Cold & Cough", "Antacid", "Eye Care").
  - banglish_synonyms: 0–4 alternative spellings of the symptom in Banglish
    (e.g. ["jor", "jwor", "jwor"]). Used to match short_description text.
  - short_advice: ONE sentence (≤140 chars) reminding the user to consult a
    doctor for serious or persistent symptoms.

When is_symptom=false:
  - condition, generic_names, categories, banglish_synonyms, short_advice all
    empty / null.

Return STRICT JSON only — no markdown, no commentary. Schema:
{
  "is_symptom": boolean,
  "condition": string,
  "generic_names": string[],
  "categories": string[],
  "banglish_synonyms": string[],
  "short_advice": string
}
"""


def _serialize_med_for_symptom(m: Medicine, p: PharmacyProfile, distance_km: float | None) -> Dict[str, Any]:
    rules = tier_rules(p.subscription_tier)
    return {
        "id": str(m.id),
        "name": m.name,
        "short_description": m.short_description,
        "category": m.category,
        "image_url": m.image_url,
        "price": m.price,
        "stock": m.stock,
        "prescription_required": bool(getattr(m, "prescription_required", False)),
        "pharmacy": {
            "id": str(p.id),
            "name": p.pharmacy_name,
            "rating": round(p.rating, 1),
            "rating_count": p.rating_count,
            "is_verified": p.is_verified,
            "verified_label": rules["badge"] if p.is_verified else None,
            "subscription_tier": p.subscription_tier,
        },
        "distance_km": round(distance_km, 4) if distance_km is not None else None,
        "delivery_fee": delivery_fee_for_distance(distance_km),
    }


@router.post("/symptom-search")
async def symptom_search(
    payload: SymptomSearchIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Customer types a symptom (e.g. "জ্বর") → AI maps it to OTC generic
    names + category list → we filter the SAME nearby-pharmacy pipeline used
    by `/storefront/nearby` and return matching medicines.

    Quota: 5 free symptom searches per customer per month. ONLY the symptom
    branch consumes quota — if the AI says the query is just a plain medicine
    name (`is_symptom: false`), no quota is burned and the frontend should
    fall back to the regular `/storefront/nearby?q=` search.
    """
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers can use symptom search")
    ensure_customer_not_banned(account)

    q = payload.q.strip()
    if not q:
        raise HTTPException(400, "Empty query")
    # Location mandatory — results are gated to the 5 km connect radius.
    if payload.lat is None or payload.lng is None:
        raise location_required_error()

    # Pre-check quota — fail fast with 429 before any AI call.
    await ai_quota.check_quota(db, account.id, "symptom_search")

    ai = await _gemini_json(
        SYMPTOM_SYSTEM_TEXT,
        f"User query: {q}",
        timeout=12.0,
        temperature=0.1,
    )
    if not isinstance(ai, dict):
        # Treat as "AI busy" — do NOT consume quota.
        usage = await ai_quota.get_usage_summary(db, account.id)
        return {
            "ok": False,
            "code": "ai_busy",
            "message": "AI এখন একটু busy — একটু পরে আবার চেষ্টা করুন।",
            "usage": usage.get("symptom_search"),
        }

    is_symptom = bool(ai.get("is_symptom"))
    if not is_symptom:
        # Plain medicine-name search — no quota burned, frontend should
        # fall back to /storefront/nearby?q=.
        usage = await ai_quota.get_usage_summary(db, account.id)
        return {
            "ok": True,
            "is_symptom": False,
            "ai": ai,
            "items": [],
            "usage": usage.get("symptom_search"),
        }

    # ---- Symptom branch: build search terms ----
    generics = [str(s).strip().lower() for s in (ai.get("generic_names") or []) if str(s).strip()][:10]
    categories = [str(s).strip() for s in (ai.get("categories") or []) if str(s).strip()][:5]
    banglish = [str(s).strip().lower() for s in (ai.get("banglish_synonyms") or []) if str(s).strip()][:5]

    # Build OR filter over name + short_description for each generic + the
    # original query + banglish synonyms, plus category IN list.
    needles = list({n for n in (generics + banglish + [q.lower()]) if n})
    name_filters = []
    for n in needles:
        like = f"%{n}%"
        name_filters.append(Medicine.name.ilike(like))
        name_filters.append(Medicine.short_description.ilike(like))
    or_clauses = list(name_filters)
    if categories:
        or_clauses.append(Medicine.category.in_(categories))

    if not or_clauses:
        # AI gave nothing usable — refund (don't increment) and bail.
        return {
            "ok": True,
            "is_symptom": True,
            "ai": ai,
            "items": [],
            "usage": (await ai_quota.get_usage_summary(db, account.id)).get("symptom_search"),
        }

    from sqlalchemy import or_ as sa_or
    stmt = (
        select(Medicine)
        .options(selectinload(Medicine.pharmacy))
        .where(
            Medicine.is_active.is_(True),
            Medicine.stock > 0,
            Medicine.approval_status == "approved",
            sa_or(*or_clauses),
        )
    )
    rows = (await db.execute(stmt)).scalars().all()

    # Same tier exposure law as /storefront/nearby: group per pharmacy and
    # let the engine hand out slots — share ∝ subscription tier (A:B:C =
    # 3:2:1), quality (rating + distance) nudging within tier, per-response
    # impression caps (C=10 / B=20 / A=30) enforced by the engine.
    grouped: Dict[UUID, Dict[str, Any]] = {}
    for m in rows:
        p = m.pharmacy
        if p is None or not p.is_published or p.is_blocked or not is_open_now(p):
            continue
        distance: float | None = None
        if payload.lat is not None and payload.lng is not None and p.lat is not None and p.lng is not None:
            distance = _km(payload.lat, payload.lng, p.lat, p.lng)
            if distance > payload.radius_km:
                continue
        ent = grouped.setdefault(p.id, {"p": p, "distance": distance, "meds": []})
        ent["meds"].append(m)

    rng = rotation_rng("symptom", q.lower())
    feeds: List[PharmacyFeed] = []
    pharmacy_ids: set[UUID] = set()
    for ent in grouped.values():
        p = ent["p"]
        meds = list(ent["meds"])
        rng.shuffle(meds)
        feeds.append(PharmacyFeed(
            key=p.id,
            tier=p.subscription_tier,
            quality=quality_score(p.rating, p.rating_count, ent["distance"], payload.radius_km),
            items=[_serialize_med_for_symptom(m, p, ent["distance"]) for m in meds],
        ))
        pharmacy_ids.add(p.id)
    items = weighted_fair_feed(feeds, limit=60, rng=rng)

    # Consume quota — successful symptom→meds mapping.
    usage = await ai_quota.increment(db, account.id, "symptom_search")
    await db.commit()

    return {
        "ok": True,
        "is_symptom": True,
        "ai": {
            "condition": (ai.get("condition") or "")[:80],
            "generic_names": generics,
            "categories": categories,
            "short_advice": (ai.get("short_advice") or "")[:240],
        },
        "items": items,
        "pharmacy_count": len(pharmacy_ids),
        "usage": usage,
    }


# ---------- /usage ----------

@router.get("/usage")
async def ai_usage(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Return this customer's per-feature monthly usage + remaining free
    quota. Used by the customer profile + landing page to show counters."""
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers have AI usage")
    return await ai_quota.get_usage_summary(db, account.id)


@router.post("/usage/renew")
async def ai_usage_renew(
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Quota reset is a PAID action — it must not be free.

    Every AI call spends real money (Gemini), so letting anyone reset their
    quota for free means unlimited free AI on our cost. Payment isn't built
    yet, so for now we simply refuse: the free quota only refills on the 1st
    of each calendar month. (When billing lands, this endpoint will verify a
    successful payment before calling `ai_quota.reset_current_month`.)
    """
    if account.role != RoleEnum.customer:
        raise HTTPException(403, "Only customers can renew AI usage")
    usage = await ai_quota.get_usage_summary(db, account.id)
    raise HTTPException(
        status.HTTP_402_PAYMENT_REQUIRED,
        detail={
            "code": "payment_required",
            "message": (
                "Free AI quota reset করতে payment লাগবে — এই feature খুব শীঘ্রই আসছে। "
                "আপাতত প্রতি মাসের ১ তারিখে quota নিজে থেকে reset হবে।"
            ),
            "usage": usage,
        },
    )

