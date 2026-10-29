"""
Admin moderation endpoints — list flagged conversations + unblock.

Access control: caller's gmail must be in `settings.admin_gmails_list`.
In DEBUG mode the constant `admin@medidoor.app` is always allowed so
local devs and the desktop `admin.py` Tkinter tool can sign in via
`POST /api/auth/dev-login` and use these endpoints.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Dict, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_account, get_db
from app.core.config import settings
from app.models import (
    Account,
    Conversation,
    ConversationMessage,
    CustomerProfile,
    Medicine,
    PharmacyProfile,
)


router = APIRouter(prefix="/api/admin/moderation", tags=["admin-moderation"])


def _is_admin(account: Account) -> bool:
    gmail = (account.gmail or "").lower()
    if not gmail:
        return False
    if gmail in settings.admin_gmails_list:
        return True
    if settings.dev_endpoints_enabled and gmail == "admin@medidoor.app":
        return True
    return False


async def get_admin_account(
    account: Account = Depends(get_current_account),
) -> Account:
    if not _is_admin(account):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    return account


class UnblockIn(BaseModel):
    note: str | None = None


def _conv_summary(
    c: Conversation,
    pharmacy: PharmacyProfile | None,
    customer: CustomerProfile | None,
    last_flagged: ConversationMessage | None,
) -> Dict[str, Any]:
    return {
        "id": str(c.id),
        "pharmacy_id": str(c.pharmacy_id),
        "pharmacy_name": pharmacy.pharmacy_name if pharmacy else "Pharmacy",
        "customer_account_id": str(c.customer_account_id),
        "customer_name": c.customer_name,
        "customer_avatar": customer.profile_photo_url if customer else None,
        "blocked_at": c.blocked_at.isoformat() if c.blocked_at else None,
        "block_reason": c.block_reason,
        "block_category": c.block_category,
        "flag_count": int(c.flag_count or 0),
        "last_message_at": c.last_message_at.isoformat() if c.last_message_at else None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "last_flagged_message": (
            {
                "id": str(last_flagged.id),
                "body": last_flagged.body,
                "sender_role": (
                    last_flagged.sender_role.value
                    if hasattr(last_flagged.sender_role, "value")
                    else str(last_flagged.sender_role)
                ),
                "moderation_risk": last_flagged.moderation_risk,
                "moderation_category": last_flagged.moderation_category,
                "moderation_reason": last_flagged.moderation_reason,
                "was_blocked": bool(last_flagged.was_blocked),
                "created_at": (
                    last_flagged.created_at.isoformat()
                    if last_flagged.created_at
                    else None
                ),
            }
            if last_flagged
            else None
        ),
    }


@router.get("/conversations")
async def list_flagged_conversations(
    only_blocked: bool = False,
    limit: int = 100,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """List conversations that need attention.

    By default returns any conversation whose `flag_count > 0` OR is blocked.
    Pass `only_blocked=true` to filter to currently locked conversations.
    """
    stmt = select(Conversation)
    if only_blocked:
        stmt = stmt.where(Conversation.blocked_at.is_not(None))
    else:
        stmt = stmt.where(
            (Conversation.flag_count > 0) | (Conversation.blocked_at.is_not(None))
        )
    stmt = stmt.order_by(
        desc(Conversation.blocked_at),
        desc(Conversation.last_message_at),
    ).limit(max(1, min(limit, 500)))

    rows = (await db.execute(stmt)).scalars().all()
    if not rows:
        return []

    pharm_ids = {c.pharmacy_id for c in rows}
    cust_ids = {c.customer_account_id for c in rows}
    pharms: Dict[UUID, PharmacyProfile] = {
        p.id: p for p in (
            await db.execute(
                select(PharmacyProfile).where(PharmacyProfile.id.in_(pharm_ids))
            )
        ).scalars().all()
    }
    custs: Dict[UUID, CustomerProfile] = {
        c.account_id: c for c in (
            await db.execute(
                select(CustomerProfile).where(CustomerProfile.account_id.in_(cust_ids))
            )
        ).scalars().all()
    }

    # last flagged message per conversation
    last_per: Dict[UUID, ConversationMessage] = {}
    flagged = (
        await db.execute(
            select(ConversationMessage)
            .where(
                ConversationMessage.conversation_id.in_([c.id for c in rows]),
                ConversationMessage.moderation_risk.in_(("low", "medium", "high")),
            )
            .order_by(ConversationMessage.created_at.desc())
        )
    ).scalars().all()
    for m in flagged:
        if m.conversation_id not in last_per:
            last_per[m.conversation_id] = m

    return [
        _conv_summary(
            c,
            pharms.get(c.pharmacy_id),
            custs.get(c.customer_account_id),
            last_per.get(c.id),
        )
        for c in rows
    ]


@router.get("/conversations/{conversation_id}/messages")
async def list_conversation_messages(
    conversation_id: UUID,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """Full message history for a flagged conversation (admin sees ALL
    messages, ignoring `visibility` filters)."""
    rows = (
        await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.conversation_id == conversation_id)
            .order_by(ConversationMessage.created_at)
        )
    ).scalars().all()
    out: List[Dict[str, Any]] = []
    for m in rows:
        payload = None
        if m.payload_json:
            try:
                payload = json.loads(m.payload_json)
            except Exception:
                payload = None
        out.append({
            "id": str(m.id),
            "sender_role": (
                m.sender_role.value if hasattr(m.sender_role, "value") else str(m.sender_role)
            ),
            "body": m.body or "",
            "attachment_url": m.attachment_url,
            "preset_key": m.preset_key,
            "payload": payload,
            "visibility": getattr(m, "visibility", "all") or "all",
            "moderation_risk": m.moderation_risk,
            "moderation_category": m.moderation_category,
            "moderation_reason": m.moderation_reason,
            "was_blocked": bool(m.was_blocked),
            "reviewed_at": m.reviewed_at.isoformat() if m.reviewed_at else None,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        })
    return out


@router.post("/conversations/{conversation_id}/unblock")
async def unblock_conversation(
    conversation_id: UUID,
    payload: UnblockIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Lift the AI-imposed lock on a conversation. Posts a system message
    so all participants know it was admin-cleared."""
    from app.models import SenderRole  # local import to avoid cycle

    conv = (
        await db.execute(select(Conversation).where(Conversation.id == conversation_id))
    ).scalar_one_or_none()
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if conv.blocked_at is None:
        return {"ok": True, "already_unblocked": True}

    conv.blocked_at = None
    conv.block_reason = None
    conv.block_category = None
    note = (payload.note or "").strip()
    body = "✅ Admin reviewed — conversation unlocked. দয়া করে platform-policy মেনে কথা বলুন।"
    if note:
        body += f"\n\nAdmin note: {note}"
    db.add(ConversationMessage(
        conversation_id=conv.id,
        sender_role=SenderRole.system,
        body=body,
        preset_key="ai_unblock",
        payload_json=json.dumps({"by": admin.gmail}),
        visibility="all",
    ))
    conv.last_message_at = datetime.utcnow()
    await db.commit()
    return {"ok": True}


