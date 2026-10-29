"""
Admin user-management endpoints — used by the Tkinter `admin.py` Users tab.

Provides:
  • `GET  /api/admin/users/customers`      list all customers
  • `GET  /api/admin/users/pharmacies`     list all pharmacies
  • `GET  /api/admin/users/riders`         list riders (filter by verification_status)
  • `POST /api/admin/users/riders/{account_id}/verify`  mark verified
  • `POST /api/admin/users/riders/{account_id}/reject`  mark rejected (note required)

Auth: same gating as moderation (`get_admin_account`). Admin gmail must be in
`settings.admin_gmails_list`, or `admin@medidoor.app` in DEBUG.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.config import settings
from app.api.routes.moderation import get_admin_account
from app.models import (
    Account,
    CustomerProfile,
    PharmacyProfile,
    RiderProfile,
    UserNotification,
)
from app.models.user import RoleEnum
from app.models.rider_admin_message import RiderAdminMessage
from app.models.customer_admin_message import CustomerAdminMessage
from app.models.pharmacy_admin_message import PharmacyAdminMessage

router = APIRouter(prefix="/api/admin/users", tags=["admin-users"])


@router.get("/health", include_in_schema=False)
async def admin_users_health(db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    """Quick schema + connectivity check for the admin tool."""
    checks: Dict[str, Any] = {}
    try:
        await db.execute(select(Account).limit(1))
        checks["accounts"] = "ok"
    except Exception as exc:
        checks["accounts"] = f"FAIL: {exc}"
    try:
        await db.execute(select(CustomerProfile).limit(1))
        checks["customer_profiles"] = "ok"
    except Exception as exc:
        checks["customer_profiles"] = f"FAIL: {exc}"
    try:
        await db.execute(select(PharmacyProfile).limit(1))
        checks["pharmacy_profiles"] = "ok"
    except Exception as exc:
        checks["pharmacy_profiles"] = f"FAIL: {exc}"
    try:
        await db.execute(select(RiderProfile).limit(1))
        checks["rider_profiles"] = "ok"
    except Exception as exc:
        checks["rider_profiles"] = f"FAIL: {exc}"
    all_ok = all(v == "ok" for v in checks.values())
    return {"status": "ok" if all_ok else "degraded", "checks": checks}


# ---------- helpers ----------

def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _account_summary(a: Account) -> Dict[str, Any]:
    return {
        "account_id": str(a.id),
        "gmail": a.gmail,
        "is_active": bool(a.is_active),
        "is_registered": bool(a.is_registered),
        "created_at": _iso(a.created_at),
    }


def _serialize_customer_admin_msg(m: CustomerAdminMessage) -> Dict[str, Any]:
    return {
        "id": str(m.id),
        "direction": m.direction,
        "body": m.body,
        "attachment_url": m.attachment_url,
        "attachment_mime": m.attachment_mime,
        "is_read": bool(m.is_read),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _serialize_pharmacy_admin_msg(m: PharmacyAdminMessage) -> Dict[str, Any]:
    return {
        "id": str(m.id),
        "direction": m.direction,
        "body": m.body,
        "attachment_url": m.attachment_url,
        "attachment_mime": m.attachment_mime,
        "is_read": bool(m.is_read),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


# ---------- customers ----------

@router.get("/customers")
async def list_customers(
    limit: int = 500,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    # LEFT JOIN so accounts that signed in but never completed registration
    # (no customer_profiles row) still appear — admin.py showed every account.
    stmt = (
        select(Account, CustomerProfile)
        .outerjoin(CustomerProfile, CustomerProfile.account_id == Account.id)
        .where(Account.role == RoleEnum.customer)
    )
    # Hide admin/operator Gmails that get a customer-role account created for
    # them (e.g. via admin-desktop-login) so they don't clutter the customer
    # list as bogus "incomplete" customers (Problem 10).
    admin_gmails = settings.admin_gmails_list
    if admin_gmails:
        stmt = stmt.where(func.lower(Account.gmail).notin_(admin_gmails))
    rows = (
        await db.execute(
            stmt.order_by(desc(Account.created_at)).limit(max(1, min(limit, 2000)))
        )
    ).all()
    out: List[Dict[str, Any]] = []
    for acct, prof in rows:
        base = _account_summary(acct)
        if prof is None:
            out.append({
                **base, "has_profile": False,
                "first_name": None, "last_name": None, "phone_number": None,
                "date_of_birth": None, "gender": None, "profile_photo_url": None,
                "is_banned": False, "ban_notice": None, "banned_at": None, "banned_by": None,
            })
            continue
        out.append({
            **base, "has_profile": True,
            "first_name": prof.first_name,
            "last_name": prof.last_name,
            "phone_number": prof.phone_number,
            "date_of_birth": prof.date_of_birth.isoformat() if prof.date_of_birth else None,
            "gender": getattr(prof.gender, "value", prof.gender),
            "profile_photo_url": prof.profile_photo_url,
            "is_banned": bool(getattr(prof, "is_banned", False)),
            "ban_notice": getattr(prof, "ban_notice", None),
            "banned_at": _iso(getattr(prof, "banned_at", None)),
            "banned_by": getattr(prof, "banned_by", None),
        })
    return out


async def _load_customer(db: AsyncSession, account_id: UUID) -> tuple[Account, CustomerProfile | None]:
    acct = (await db.execute(select(Account).where(Account.id == account_id))).scalar_one_or_none()
    if acct is None or acct.role != RoleEnum.customer:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer account not found")
    prof = (
        await db.execute(select(CustomerProfile).where(CustomerProfile.account_id == account_id))
    ).scalar_one_or_none()
    return acct, prof


@router.get("/customers/{account_id}/thread")
async def get_customer_thread(
    account_id: UUID,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, _prof = await _load_customer(db, account_id)
    rows = (
        await db.execute(
            select(CustomerAdminMessage)
            .where(CustomerAdminMessage.customer_account_id == acct.id)
            .order_by(CustomerAdminMessage.created_at.asc())
        )
    ).scalars().all()
    unread = [m for m in rows if m.direction == "customer_to_admin" and not m.is_read]
    for m in unread:
        m.is_read = True
    if unread:
        await db.commit()
    return {"items": [_serialize_customer_admin_msg(m) for m in rows]}


class CustomerAdminReplyIn(BaseModel):
    body: str = Field(default="", max_length=4000)
    attachment_url: Optional[str] = Field(default=None, max_length=500)
    attachment_mime: Optional[str] = Field(default=None, max_length=120)


class CustomerBanIn(BaseModel):
    notice: str = Field(min_length=1, max_length=1000)


@router.post("/customers/{account_id}/thread")
async def reply_to_customer(
    account_id: UUID,
    payload: CustomerAdminReplyIn,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, _prof = await _load_customer(db, account_id)
    body = (payload.body or "").strip()
    attachment_url = (payload.attachment_url or "").strip() or None
    attachment_mime = (payload.attachment_mime or "").strip() or None
    if not body and not attachment_url:
        raise HTTPException(400, "Message body or attachment required")
    db.add(CustomerAdminMessage(
        customer_account_id=acct.id,
        direction="admin_to_customer",
        body=body,
        attachment_url=attachment_url,
        attachment_mime=attachment_mime,
        is_read=False,
    ))
    db.add(UserNotification(
        account_id=acct.id,
        kind="admin_message",
        title="📩 New message from MediDoor Admin",
        body_bn=body or "MediDoor Admin একটি attachment পাঠিয়েছে।",
        payload_json=json.dumps({
            "from": "MediDoor Admin",
            "deep_link": "/messages",
            "attachment_url": attachment_url,
            "attachment_mime": attachment_mime,
        }),
    ))
    await db.commit()
    return {"ok": True}


@router.post("/customers/{account_id}/ban")
async def ban_customer(
    account_id: UUID,
    payload: CustomerBanIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, prof = await _load_customer(db, account_id)
    if prof is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer profile not found")
    notice = payload.notice.strip()
    prof.is_banned = True
    prof.ban_notice = notice
    prof.banned_at = datetime.now(timezone.utc)
    prof.banned_by = admin.gmail
    db.add(CustomerAdminMessage(
        customer_account_id=acct.id,
        direction="admin_to_customer",
        body=f"আপনার MediDoor account সাময়িকভাবে restricted করা হয়েছে।\n\nNotice: {notice}",
        is_read=False,
    ))
    db.add(UserNotification(
        account_id=acct.id,
        kind="admin_message",
        title="Account restricted by MediDoor Admin",
        body_bn=notice,
        payload_json=json.dumps({"from": "MediDoor Admin", "deep_link": "/messages", "customer_banned": True}),
    ))
    await db.commit()
    await db.refresh(prof)
    return {"ok": True, "is_banned": True, "notice": notice}


@router.post("/customers/{account_id}/unban")
async def unban_customer(
    account_id: UUID,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, prof = await _load_customer(db, account_id)
    if prof is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer profile not found")
    prof.is_banned = False
    prof.ban_notice = None
    prof.banned_at = None
    prof.banned_by = admin.gmail
    db.add(CustomerAdminMessage(
        customer_account_id=acct.id,
        direction="admin_to_customer",
        body="আপনার MediDoor account restriction সরানো হয়েছে। এখন আপনি আগের মতো order, search এবং Smart Prescription ব্যবহার করতে পারবেন।",
        is_read=False,
    ))
    db.add(UserNotification(
        account_id=acct.id,
        kind="admin_message",
        title="Account restriction removed",
        body_bn="আপনার MediDoor account restriction সরানো হয়েছে।",
        payload_json=json.dumps({"from": "MediDoor Admin", "deep_link": "/messages", "customer_banned": False}),
    ))
    await db.commit()
    return {"ok": True, "is_banned": False}


@router.get("/customers/threads/unread-summary")
async def customers_unread_summary(
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    rows = (
        await db.execute(
            select(CustomerAdminMessage.customer_account_id)
            .where(CustomerAdminMessage.direction == "customer_to_admin")
            .where(CustomerAdminMessage.is_read.is_(False))
        )
    ).all()
    counts: Dict[str, int] = {}
    for (cid,) in rows:
        key = str(cid)
        counts[key] = counts.get(key, 0) + 1
    return {"counts": counts, "total": sum(counts.values())}


# ---------- pharmacies ----------

@router.get("/pharmacies")
async def list_pharmacies(
    limit: int = 500,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    rows = (
        await db.execute(
            select(Account, PharmacyProfile)
            .outerjoin(PharmacyProfile, PharmacyProfile.account_id == Account.id)
            .where(Account.role == RoleEnum.pharmacy)
            .order_by(desc(Account.created_at))
            .limit(max(1, min(limit, 2000)))
        )
    ).all()
    out: List[Dict[str, Any]] = []
    for acct, prof in rows:
        if prof is None:
            out.append({**_account_summary(acct), "has_profile": False,
                        "pharmacy_name": None, "verification_status": None,
                        "is_blocked": False, "is_published": False})
            continue
        out.append({
            **_account_summary(acct),
            "has_profile": True,
            "pharmacy_id": str(prof.id),
            "pharmacy_name": prof.pharmacy_name,
            "owner_name": prof.owner_name,
            "business_name": prof.business_name,
            "pharmacy_license_no": prof.pharmacy_license_no,
            "pharmacy_license_doc_url": prof.pharmacy_license_doc_url,
            "banner_photo_url": prof.banner_photo_url,
            "pharmacist_name": prof.pharmacist_name,
            "pharmacist_reg_no": prof.pharmacist_reg_no,
            "address": prof.address,
            "phone_number": prof.phone_number,
            "is_verified": bool(prof.is_verified),
            "verification_status": prof.verification_status,
            "verification_message": prof.verification_message,
            "is_published": bool(prof.is_published),
            "is_blocked": bool(getattr(prof, "is_blocked", False)),
            "block_notice": getattr(prof, "block_notice", None),
            "blocked_at": _iso(getattr(prof, "blocked_at", None)),
            "blocked_by": getattr(prof, "blocked_by", None),
            "subscription_tier": prof.subscription_tier,
        })
    return out


async def _load_pharmacy(db: AsyncSession, account_id: UUID) -> tuple[Account, PharmacyProfile | None]:
    acct = (await db.execute(select(Account).where(Account.id == account_id))).scalar_one_or_none()
    if acct is None or acct.role != RoleEnum.pharmacy:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pharmacy account not found")
    prof = (
        await db.execute(select(PharmacyProfile).where(PharmacyProfile.account_id == account_id))
    ).scalar_one_or_none()
    return acct, prof


class PharmacyAdminReplyIn(BaseModel):
    body: str = Field(default="", max_length=4000)
    attachment_url: Optional[str] = Field(default=None, max_length=500)
    attachment_mime: Optional[str] = Field(default=None, max_length=120)


class PharmacyBlockIn(BaseModel):
    notice: str = Field(min_length=1, max_length=1000)


@router.get("/pharmacies/{account_id}/thread")
async def get_pharmacy_thread(
    account_id: UUID,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, _prof = await _load_pharmacy(db, account_id)
    rows = (
        await db.execute(
            select(PharmacyAdminMessage)
            .where(PharmacyAdminMessage.pharmacy_account_id == acct.id)
            .order_by(PharmacyAdminMessage.created_at.asc())
        )
    ).scalars().all()
    unread = [m for m in rows if m.direction == "pharmacy_to_admin" and not m.is_read]
    for m in unread:
        m.is_read = True
    if unread:
        await db.commit()
    return {"items": [_serialize_pharmacy_admin_msg(m) for m in rows]}


@router.post("/pharmacies/{account_id}/thread")
async def reply_to_pharmacy(
    account_id: UUID,
    payload: PharmacyAdminReplyIn,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, _prof = await _load_pharmacy(db, account_id)
    body = (payload.body or "").strip()
    attachment_url = (payload.attachment_url or "").strip() or None
    attachment_mime = (payload.attachment_mime or "").strip() or None
    if not body and not attachment_url:
        raise HTTPException(400, "Message body or attachment required")
    db.add(PharmacyAdminMessage(
        pharmacy_account_id=acct.id,
        direction="admin_to_pharmacy",
        body=body,
        attachment_url=attachment_url,
        attachment_mime=attachment_mime,
        is_read=False,
    ))
    db.add(UserNotification(
        account_id=acct.id,
        kind="admin_message",
        title="📩 New message from MediDoor Admin",
        body_bn=body or "MediDoor Admin একটি attachment পাঠিয়েছে।",
        payload_json=json.dumps({
            "from": "MediDoor Admin",
            "deep_link": "/profile?tab=inbox",
            "attachment_url": attachment_url,
            "attachment_mime": attachment_mime,
        }),
    ))
    await db.commit()
    return {"ok": True}


@router.post("/pharmacies/{account_id}/block")
async def block_pharmacy(
    account_id: UUID,
    payload: PharmacyBlockIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, prof = await _load_pharmacy(db, account_id)
    if prof is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pharmacy profile not found")
    notice = payload.notice.strip()
    prof.is_blocked = True
    prof.block_notice = notice
    prof.blocked_at = datetime.now(timezone.utc)
    prof.blocked_by = admin.gmail
    prof.is_published = False
    db.add(PharmacyAdminMessage(
        pharmacy_account_id=acct.id,
        direction="admin_to_pharmacy",
        body=f"আপনার MediDoor pharmacy account সাময়িকভাবে restricted করা হয়েছে।\n\nNotice: {notice}",
        is_read=False,
    ))
    db.add(UserNotification(
        account_id=acct.id,
        kind="admin_message",
        title="Pharmacy restricted by MediDoor Admin",
        body_bn=notice,
        payload_json=json.dumps({"from": "MediDoor Admin", "deep_link": "/profile?tab=inbox", "pharmacy_blocked": True}),
    ))
    await db.commit()
    await db.refresh(prof)
    return {"ok": True, "is_blocked": True, "notice": notice}


@router.post("/pharmacies/{account_id}/unblock")
async def unblock_pharmacy(
    account_id: UUID,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, prof = await _load_pharmacy(db, account_id)
    if prof is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pharmacy profile not found")
    prof.is_blocked = False
    prof.block_notice = None
    prof.blocked_at = None
    prof.blocked_by = admin.gmail
    db.add(PharmacyAdminMessage(
        pharmacy_account_id=acct.id,
        direction="admin_to_pharmacy",
        body="আপনার MediDoor pharmacy account restriction সরানো হয়েছে। এখন আপনি shop manage, orders এবং customer chat আগের মতো ব্যবহার করতে পারবেন।",
        is_read=False,
    ))
    db.add(UserNotification(
        account_id=acct.id,
        kind="admin_message",
        title="Pharmacy restriction removed",
        body_bn="আপনার MediDoor pharmacy account restriction সরানো হয়েছে।",
        payload_json=json.dumps({"from": "MediDoor Admin", "deep_link": "/profile?tab=inbox", "pharmacy_blocked": False}),
    ))
    await db.commit()
    return {"ok": True, "is_blocked": False}


@router.get("/pharmacies/threads/unread-summary")
async def pharmacies_unread_summary(
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    rows = (
        await db.execute(
            select(PharmacyAdminMessage.pharmacy_account_id)
            .where(PharmacyAdminMessage.direction == "pharmacy_to_admin")
            .where(PharmacyAdminMessage.is_read.is_(False))
        )
    ).all()
    counts: Dict[str, int] = {}
    for (pid,) in rows:
        key = str(pid)
        counts[key] = counts.get(key, 0) + 1
    return {"counts": counts, "total": sum(counts.values())}


# ---------- riders ----------

def _rider_dict(acct: Account, rider: RiderProfile | None) -> Dict[str, Any]:
    if rider is None:
        return {
            **_account_summary(acct), "has_profile": False,
            "rider_id": None, "full_name": None, "nick_name": None,
            "phone_number": None, "age": None, "nid_number": None,
            "nid_front_url": None, "nid_back_url": None,
            "birth_certificate_url": None, "student_id_card_url": None,
            "profile_photo_url": None, "is_verified": False,
            "verification_status": "no_profile", "verification_note": None,
            "verification_reviewed_at": None, "verification_reviewed_by": None,
            "last_seen_at": None,
        }
    return {
        **_account_summary(acct),
        "has_profile": True,
        "rider_id": str(rider.id),
        "full_name": rider.full_name,
        "nick_name": rider.nick_name,
        "phone_number": rider.phone_number,  # WhatsApp
        "age": rider.age,
        "nid_number": rider.nid_number,
        "nid_front_url": rider.nid_front_url,
        "nid_back_url": rider.nid_back_url,
        "birth_certificate_url": rider.birth_certificate_url,
        "student_id_card_url": rider.student_id_card_url,
        "profile_photo_url": rider.profile_photo_url,
        "is_verified": bool(rider.is_verified),
        "verification_status": rider.verification_status,
        "verification_note": rider.verification_note,
        "verification_reviewed_at": _iso(rider.verification_reviewed_at),
        "verification_reviewed_by": rider.verification_reviewed_by,
        "last_seen_at": _iso(rider.last_seen_at),
    }


@router.get("/riders")
async def list_riders(
    status_filter: Literal["pending", "verified", "rejected", "all"] = "all",
    limit: int = 500,
    _admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    stmt = (
        select(Account, RiderProfile)
        .outerjoin(RiderProfile, RiderProfile.account_id == Account.id)
        .where(Account.role == RoleEnum.rider)
    )
    if status_filter != "all":
        stmt = stmt.where(RiderProfile.verification_status == status_filter)
    stmt = stmt.order_by(desc(Account.created_at)).limit(max(1, min(limit, 2000)))
    rows = (await db.execute(stmt)).all()
    return [_rider_dict(a, r) for a, r in rows]


async def _load_rider(db: AsyncSession, account_id: UUID) -> tuple[Account, RiderProfile]:
    acct = (
        await db.execute(select(Account).where(Account.id == account_id))
    ).scalar_one_or_none()
    if acct is None or acct.role != RoleEnum.rider:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rider account not found")
    rider = (
        await db.execute(
            select(RiderProfile).where(RiderProfile.account_id == account_id)
        )
    ).scalar_one_or_none()
    if rider is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rider profile not found")
    return acct, rider


class VerifyIn(BaseModel):
    note: Optional[str] = Field(default=None, max_length=500)


class RejectIn(BaseModel):
    note: str = Field(min_length=1, max_length=500)


@router.post("/riders/{account_id}/verify")
async def verify_rider(
    account_id: UUID,
    body: VerifyIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, rider = await _load_rider(db, account_id)
    rider.is_verified = True
    rider.verification_status = "verified"
    rider.verification_note = (body.note or "").strip() or None
    rider.verification_reviewed_at = datetime.now(timezone.utc)
    rider.verification_reviewed_by = admin.gmail
    db.add(UserNotification(
        account_id=acct.id,
        kind="rider_verification",
        title="✅ Account verified",
        body_bn=(
            "MediDoor admin আপনার rider account verify করেছে। "
            "এখন থেকে আপনি online হয়ে delivery নিতে পারবেন।"
            + (f"\n\nAdmin note: {rider.verification_note}" if rider.verification_note else "")
        ),
        payload_json=json.dumps({
            "from": "MediDoor Admin",
            "verification_status": "verified",
            "deep_link": "/",
        }),
    ))
    await db.commit()
    await db.refresh(rider)
    return _rider_dict(acct, rider)


@router.post("/riders/{account_id}/reject")
async def reject_rider(
    account_id: UUID,
    body: RejectIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    acct, rider = await _load_rider(db, account_id)
    rider.is_verified = False
    rider.verification_status = "rejected"
    rider.verification_note = body.note.strip()
    rider.verification_reviewed_at = datetime.now(timezone.utc)
    rider.verification_reviewed_by = admin.gmail
    db.add(UserNotification(
        account_id=acct.id,
        kind="rider_verification",
        title="⛔ Documents need re-submission",
        body_bn=(
            "MediDoor admin আপনার submitted documents গ্রহণ করেনি।\n\n"
            f"Reason: {rider.verification_note}\n\n"
            "অনুগ্রহ করে সঠিক documents আবার upload করুন। প্রশ্ন থাকলে এই message এ reply করুন।"
        ),
        payload_json=json.dumps({
            "from": "MediDoor Admin",
            "verification_status": "rejected",
            "note": rider.verification_note,
            "deep_link": "/",
        }),
    ))
    await db.commit()
    await db.refresh(rider)
    return _rider_dict(acct, rider)


class MessageIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=2000)


@router.post("/riders/{account_id}/message")
async def message_rider(
    account_id: UUID,
    body: MessageIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Send a free-form message from MediDoor Admin to the rider's inbox.

    Doesn't change verification status — useful for asking the rider to
    re-take a blurry photo, confirm a detail, etc.
    """
    acct, _rider = await _load_rider(db, account_id)
    db.add(UserNotification(
        account_id=acct.id,
        kind="admin_message",
        title=body.title.strip(),
        body_bn=body.body.strip(),
        payload_json=json.dumps({"from": "MediDoor Admin"}),
    ))
    # Mirror into the persistent two-way thread.
    db.add(RiderAdminMessage(
        rider_account_id=acct.id,
        direction="admin_to_rider",
        body=f"{body.title.strip()}\n\n{body.body.strip()}".strip(),
        is_read=False,
    ))
    await db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Two-way admin <-> rider message thread (used by admin.py "💬 Messages" tab)
