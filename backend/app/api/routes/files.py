"""
Protected file serving (N4) — sensitive uploads (prescriptions, NID, license,
birth certificate, student ID) are stored in a PRIVATE directory that is never
mounted publicly. They can only be fetched with either:

  * a short-lived signed token (`?sig=`) minted by `POST /api/files/grant`
    for an authorised viewer — this lets a plain <img> tag load the file; or
  * a valid Bearer token whose account is allowed to see the file (used by
    the desktop admin tool and any direct fetch).

Authorisation rules (`can_view_file`):
  * Admins can view anything.
  * A pharmacy can view its own license document, and any prescription on an
    order placed with it.
  * A rider can view its own identity documents, and any prescription on an
    order it is delivering.
  * A customer can view prescriptions on its own orders / chat attachments.
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_account, get_db
from app.api.routes.moderation import _is_admin
from app.core.config import settings
from app.core.security import create_file_token, decode_token, verify_file_token
from app.models import (
    Account,
    Conversation,
    ConversationMessage,
    Order,
    RoleEnum,
)

router = APIRouter(prefix="/api/files", tags=["files"])

# Private store — sibling of the public `uploads/` dir, but NOT mounted.
PRIVATE_DIR = Path(__file__).resolve().parents[3] / "uploads_private"
PRIVATE_DIR.mkdir(parents=True, exist_ok=True)

# Upload `kind`s that must be stored privately.
SENSITIVE_KINDS = {"prescription", "nid", "license", "birth_certificate", "student_id"}

_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")

_MIME_BY_EXT = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".pdf": "application/pdf",
}


def _safe_name(name: str) -> str:
    name = (name or "").strip()
    if not name or not _SAFE_NAME.match(name) or "/" in name or ".." in name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid file name")
    return name


def file_basename(ref: str | None) -> str | None:
    """Extract the bare filename from any stored URL / path form."""
    if not ref:
        return None
    return ref.rstrip("/").split("/")[-1].split("?")[0] or None


async def can_view_file(db: AsyncSession, account: Account, name: str) -> bool:
    if _is_admin(account):
        return True
    like = f"%{name}%"
    role = account.role

    if role == RoleEnum.pharmacy and account.pharmacy is not None:
        p = account.pharmacy
        if p.pharmacy_license_doc_url and name in p.pharmacy_license_doc_url:
            return True
        hit = (await db.execute(
            select(Order.id).where(
                Order.pharmacy_id == p.id, Order.prescription_url.like(like)
            ).limit(1)
        )).first()
        if hit:
            return True

    if role == RoleEnum.rider and account.rider is not None:
        r = account.rider
        for u in (
            r.nid_front_url, r.nid_back_url, r.birth_certificate_url,
            r.student_id_card_url, r.profile_photo_url,
        ):
            if u and name in u:
                return True
        hit = (await db.execute(
            select(Order.id).where(
                Order.accepted_rider_id == r.id, Order.prescription_url.like(like)
            ).limit(1)
        )).first()
        if hit:
            return True

    if role == RoleEnum.customer:
        hit = (await db.execute(
            select(Order.id).where(
                Order.customer_account_id == account.id,
                Order.prescription_url.like(like),
            ).limit(1)
        )).first()
        if hit:
            return True
        hit2 = (await db.execute(
            select(ConversationMessage.id)
            .join(Conversation, ConversationMessage.conversation_id == Conversation.id)
            .where(
                Conversation.customer_account_id == account.id,
                ConversationMessage.attachment_url.like(like),
            ).limit(1)
        )).first()
        if hit2:
            return True

    return False


class GrantIn(BaseModel):
    # Either a bare name or any stored URL pointing at the file.
    ref: str


@router.post("/grant")
async def grant_file_url(
    payload: GrantIn,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Mint a short-lived viewable URL for a private file, if allowed."""
    name = _safe_name(file_basename(payload.ref) or "")
    if not (PRIVATE_DIR / name).exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    if not await can_view_file(db, account, name):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can't view this file")
    token = create_file_token(name)
    return {"url": f"{settings.BACKEND_URL}/api/files/raw/{name}?sig={token}"}


@router.get("/raw/{name}")
async def serve_file(
    name: str,
    sig: str = Query(default=""),
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    """Serve a private file. Authorise via a signed `sig` (for <img>) or a
    Bearer token whose account is allowed to view the file."""
    name = _safe_name(name)
    dest = PRIVATE_DIR / name
    if not dest.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")

    authorised = False
    if sig and verify_file_token(sig, name):
        authorised = True
    elif authorization.lower().startswith("bearer "):
        payload = decode_token(authorization.split(" ", 1)[1].strip())
        if payload and payload.get("type") == "access":
            from uuid import UUID
            try:
                account_id = UUID(str(payload.get("sub")))
            except Exception:
                account_id = None
            if account_id is not None:
                from sqlalchemy.orm import selectinload
                account = (await db.execute(
                    select(Account).where(Account.id == account_id).options(
                        selectinload(Account.customer),
                        selectinload(Account.pharmacy),
                        selectinload(Account.rider),
                    )
                )).scalar_one_or_none()
                if account and account.is_active and await can_view_file(db, account, name):
                    authorised = True

    if not authorised:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authorised for this file")

    media = _MIME_BY_EXT.get(dest.suffix.lower(), "application/octet-stream")
    return FileResponse(str(dest), media_type=media)