@router.post("/messages/{message_id}/dismiss")
async def dismiss_flag(
    message_id: UUID,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Mark a flagged message as reviewed by admin (does not change risk)."""
    m = (
        await db.execute(select(ConversationMessage).where(ConversationMessage.id == message_id))
    ).scalar_one_or_none()
    if not m:
        raise HTTPException(404, "Message not found")
    m.reviewed_at = datetime.utcnow()
    await db.commit()
    return {"ok": True}


@router.get("/stats")
async def stats(
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Quick counts for the admin dashboard."""
    blocked = (
        await db.execute(
            select(func.count()).select_from(Conversation).where(
                Conversation.blocked_at.is_not(None)
            )
        )
    ).scalar_one()
    flagged = (
        await db.execute(
            select(func.count()).select_from(Conversation).where(
                Conversation.flag_count > 0
            )
        )
    ).scalar_one()
    by_risk = {}
    for risk in ("low", "medium", "high"):
        n = (
            await db.execute(
                select(func.count()).select_from(ConversationMessage).where(
                    ConversationMessage.moderation_risk == risk
                )
            )
        ).scalar_one()
        by_risk[risk] = int(n or 0)
    prod_pending = (
        await db.execute(
            select(func.count()).select_from(Medicine).where(
                Medicine.approval_status == "pending"
            )
        )
    ).scalar_one()
    prod_rejected = (
        await db.execute(
            select(func.count()).select_from(Medicine).where(
                Medicine.approval_status == "rejected"
            )
        )
    ).scalar_one()
    return {
        "blocked_conversations": int(blocked or 0),
        "flagged_conversations": int(flagged or 0),
        "messages_by_risk": by_risk,
        "products_pending": int(prod_pending or 0),
        "products_rejected": int(prod_rejected or 0),
    }


# =====================================================================
# Product moderation — admin reviews AI-flagged pharmacy listings.
# =====================================================================


class ProductReviewIn(BaseModel):
    note: str | None = None


def _serialize_product_for_admin(
    m: Medicine, pharm: PharmacyProfile | None
) -> Dict[str, Any]:
    return {
        "id": str(m.id),
        "name": m.name,
        "short_description": m.short_description,
        "description": m.description,
        "category": m.category,
        "image_url": m.image_url,
        "price": m.price,
        "stock": m.stock,
        "is_active": m.is_active,
        "prescription_required": bool(getattr(m, "prescription_required", False)),
        "approval_status": getattr(m, "approval_status", "approved") or "approved",
        "approval_category": getattr(m, "approval_category", None),
        "approval_reason": getattr(m, "approval_reason", None),
        "approval_reviewed_at": (
            m.approval_reviewed_at.isoformat()
            if getattr(m, "approval_reviewed_at", None) else None
        ),
        "approval_reviewed_by_admin": bool(
            getattr(m, "approval_reviewed_by_admin", False)
        ),
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "pharmacy": (
            {
                "id": str(pharm.id),
                "name": pharm.pharmacy_name,
                "owner_name": pharm.owner_name,
                "phone_number": pharm.phone_number,
            }
            if pharm
            else None
        ),
    }


@router.get("/products")
async def list_moderated_products(
    status_filter: str | None = None,
    limit: int = 200,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """List products for admin review.

    `status_filter` ∈ {"pending", "rejected", "approved", "all"} — defaults
    to showing pending + rejected (the queue admin actually needs).
    """
    stmt = select(Medicine)
    sf = (status_filter or "").strip().lower()
    if sf == "all":
        pass
    elif sf in ("pending", "rejected", "approved"):
        stmt = stmt.where(Medicine.approval_status == sf)
    else:
        stmt = stmt.where(Medicine.approval_status.in_(("pending", "rejected")))
    stmt = stmt.order_by(desc(Medicine.created_at)).limit(max(1, min(limit, 1000)))
    rows = (await db.execute(stmt)).scalars().all()
    if not rows:
        return []

    pharm_ids = {m.pharmacy_id for m in rows}
    pharms: Dict[UUID, PharmacyProfile] = {
        p.id: p for p in (
            await db.execute(
                select(PharmacyProfile).where(PharmacyProfile.id.in_(pharm_ids))
            )
        ).scalars().all()
    }
    return [_serialize_product_for_admin(m, pharms.get(m.pharmacy_id)) for m in rows]


@router.post("/products/{product_id}/approve")
async def admin_approve_product(
    product_id: UUID,
    payload: ProductReviewIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    m = (
        await db.execute(select(Medicine).where(Medicine.id == product_id))
    ).scalar_one_or_none()
    if not m:
        raise HTTPException(404, "Product not found")
    m.approval_status = "approved"
    m.approval_reviewed_at = datetime.utcnow()
    m.approval_reviewed_by_admin = True
    note = (payload.note or "").strip()
    if note:
        m.approval_reason = f"Admin override ({admin.gmail}): {note}"
    elif not m.approval_reason:
        m.approval_reason = f"Admin approved by {admin.gmail}"
    await db.commit()
    return {"ok": True, "id": str(m.id), "approval_status": "approved"}


@router.post("/products/{product_id}/reject")
async def admin_reject_product(
    product_id: UUID,
    payload: ProductReviewIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    m = (
        await db.execute(select(Medicine).where(Medicine.id == product_id))
    ).scalar_one_or_none()
    if not m:
        raise HTTPException(404, "Product not found")
    m.approval_status = "rejected"
    m.approval_reviewed_at = datetime.utcnow()
    m.approval_reviewed_by_admin = True
    note = (payload.note or "").strip()
    m.approval_reason = (
        f"Admin rejected ({admin.gmail}): {note}"
        if note else f"Admin rejected by {admin.gmail}"
    )
    await db.commit()
    return {"ok": True, "id": str(m.id), "approval_status": "rejected"}
