"""
Web Admin Console — password-gated single-page app served by the backend.

This is the browser equivalent of the desktop `admin.py`. It is served from the
backend itself so it is *same-origin* with the API (no CORS), and it logs in with
a single password (no Google account, no SECRET_KEY in the browser).

Routes
    GET  /admin                      -> serves the console HTML (hardened headers)
    GET  /admin/admin-icon.png       -> the console / favicon image
    POST /api/admin/console/login    -> {password} -> {access_token}

Security model
    * Password checked server-side against ``settings.ADMIN_CONSOLE_PASSWORD``
      (env ``ADMIN_CONSOLE_PASSWORD``) with a constant-time compare. SECRET_KEY
      never leaves the server.
    * Brute force is throttled: per-client-IP failure counting + temporary
      lockout (HTTP 429) + a small delay on every failed attempt.
    * The served page carries a strict CSP, X-Frame-Options: DENY (anti
      clickjacking), nosniff, no-referrer and no-store.
    * On success we mint a normal admin access token for ``admin_gmails_list[0]``,
      which always passes ``get_admin_account``.
"""
from __future__ import annotations

import asyncio
import hmac
import time
from pathlib import Path
from typing import Dict, List

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.config import settings
from app.core.security import create_access_token, create_refresh_token
from app.models import Account
from app.models.user import RoleEnum

router = APIRouter(tags=["admin-console"])

_STATIC = Path(__file__).resolve().parents[2] / "static"
_CONSOLE_HTML = _STATIC / "admin_console.html"
_CONSOLE_ICON = _STATIC / "admin-icon.png"

# ----- brute-force throttle (in-memory, per client IP) -----
_MAX_FAILS = 8           # failures allowed within the window
_WINDOW = 300.0          # seconds the failures are counted over
_LOCKOUT = 300.0         # seconds locked out after too many failures
_FAILS: Dict[str, List[float]] = {}
_LOCKED: Dict[str, float] = {}

_CSP = (
    "default-src 'self'; "
    "img-src 'self' data: blob: https://api.medidoor.com.bd; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "connect-src 'self' https://api.medidoor.com.bd; "
    "font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
)
_SECURE_HEADERS = {
    "Content-Security-Policy": _CSP,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


def _client_ip(request: Request) -> str:
    # Behind cloudflared every request looks like 127.0.0.1, so trust the
    # Cloudflare-set real-client header first.
    return (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "?")
    )


def _check_lockout(ip: str) -> None:
    until = _LOCKED.get(ip)
    if until and time.monotonic() < until:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"অনেকবার ভুল চেষ্টা — {int(until - time.monotonic())}s পরে আবার চেষ্টা করুন।",
        )


def _record_failure(ip: str) -> None:
    now = time.monotonic()
    fails = [t for t in _FAILS.get(ip, []) if now - t < _WINDOW]
    fails.append(now)
    _FAILS[ip] = fails
    if len(fails) >= _MAX_FAILS:
        _LOCKED[ip] = now + _LOCKOUT
        _FAILS.pop(ip, None)
    if len(_FAILS) > 5000:  # cheap memory guard
        _FAILS.clear()


@router.get("/admin", include_in_schema=False)
@router.get("/admin/", include_in_schema=False)
async def serve_admin_console() -> FileResponse:
    if not _CONSOLE_HTML.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Admin console not built")
    return FileResponse(_CONSOLE_HTML, media_type="text/html", headers=_SECURE_HEADERS)


@router.get("/admin/admin-icon.png", include_in_schema=False)
async def serve_admin_icon() -> FileResponse:
    if not _CONSOLE_ICON.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "icon missing")
    return FileResponse(
        _CONSOLE_ICON, media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )


def _admin_gmail() -> str:
    gmails = settings.admin_gmails_list
    return (gmails[0] if gmails else "admin@medidoor.app").strip().lower()


@router.post("/api/admin/console/login", include_in_schema=False)
async def console_login(
    request: Request,
    password: str = Body("", embed=True),
    db: AsyncSession = Depends(get_db),
) -> dict:
    ip = _client_ip(request)
    _check_lockout(ip)

    expected = (settings.ADMIN_CONSOLE_PASSWORD or "").encode("utf-8")
    given = (password or "").encode("utf-8")
    if not expected or not hmac.compare_digest(given, expected):
        _record_failure(ip)
        await asyncio.sleep(0.6)  # slow down automated guessing
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "ভুল password")

    # success — clear any failure history for this IP
    _FAILS.pop(ip, None)
    _LOCKED.pop(ip, None)

    gmail = _admin_gmail()
    account = (
        await db.execute(select(Account).where(Account.gmail == gmail))
    ).scalars().first()
    if account is None:
        account = Account(
            gmail=gmail,
            google_sub=f"admin-console-{gmail}",
            role=RoleEnum.customer,
            is_registered=True,
        )
        db.add(account)
        await db.commit()
        await db.refresh(account)

    return {
        "access_token": create_access_token(str(account.id), account.role.value),
        "refresh_token": create_refresh_token(str(account.id), account.role.value),
        "token_type": "bearer",
    }