# ---------------------------------------------------------------------------


def _serialize_admin_msg(m: "RiderAdminMessage") -> Dict[str, Any]:
    return {
        "id": str(m.id),
        "direction": m.direction,
        "body": m.body,
        "attachment_url": m.attachment_url,
        "attachment_mime": m.attachment_mime,
        "is_read": bool(m.is_read),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


@router.get("/riders/{account_id}/thread")
async def get_rider_thread(
    account_id: UUID,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Full message history with this rider, ordered oldest -> newest.

    Marks every rider-to-admin message as read so admin.py's unread badge
    drops back to zero.
    """
    acct, _rider = await _load_rider(db, account_id)
    rows = (
        await db.execute(
            select(RiderAdminMessage)
            .where(RiderAdminMessage.rider_account_id == acct.id)
            .order_by(RiderAdminMessage.created_at.asc())
        )
    ).scalars().all()
    unread = [m for m in rows if m.direction == "rider_to_admin" and not m.is_read]
    for m in unread:
        m.is_read = True
    if unread:
        await db.commit()
    return {"items": [_serialize_admin_msg(m) for m in rows]}


class AdminReplyIn(BaseModel):
    body: str = Field(default="", max_length=4000)
    attachment_url: Optional[str] = Field(default=None, max_length=500)
    attachment_mime: Optional[str] = Field(default=None, max_length=120)


@router.post("/riders/{account_id}/thread")
async def reply_to_rider(
    account_id: UUID,
    payload: AdminReplyIn,
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Admin sends a thread reply (also pushes a notification to the rider)."""
    acct, _rider = await _load_rider(db, account_id)
    body = (payload.body or "").strip()
    attachment_url = (payload.attachment_url or "").strip() or None
    attachment_mime = (payload.attachment_mime or "").strip() or None
    if not body and not attachment_url:
        raise HTTPException(400, "Message body or attachment required")
    db.add(RiderAdminMessage(
        rider_account_id=acct.id,
        direction="admin_to_rider",
        body=body,
        attachment_url=attachment_url,
        attachment_mime=attachment_mime,
        is_read=False,
    ))
    db.add(UserNotification(
        account_id=acct.id,
        kind="admin_message",
        title="📩 New message from MediDoor Admin",
        body_bn=body or "MediDoor Admin একটি attachment পাঠিয়েছে।",
        payload_json=json.dumps({
            "from": "MediDoor Admin",
            "deep_link": "/messages",
            "attachment_url": attachment_url,
            "attachment_mime": attachment_mime,
        }),
    ))
    await db.commit()
    return {"ok": True}


@router.get("/riders/threads/unread-summary")
async def riders_unread_summary(
    admin: Account = Depends(get_admin_account),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Per-rider count of unread rider->admin messages — for admin.py badges."""
    rows = (
        await db.execute(
            select(
                RiderAdminMessage.rider_account_id,
                # SQLAlchemy 2.0 inline-aggregate via func
            )
            .where(RiderAdminMessage.direction == "rider_to_admin")
            .where(RiderAdminMessage.is_read.is_(False))
        )
    ).all()
    counts: Dict[str, int] = {}
    for (rid,) in rows:
        key = str(rid)
        counts[key] = counts.get(key, 0) + 1
    return {"counts": counts, "total": sum(counts.values())}
