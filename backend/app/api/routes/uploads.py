"""
Upload endpoint used by registration croppers and support attachments.
Saves uploaded files under backend/uploads/ and returns a URL served by
the StaticFiles mount in main.py.
"""
from __future__ import annotations

import secrets
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from app.core.config import settings
from app.api.routes.files import PRIVATE_DIR, SENSITIVE_KINDS

router = APIRouter(prefix="/api", tags=["uploads"])

UPLOAD_DIR = Path(__file__).resolve().parents[3] / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".pdf"}
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "application/pdf"}
MAX_BYTES = 12 * 1024 * 1024


@router.post("/upload")
async def upload(file: UploadFile = File(...), kind: str = Form(default="")):
    """Save an upload. Sensitive `kind`s (prescription, nid, license,
    birth_certificate, student_id) go to the PRIVATE store and come back as a
    protected `/api/files/raw/...` URL (viewable only via an authorised grant);
    everything else (product images, banners, avatars) stays public.

    Uploads stay unauthenticated because registration submits NID / license
    documents *before* the account exists — but sensitive files are no longer
    publicly readable once stored.
    """
    if file.content_type not in ALLOWED_MIME:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unsupported file type")

    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File too large")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXT:
        if file.content_type == "application/pdf":
            suffix = ".pdf"
        else:
            suffix = ".png" if file.content_type == "image/png" else ".jpg"

    name = f"{secrets.token_hex(16)}{suffix}"
    if (kind or "").strip().lower() in SENSITIVE_KINDS:
        (PRIVATE_DIR / name).write_bytes(raw)
        return {
            "url": f"{settings.BACKEND_URL}/api/files/raw/{name}",
            "mime": file.content_type,
            "private": True,
        }

    dest = UPLOAD_DIR / name
    dest.write_bytes(raw)
    return {"url": f"{settings.BACKEND_URL}/uploads/{name}", "mime": file.content_type}
