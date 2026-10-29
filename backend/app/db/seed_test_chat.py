"""
seed_test_chat.py — local-dev helper (idempotent).

Creates/refreshes ONE realistic customer↔pharmacy conversation between the
Test Pharmacy and the customer `test.customer@medidoor.app`, populated with
a mix of plain messages + workflow event cards (order_request / quote / confirm
/ preparing). Lets us preview the Messenger-style chat redesign against a
lifelike thread without needing two live logins.

Run from the backend folder:  python -m app.db.seed_test_chat
Only touches that single conversation's rows.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from app.db.base import AsyncSessionLocal
from app.models.user import Account, PharmacyProfile
from app.models.conversation import Conversation, ConversationMessage
from app.models.order import SenderRole

CUSTOMER_GMAIL = "test.customer@medidoor.app"
PHARMACY_NAME = "Test Pharmacy"


async def main() -> None:
    async with AsyncSessionLocal() as db:
        cust = (await db.execute(
            select(Account).where(Account.gmail == CUSTOMER_GMAIL)
        )).scalar_one_or_none()
        if not cust:
            raise SystemExit(f"Customer account {CUSTOMER_GMAIL} not found.")
        pharm = (await db.execute(
            select(PharmacyProfile).where(PharmacyProfile.pharmacy_name == PHARMACY_NAME)
        )).scalar_one_or_none()
        if not pharm:
            raise SystemExit(f"{PHARMACY_NAME} not found.")

        conv = (await db.execute(
            select(Conversation).where(
                Conversation.pharmacy_id == pharm.id,
                Conversation.customer_account_id == cust.id,
            )
        )).scalar_one_or_none()
        if conv is None:
            conv = Conversation(
                pharmacy_id=pharm.id,
                customer_account_id=cust.id,
                customer_name="Test Customer",
            )
            db.add(conv)
            await db.flush()
        else:
            # Refresh: clear existing messages so re-runs stay clean.
            await db.execute(
                delete(ConversationMessage).where(
                    ConversationMessage.conversation_id == conv.id
                )
            )

        base = datetime.now(timezone.utc) - timedelta(minutes=40)
        C, P, S = SenderRole.customer, SenderRole.pharmacy, SenderRole.system

        order_items = {
            "items": [
                {"medicine_id": None, "name": "Napa 500mg", "qty": 2,
                 "unit_price": 1.2, "image_url": "/uploads/test_napa.svg"},
                {"medicine_id": None, "name": "Seclo 20mg", "qty": 1,
                 "unit_price": 5.0, "image_url": "/uploads/test_seclo.svg"},
            ],
            "subtotal": 7.4, "delivery_fee": 20, "total": 27.4,
            "note": "একটু তাড়াতাড়ি দিলে ভালো হয়।",
        }

        seq: list[tuple[SenderRole, str, str | None, dict | None, int]] = [
            (C, "আসসালামু আলাইকুম, Napa 500mg আর Seclo 20mg কি স্টকে আছে?", None, None, 0),
            (P, "ওয়ালাইকুম সালাম! জি ভাই, দুইটাই স্টকে আছে। কয় পাতা লাগবে?", None, None, 1),
            (C, "Napa ২ পাতা আর Seclo ১ পাতা। ডেলিভারি চার্জ কত?", None, None, 2),
            (P, "আপনার এরিয়ায় ২০ টাকা। অর্ডার request পাঠান, quote দিয়ে দিচ্ছি।", None, None, 3),
            (C, "📦 *অর্ডার request* — মোট ৳27", "order_request", order_items, 5),
            (P, "🧾 *Pharmacy quote* — মোট ৳27", "pharmacy_quote", order_items, 7),
            (C, "✅ *Quote accept করেছি* — মোট ৳27", "order_confirm", order_items, 9),
            (P, "🟢 অর্ডার প্যাকিং চলছে — একটু অপেক্ষা করুন।", "order_status_preparing", None, 11),
            (P, "রাইডার ঠিক করছি, কয়েক মিনিটের মধ্যে রওনা দেবে ভাই।", None, None, 13),
        ]

        for role, body, preset, payload, mins in seq:
            db.add(ConversationMessage(
                conversation_id=conv.id,
                sender_role=role,
                body=body,
                preset_key=preset,
                payload_json=json.dumps(payload) if payload else None,
                visibility="all",
                created_at=base + timedelta(minutes=mins),
            ))

        conv.last_message_at = base + timedelta(minutes=13)
        # Pharmacy has read up to just before the last customer confirm so the
        # "seen" tick shows on the customer's confirm message.
        conv.pharmacy_last_read_at = base + timedelta(minutes=12)
        conv.customer_last_read_at = base + timedelta(minutes=13)
        await db.commit()

        print(f"[OK] Seeded conversation {conv.id} with {len(seq)} messages.")
        print(f"     Customer: {CUSTOMER_GMAIL}  <->  {PHARMACY_NAME}")


if __name__ == "__main__":
    asyncio.run(main())
