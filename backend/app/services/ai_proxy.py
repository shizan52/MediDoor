"""
medi AI conversation proxy - replies to pharmacy / rider on behalf of the
customer during Smart Prescription flows when it's safe, or asks the customer
privately when it isn't.

Design goals
------------
* In a Smart Prescription order/handshake, pharmacy / rider asks something
    casual that AI can answer from data we
  already have (customer name, delivery address, prescribed items, order
    status, last shared coords) -> AI posts a reply as `sender_role=customer`
    so the chat looks natural - pharmacy / rider should not feel they're
  talking to a bot. We mark the row with `payload_json.ai_proxy=true`
  for audit, but the UI does not badge it.
* Pharmacy / rider asks something requiring a real human decision
    (different brand, change qty, custom address, anything personal) -> AI
  posts a `customer_only` system card (preset `ai_question_for_customer`)
  visible to the customer alone, with a 1-tap reply input. Customer's
  reply is then mirrored back to the pharmacy / rider as a normal
  customer message via `/conversations/{id}/ai-proxy-answer`.

Non-goals
---------
* Replying to anything in a normal/manual order chat. In manual chat the user
    must explicitly call `@mediai`; otherwise AI stays silent.
* Auto-confirming order workflow steps (those go through preset_key
    branches in conversations.py - not this module).
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Conversation,
    ConversationMessage,
    CustomerProfile,
    Order,
    OrderStatus,
    PharmacyProfile,
    RiderProfile,
    SenderRole,
)
from app.services.notify import notify as user_notify


PROXY_SYSTEM = (
    "You are 'medi AI', a friendly proxy speaking ON BEHALF OF a customer "
    "inside a Bangladeshi pharmacy delivery chat (MediDoor). You silently "
    "read the latest message from a pharmacy or rider and decide ONE of "
    "TWO actions:\n"
    "\n"
    "  A) AUTO_ANSWER - reply directly, in the customer's voice, in 1-2 "
    "     short Bangla sentences (Banglish ok). Use ONLY the CONTEXT block "
    "     facts. Sound natural - no greetings, no AI disclaimer, no "
    "     'medi AI' prefix, no formal 'dhonyobad'. Just answer like a "
    "     normal customer would type on their phone.\n"
    "  B) ASK_CUSTOMER - write a short Bangla question to forward to the "
    "     customer privately (max 1 sentence). Use this when the answer is "
    "     personal (a price/brand/qty change, alt medicine, prescription "
    "     clarification, address detail not in context, anything you "
    "     genuinely don't know).\n"
    "\n"
    "Rules:\n"
    "  - If the message is a workflow status update ('preparing', "
    "    'ready', 'on the way', 'reached') and not a real question - "
    "    return action='none'. Don't speak unnecessarily.\n"
    "  - If the message is a greeting / smalltalk ('assalamu alaikum', "
    "    'hi', 'kemne achen') - auto-answer briefly ('walaikum, valo "
    "    achi, ami medicine er opekkhay').\n"
    "  - Rider asking 'apnar location kothay?' / 'ekhane achen?' - auto-"
    "    answer with the address from CONTEXT.delivery_address (and add "
    "    'GPS share kortesi' if delivery_lat is present).\n"
    "  - Rider asking customer's phone - auto-answer with "
    "    CONTEXT.customer_phone if present.\n"
    "  - Pharmacy asking 'eta original?' / 'kon brand?' / 'qty kom korle "
    "    cholbe?' - ASK_CUSTOMER (decisions belong to the human).\n"
    "  - Pharmacy suggesting a different brand / alternative / substitute "
    "medicine - ASK_CUSTOMER. You may summarize the pharmacy's stated "
    "benefit, but never invent medical benefits or approve the change yourself.\n"
    "  - Pharmacy negotiating price, discount, budget, quantity, or dose - "
    "ASK_CUSTOMER unless the exact answer is already in CONTEXT.\n"
    "  - Pharmacy asking 'extra kichu lagbe?' / 'ar kichu nibe?' - "
    "    ASK_CUSTOMER. Don't volunteer add-ons.\n"
    "  - Pharmacy/rider asking about the customer's current symptoms or "
    "    health state (fever/জ্বর/jor, temperature, cough, pain, allergy, "
    "    etc.) - ASK_CUSTOMER unless that exact answer is explicitly in "
    "    CONTEXT. Never guess or answer these yourself.\n"
    "  - Never invent facts. Never quote prices, dosages, or brand names "
    "    that aren't in CONTEXT.\n"
    "\n"
    "Return STRICT JSON (no prose):\n"
    "{\n"
    "  \"action\": \"auto_answer\" | \"ask_customer\" | \"none\",\n"
    "  \"text\": \"<reply or question, max 200 chars>\",\n"
    "  \"reason\": \"<max 80 chars why>\"\n"
    "}\n"
)

_HEALTH_DETAIL_RE = re.compile(
    r"জ্বর|জর|\bjor\b|\bfever\b|temperature|তাপমাত্রা|কাশি|\bcough\b|ব্যথা|\bpain\b|allergy|অ্যালার্জি|সর্দি|ঠান্ডা",
    re.IGNORECASE,
)
_MEDICINE_CHANGE_RE = re.compile(
    r"বদলে|পরিবর্তন|চেঞ্জ|change|alternative|instead|substitute|replacement|ভালো|better|brand|generic|same group|same medicine|এর চেয়ে|এর থেকে|নিলে ভালো|নিতে পারবেন",
    re.IGNORECASE,
)
_PRICE_DECISION_RE = re.compile(
    r"দাম|price|৳|টাকা|discount|ছাড়|কম|বেশি|budget|দরদাম|rate|offer|total|cost|খরচ",
    re.IGNORECASE,
)
_QTY_DECISION_RE = re.compile(
    r"qty|quantity|পরিমাণ|কয়টা|কয়টা|কতটা|কমিয়ে|বাড়িয়ে|বাড়িয়ে|dose|ডোজ|মাত্রা",
    re.IGNORECASE,
)
_QUESTION_HINT_RE = re.compile(
    r"\?|কি|কী|\bki\b|আছে|\bache\b|কত|\bkoto\b|কতো|ডিগ্রি|degree|দিন|\bdin\b|বলবেন|বলুন|\bbolen\b|janan|জানান|চান|\bchan\b|লাগবে|\blagbe\b|হবে|\bhobe\b|পারবেন|কোথায়|কোথায়|location|address",
    re.IGNORECASE,
)
_CONTEXT_ANSWERABLE_RE = re.compile(
    r"location|লোকেশন|ঠিকানা|address|কোথায়|কোথায়|phone|ফোন|mobile|মোবাইল|number|নাম্বার",
    re.IGNORECASE,
)
_STATUS_OR_SMALLTALK_RE = re.compile(
    r"preparing|ready|on the way|reached|প্যাক|রেডি|পাঠাচ্ছি|আসছি|assalamu|salam|সালাম|hi|hello|ধন্যবাদ|thanks",
    re.IGNORECASE,
)


def _customer_question_meta(body: str, question_text: str | None = None, reason: str = "") -> Dict[str, str]:
    text = (body or "").strip()
    if _HEALTH_DETAIL_RE.search(text):
        return {
            "category": "health",
            "summary": question_text or "ফার্মেসি আপনার জ্বর/কাশি বা স্বাস্থ্য তথ্য জানতে চেয়েছে।",
            "explainer": (
                "এটা আপনার ব্যক্তিগত স্বাস্থ্য তথ্য। medi AI আন্দাজ করে উত্তর দেবে না, "
                "কারণ জ্বর/কাশি/ব্যথা কতদিন বা কতটা বেশি সেটা শুধু আপনিই জানেন।"
            ),
            "placeholder": "যেমন: জ্বর ৩ দিন ধরে, রাতে বেশি; কাশি আছে / নেই",
            "reason": reason or "health detail needs customer input",
        }
    if _MEDICINE_CHANGE_RE.search(text):
        return {
            "category": "medicine_change",
            "summary": question_text or "ফার্মেসি অন্য ওষুধ/ব্র্যান্ড suggest করেছে। আপনি নিতে চান?",
            "explainer": (
                "ওষুধ বা ব্র্যান্ড পরিবর্তন প্রেসক্রিপশনের সাথে সম্পর্কিত হতে পারে। medi AI নিজে অনুমতি দেবে না। "
                "ফার্মেসি যে কারণ বা উপকার বলেছে সেটা দেখে আপনি সিদ্ধান্ত দিন।"
            ),
            "placeholder": "যেমন: ডাক্তারের অনুমতি থাকলে নিতে পারি / না, প্রেসক্রিপশনের ওষুধটাই চাই",
            "reason": reason or "medicine change needs customer approval",
        }
    if _PRICE_DECISION_RE.search(text):
        return {
            "category": "price_decision",
            "summary": question_text or "ফার্মেসি দাম বা বিকল্প নিয়ে জানতে চেয়েছে। আপনার সিদ্ধান্ত কী?",
            "explainer": (
                "এটা আপনার বাজেট/পছন্দের বিষয়। medi AI দাম বা মোট খরচ নিয়ে ফার্মেসিকে আপনার কথা জানিয়ে দেবে, "
                "কিন্তু আপনার অনুমতি ছাড়া অর্ডার বদলাবে না।"
            ),
            "placeholder": "যেমন: মোট খরচ কমানো যাবে? / এই দাম ঠিক আছে / কম দামের বিকল্প দিন",
            "reason": reason or "price decision needs customer input",
        }
    if _QTY_DECISION_RE.search(text):
        return {
            "category": "quantity",
            "summary": question_text or "ফার্মেসি পরিমাণ বা ডোজ নিয়ে জানতে চেয়েছে। আপনার উত্তর কী?",
            "explainer": (
                "পরিমাণ বা ডোজ প্রেসক্রিপশনের সাথে সম্পর্কিত হতে পারে। আপনি প্রেসক্রিপশন বা ডাক্তারের পরামর্শ অনুযায়ী উত্তর দিন।"
            ),
            "placeholder": "যেমন: প্রেসক্রিপশন অনুযায়ী ১০টা দিন / পরিমাণ কমাব না",
            "reason": reason or "quantity decision needs customer input",
        }
    return {
        "category": "general",
        "summary": question_text or "ফার্মেসি একটি তথ্য জানতে চেয়েছে। আপনার উত্তর কী?",
        "explainer": "এই তথ্য medi AI নিশ্চিতভাবে জানে না। আপনি উত্তর দিলে medi AI সেটি আপনার বার্তা হিসেবে ফার্মেসিকে পাঠাবে।",
        "placeholder": "আপনার উত্তর লিখুন",
        "reason": reason or "customer input required",
    }


def _forced_customer_question(body: str) -> Dict[str, str] | None:
    text = (body or "").strip()
    if not text:
        return None
    if _STATUS_OR_SMALLTALK_RE.search(text):
        return None
    # Let the LLM/context path answer objective facts we already store, such
    # as delivery location or phone. Everything else question-like needs the
    # human customer, especially follow-up medical/symptom details.
    if _CONTEXT_ANSWERABLE_RE.search(text):
        return None
    if _HEALTH_DETAIL_RE.search(text) and _QUESTION_HINT_RE.search(text):
        return _customer_question_meta(text)
    if _MEDICINE_CHANGE_RE.search(text):
        return _customer_question_meta(text)
    if _PRICE_DECISION_RE.search(text) and _QUESTION_HINT_RE.search(text):
        return _customer_question_meta(text)
    if _QTY_DECISION_RE.search(text) and _QUESTION_HINT_RE.search(text):
        return _customer_question_meta(text)
    if _QUESTION_HINT_RE.search(text):
        return _customer_question_meta(text)
    return None


def _build_customer_question_card(
    conv: Conversation,
    incoming_msg: ConversationMessage,
    asker_role: str,
    incoming_body: str,
    question_text: str,
    reason: str,
    question_meta: Optional[Dict[str, str]] = None,
    context_started_at: Optional[datetime] = None,
) -> ConversationMessage:
    asker_label = "রাইডার" if asker_role == "rider" else "ফার্মেসি"
    meta = question_meta or _customer_question_meta(incoming_body, question_text, reason)
    summary = (meta.get("summary") or question_text or "আপনার উত্তর কী?")[:300]
    explainer = (meta.get("explainer") or "এই তথ্য medi AI নিশ্চিতভাবে জানে না।")[:500]
    placeholder = (meta.get("placeholder") or "আপনার উত্তর লিখুন")[:180]
    category = (meta.get("category") or "general")[:40]
    return ConversationMessage(
        conversation_id=conv.id,
        sender_role=SenderRole.system,
        body=(
            f"medi AI: {asker_label} আপনার কাছে জানতে চেয়েছে:\n"
            f"\"{incoming_body[:240]}\"\n\n"
            f"{explainer}\n\n"
            "আপনি উত্তর দিলে medi AI সেটি আপনার বার্তা হিসেবে পাঠিয়ে দেবে।"
        ),
        preset_key="ai_question_for_customer",
        payload_json=json.dumps({
            "ai_proxy": True,
            "source_message_id": str(incoming_msg.id),
            "asker_role": asker_role,
            "ai_summary": summary,
            "question_category": category,
            "customer_explainer": explainer,
            "reply_placeholder": placeholder,
            "smart_context_started_at": context_started_at.isoformat() if context_started_at else None,
            "pharmacy_question": incoming_body[:500] if asker_role == "pharmacy" else None,
            "rider_question": incoming_body[:500] if asker_role == "rider" else None,
            "reason": (meta.get("reason") or reason)[:120],
        }, ensure_ascii=False),
        visibility="customer_only",
    )


def _format_items(items: Any) -> str:
    if not isinstance(items, list):
        return "(none)"
    out: List[str] = []
    for it in items[:8]:
        if not isinstance(it, dict):
            continue
        nm = (it.get("name") or "").strip()
        if not nm:
            continue
        qty = it.get("qty") or it.get("quantity") or 1
        line = f"{nm} x{qty}"
        out.append(line)
    return ", ".join(out) if out else "(none)"


async def _notify_customer_question(
    conv: Conversation,
    card: ConversationMessage,
    asker_role: str,
    question_text: str,
    db: AsyncSession,
) -> None:
    try:
        await db.flush()
        title = "Rider-এর প্রশ্ন" if asker_role == "rider" else "Pharmacy-এর প্রশ্ন"
        await user_notify(
            db,
            conv.customer_account_id,
            kind="ai_alert",
            title=title,
            body_bn=(question_text or "আপনার উত্তর দরকার।")[:180],
            payload={
                "conversation_id": str(conv.id),
                "question_id": str(card.id),
                "kind": "ai_question_for_customer",
                "asker_role": asker_role,
            },
        )
    except Exception as exc:  # pragma: no cover - best-effort notification
        print(f"[ai_proxy] question notify failed: {type(exc).__name__}: {exc}")


async def _build_context(
    conv: Conversation,
    db: AsyncSession,
) -> Dict[str, Any]:
    """Collect facts AI is allowed to speak from."""
    cust = (await db.execute(
        select(CustomerProfile).where(
            CustomerProfile.account_id == conv.customer_account_id
        )
    )).scalar_one_or_none()
    pharm = (await db.execute(
        select(PharmacyProfile).where(PharmacyProfile.id == conv.pharmacy_id)
    )).scalar_one_or_none()
    order = (await db.execute(
        select(Order)
        .where(Order.conversation_id == conv.id)
        .order_by(Order.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()

    rider = None
    if conv.rider_id:
        rider = (await db.execute(
            select(RiderProfile).where(RiderProfile.id == conv.rider_id)
        )).scalar_one_or_none()

    items: List[Dict[str, Any]] = []
    if order and order.items_json:
        try:
            items = json.loads(order.items_json) or []
        except Exception:
            items = []
    if not items:
        # Fall back to latest order_request payload in chat.
        rq = (await db.execute(
            select(ConversationMessage)
            .where(
                ConversationMessage.conversation_id == conv.id,
                ConversationMessage.preset_key == "order_request",
            )
            .order_by(ConversationMessage.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()
        if rq and rq.payload_json:
            try:
                items = (json.loads(rq.payload_json) or {}).get("items") or []
            except Exception:
                items = []

    delivery_address = None
    delivery_lat = None
    delivery_lng = None
    if order:
        delivery_address = order.delivery_address
        delivery_lat = order.delivery_lat
        delivery_lng = order.delivery_lng

    cust_name = ""
    cust_phone = None
    if cust:
        cust_name = (
            f"{cust.first_name or ''} {cust.last_name or ''}".strip()
            or (conv.customer_name or "")
        )
        cust_phone = cust.phone_number
    return {
        "customer_name": cust_name or (conv.customer_name or "Customer"),
        "customer_phone": cust_phone,
        "pharmacy_name": pharm.pharmacy_name if pharm else "Pharmacy",
        "rider_name": (rider.nick_name or rider.full_name) if rider else None,
        "order_status": order.status.value if order else None,
        "order_total": float(order.total) if order and order.total else None,
        "delivery_address": delivery_address,
        "delivery_lat": delivery_lat,
        "delivery_lng": delivery_lng,
        "items": items,
    }


async def _recent_chat_lines(
    conv: Conversation,
    db: AsyncSession,
    limit: int = 8,
) -> List[str]:
    rows = (await db.execute(
        select(ConversationMessage)
        .where(ConversationMessage.conversation_id == conv.id)
        .order_by(ConversationMessage.created_at.desc())
        .limit(limit)
    )).scalars().all()
    out: List[str] = []
    for m in reversed(rows):
        body = (m.body or "").strip()
        if not body:
            continue
        role = m.sender_role.value if hasattr(m.sender_role, "value") else str(m.sender_role)
        out.append(f"{role}: {body[:200]}")
    return out


def _message_payload(message: ConversationMessage) -> Dict[str, Any]:
    if not message.payload_json:
        return {}
    try:
        parsed = json.loads(message.payload_json)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _is_active_ai_handshake_payload(payload: Dict[str, Any]) -> bool:
    status = str(payload.get("status") or "").lower()
    return status in ("awaiting_pharmacy", "pharmacy_ok", "awaiting_customer")


async def active_smart_prescription_context_since(
    conv: Conversation,
    db: AsyncSession,
) -> Optional[datetime]:
    """Return when the current active Smart Prescription context started.

    Normal/manual orders intentionally return None. Those chats only get AI
    help when a participant explicitly mentions `@mediai`, handled elsewhere.
    """
    latest_request = (await db.execute(
        select(ConversationMessage)
        .where(
            ConversationMessage.conversation_id == conv.id,
            ConversationMessage.preset_key == "order_request",
        )
        .order_by(ConversationMessage.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    latest_request_at = latest_request.created_at if latest_request else None

    handshake_rows = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.conversation_id == conv.id,
            ConversationMessage.preset_key.in_((
                "ai_handshake", "ai_customer_confirm_prompt",
            )),
        )
    )).scalars().all()

    terminal_ids: set[str] = set()
    terminal_rows = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.conversation_id == conv.id,
            ConversationMessage.preset_key.in_((
                "ai_handshake_completed",
                "ai_handshake_rejected",
                "ai_handshake_cancelled",
            )),
        )
    )).scalars().all()
    for row in terminal_rows:
        payload = _message_payload(row)
        handshake_id = payload.get("handshake_id")
        if handshake_id:
            terminal_ids.add(str(handshake_id))
        for handshake_id in payload.get("handshake_ids") or []:
            if handshake_id:
                terminal_ids.add(str(handshake_id))

    latest_active_handshake_at = None
    for row in handshake_rows:
        row_payload = _message_payload(row)
        handshake_id = str(row_payload.get("handshake_id") or "")
        if handshake_id and handshake_id in terminal_ids:
            continue
        if _is_active_ai_handshake_payload(row_payload):
            row_time = row.created_at
            if row_time is not None and (
                latest_active_handshake_at is None or row_time > latest_active_handshake_at
            ):
                latest_active_handshake_at = row_time

    if latest_active_handshake_at is not None and (
        latest_request_at is None or latest_active_handshake_at >= latest_request_at
    ):
        return latest_active_handshake_at

    if latest_request is None:
        return None
    request_payload = _message_payload(latest_request)
    if request_payload.get("source") != "ai_prescription":
        return None

    order = (await db.execute(
        select(Order)
        .where(Order.conversation_id == conv.id)
        .order_by(Order.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if order is None:
        return latest_request_at
    if order.status in (
        OrderStatus.delivered,
        OrderStatus.rejected,
        OrderStatus.cancelled,
    ):
        return None
    return latest_request_at


async def has_active_smart_prescription_context(
    conv: Conversation,
    db: AsyncSession,
) -> bool:
    """AI proxy only fires inside an active Smart Prescription context."""
    return await active_smart_prescription_context_since(conv, db) is not None


async def maybe_proxy_reply(
    conv: Conversation,
    incoming_msg: ConversationMessage,
    db: AsyncSession,
) -> Optional[ConversationMessage]:
    """Inspect a freshly-written pharmacy/rider message and (when
    appropriate) post AI's response in the same conversation.

    Caller is responsible for committing the session - this function
    only `db.add(...)`s.

    Returns the new message (if any) so the caller can decide what to
    do with it (e.g. log).
    """
    # Skip when:
    #   - sender is system / customer themselves
    #   - the message itself is a structured preset (workflow signal)
    #   - there's no body (pure attachment - leave alone)
    if incoming_msg.sender_role not in (SenderRole.pharmacy, SenderRole.rider):
        return None
    if incoming_msg.preset_key:
        return None
    body = (incoming_msg.body or "").strip()
    if len(body) < 2:
        return None
    # Only fire inside Smart Prescription. Manual orders stay silent unless
    # a participant explicitly mentions @mediai (handled in conversations.py).
    active_context_since = await active_smart_prescription_context_since(conv, db)
    if active_context_since is None:
        return None

    asker_role = "pharmacy" if incoming_msg.sender_role == SenderRole.pharmacy else "rider"
    forced_question = _forced_customer_question(body)
    if forced_question:
        card = _build_customer_question_card(
            conv,
            incoming_msg,
            asker_role,
            body,
            forced_question["summary"],
            forced_question["reason"],
            forced_question,
            active_context_since,
        )
        db.add(card)
        await _notify_customer_question(conv, card, asker_role, forced_question["summary"], db)
        return card

    # Lazy import - avoids circular import (ai.py imports models too).
    from app.api.routes.ai import _gemini_json  # type: ignore

    ctx = await _build_context(conv, db)
    chat_lines = await _recent_chat_lines(conv, db, limit=8)

    user_prompt = (
        "CONTEXT (facts you may quote - do not invent anything else):\n"
        f"  customer_name: {ctx['customer_name']}\n"
        f"  customer_phone: {ctx.get('customer_phone') or '(unknown)'}\n"
        f"  pharmacy_name: {ctx['pharmacy_name']}\n"
        f"  rider_name: {ctx.get('rider_name') or '(none yet)'}\n"
        f"  order_status: {ctx.get('order_status') or '(no order yet)'}\n"
        f"  order_items: {_format_items(ctx['items'])}\n"
        f"  delivery_address: {ctx.get('delivery_address') or '(not shared)'}\n"
        f"  delivery_lat: {ctx.get('delivery_lat')}\n"
        f"  delivery_lng: {ctx.get('delivery_lng')}\n"
        "\nRecent chat (oldest first):\n  " + "\n  ".join(chat_lines)
        + f"\n\nLatest {asker_role} message to handle:\n  \"{body[:500]}\""
        "\n\nDecide and return JSON."
    )

    verdict = await _gemini_json(PROXY_SYSTEM, user_prompt, temperature=0.2)
    if not verdict:
        return None
    action = str(verdict.get("action") or "").strip().lower()
    text = (verdict.get("text") or "").strip()
    if not text or action not in ("auto_answer", "ask_customer"):
        return None
    text = text[:300]
    reason = (verdict.get("reason") or "")[:120]

    if action == "auto_answer":
        # Speak as the customer - looks like they typed it.
        # `ai_proxy=true` is recorded in payload_json for audit only.
        reply_visibility = "customer_rider" if asker_role == "rider" else "customer_pharmacy"
        reply = ConversationMessage(
            conversation_id=conv.id,
            sender_role=SenderRole.customer,
            body=text,
            preset_key="ai_proxy_reply",
            payload_json=json.dumps({
                "ai_proxy": True,
                "source_message_id": str(incoming_msg.id),
                "asker_role": asker_role,
                "reason": reason,
            }, ensure_ascii=False),
            visibility=reply_visibility,
        )
        db.add(reply)
        return reply

    # action == "ask_customer" -> private card visible to customer only.
    # Pharmacy / rider see nothing; we wait for the customer to reply via
    # `/conversations/{id}/ai-proxy-answer` which then posts the answer
    # back to pharmacy / rider as a normal customer message.
    card = _build_customer_question_card(
        conv,
        incoming_msg,
        asker_role,
        body,
        text,
        reason,
        _customer_question_meta(body, text, reason),
        active_context_since,
    )
    db.add(card)
    await _notify_customer_question(conv, card, asker_role, text, db)
    return card


async def relay_customer_answer_to_other_side(
    conv: Conversation,
    parent_question_id: UUID,
    answer_text: str,
    db: AsyncSession,
) -> ConversationMessage:
    """Take a customer's answer to an `ai_question_for_customer` card and
    post it as a regular customer message scoped to the original asker so the
    pharmacy / rider sees a natural reply. Marks the parent card as 'answered' so
    the UI can stop showing the input.
    """
    parent = (await db.execute(
        select(ConversationMessage).where(ConversationMessage.id == parent_question_id)
    )).scalar_one_or_none()

    asker_role = "pharmacy"
    parent_payload: Dict[str, Any] = {}
    if parent and parent.payload_json:
        try:
            parent_payload = json.loads(parent.payload_json) or {}
        except Exception:
            parent_payload = {}
        asker_role = (parent_payload.get("asker_role") or "pharmacy").lower()
        parent_payload["status"] = "answered"
        parent.payload_json = json.dumps(parent_payload, ensure_ascii=False)
        db.add(parent)

    reply = ConversationMessage(
        conversation_id=conv.id,
        sender_role=SenderRole.customer,
        body=answer_text.strip()[:1200],
        preset_key="ai_proxy_reply",
        payload_json=json.dumps({
            "ai_proxy": True,
            "via_customer": True,
            "parent_question_id": str(parent_question_id),
            "asker_role": asker_role,
        }, ensure_ascii=False),
        visibility="customer_rider" if asker_role == "rider" else "customer_pharmacy",
    )
    db.add(reply)
    return reply
