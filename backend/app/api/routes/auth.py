"""
Google OAuth 2.0 + role-based registration routes.

Flow:
  1. GET  /api/auth/google/login?role=customer
       -> stores `role` (intended for first-time signup) in session,
          redirects to Google.
  2. GET  /api/auth/google/callback
       -> exchanges code, fetches userinfo.
       -> If an Account already exists for this gmail, it is REUSED with its
          existing role (the `?role=` from the URL is ignored). This means
          one Gmail = one role for the lifetime of the account.
       -> Otherwise a new Account is created with the requested role.
       -> issues JWT pair, redirects to FRONTEND/auth/callback#access=...
  3. GET  /api/auth/me                         (Authorization: Bearer <access>)
  4. POST /api/auth/register/{customer|pharmacy|rider}  -> completes profile.
"""
from __future__ import annotations

import secrets
from typing import Literal
from urllib.parse import urlencode

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_account, get_db
from app.core.config import settings
from app.core.security import create_access_token, create_refresh_token
from app.models import (
    Account,
    CustomerProfile,
    PharmacyProfile,
    RiderProfile,
    RoleEnum,
)
from app.schemas.auth import (
    CustomerProfileUpdate,
    CustomerRegister,
    MeResponse,
    PharmacyRegister,
    RiderProfileUpdate,
    RiderRegister,
    TokenPair,
)
from app.services.pharmacy_verify import (
    license_already_taken,
    schedule_pharmacy_verification,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

oauth = OAuth()
oauth.register(
    name="google",
    client_id=settings.GOOGLE_CLIENT_ID,
    client_secret=settings.GOOGLE_CLIENT_SECRET,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

VALID_ROLES = {"customer", "pharmacy", "rider"}

# Allow-listed app identifiers — clients pass `?app=…` on /google/login so
# that after the OAuth round-trip we can hand the JWT pair back to the
# correct origin (website vs mobile app) instead of always redirecting to
# the website. Anything not in this map falls back to the website.
APP_TARGETS = {
    "website": "FRONTEND_URL",
    "mobile-customer": "MOBILE_CUSTOMER_URL",
    "mobile-pharmacy": "MOBILE_PHARMACY_URL",
    "mobile-rider": "MOBILE_RIDER_URL",
}


def _target_origin(app: str) -> str:
    attr = APP_TARGETS.get(app, "FRONTEND_URL")
    return getattr(settings, attr, settings.FRONTEND_URL)


# ----------------------------- OAuth flow -----------------------------


@router.get("/google/login")
async def google_login(
    request: Request,
    role: str = "customer",
    app: str = "website",
):
    if role not in VALID_ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid role")

    # Friendly redirect if Google credentials aren't configured yet.
    if (
        not settings.GOOGLE_CLIENT_ID
        or not settings.GOOGLE_CLIENT_SECRET
        or "PASTE_YOUR" in settings.GOOGLE_CLIENT_SECRET.upper()
    ):
        return _redirect_to_frontend_error(
            "google_not_configured", _target_origin(app if app in APP_TARGETS else "website")
        )

    # Prevent unbounded growth of the session cookie. Every OAuth attempt makes
    # authlib store a `_state_google_<state>` entry in the session, and only a
    # *successful* callback removes it. Abandoned or failed attempts pile up;
    # once the signed session cookie crosses the browser's ~4KB limit the
    # browser silently drops it, after which EVERY subsequent login fails with
    # `oauth_error:mismatching_state` (and each retry makes it worse). Clearing
    # the stale OAuth state here keeps the cookie small and breaks that loop.
    for _stale in [k for k in list(request.session.keys()) if str(k).startswith("_state_")]:
        request.session.pop(_stale, None)

    app_key = app if app in APP_TARGETS else "website"
    # Stash role + originating app in the OAuth session so the callback
    # knows where to send the user back to once Google returns.
    request.session["oauth_role"] = role
    request.session["oauth_app"] = app_key
    # ALSO carry app+role inside the OAuth `state` itself. The backend
    # session cookie is SHARED by the website and every TWA mobile app
    # (same api origin, same browser), so a login started from another
    # MediDoor app can overwrite the session values mid-flight — Google
    # echoes `state` back untouched, making it the only clobber-proof
    # channel. Format: <random>.<app>.<role>; the random part comes from
    # token_urlsafe (base64url alphabet), which never contains ".".
    state = f"{secrets.token_urlsafe(24)}.{app_key}.{role}"
    redirect_uri = settings.GOOGLE_REDIRECT_URI
    return await oauth.google.authorize_redirect(request, redirect_uri, state=state)


@router.get("/google/callback")
async def google_callback(request: Request, db: AsyncSession = Depends(get_db)):
    role = request.session.pop("oauth_role", "customer")
    app = request.session.pop("oauth_app", "website")
    # Prefer the values embedded in the OAuth `state` (see google_login) —
    # they are immune to the shared-session-cookie clobbering that happens
    # when two MediDoor apps start logins concurrently in one browser.
    state_param = request.query_params.get("state") or ""
    state_parts = state_param.split(".")
    if len(state_parts) == 3:
        _rand, state_app, state_role = state_parts
        if state_app in APP_TARGETS:
            app = state_app
        if state_role in VALID_ROLES:
            role = state_role
    if role not in VALID_ROLES:
        role = "customer"
    target_origin = _target_origin(app)

    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError as exc:
        # A failed exchange (commonly `mismatching_state` when the session
        # cookie was dropped/expired — or when a login started in ANOTHER
        # MediDoor app wiped this flow's state, since website + mobile apps
        # share the api-origin session cookie — or `access_denied` when the
        # user backs out of the Google consent screen) leaves stale `_state_*`
        # entries in the session that make the NEXT attempt fail too. Clear
        # them here so a plain retry succeeds instead of looping on the error.
        for _stale in [k for k in list(request.session.keys()) if str(k).startswith("_state_")]:
            request.session.pop(_stale, None)
        return _redirect_to_frontend_error(f"oauth_error:{exc.error}", target_origin)

    userinfo = token.get("userinfo")
    if not userinfo:
        userinfo = await oauth.google.userinfo(token=token)

    gmail = userinfo.get("email")
    google_sub = userinfo.get("sub")
    email_verified = userinfo.get("email_verified", False)

    if not gmail or not google_sub:
        return _redirect_to_frontend_error("missing_userinfo", target_origin)
    if not email_verified:
        return _redirect_to_frontend_error("email_not_verified", target_origin)

    role_enum = RoleEnum(role)

    # One Gmail = one Account = one Role for the lifetime of the account.
    existing = (
        await db.execute(select(Account).where(Account.gmail == gmail))
    ).scalars().first()

    if existing is None:
        # Brand-new identity → create the account in the role they picked.
        account = Account(
            gmail=gmail,
            google_sub=google_sub,
            role=role_enum,
            is_registered=False,
        )
        db.add(account)
        await db.commit()
        await db.refresh(account)
    else:
        account = existing
        changed = False
        if account.role != role_enum:
            if account.is_registered:
                # A COMPLETED account keeps its role for life. Instead of
                # silently signing the user in under their OLD role (which made
                # it look like "pharmacy/rider login is broken" — you picked
                # Pharmacy but landed on the Customer page), bounce back to
                # /login with a clear, role-aware message.
                return _redirect_to_role_mismatch(account.role.value, role, target_origin)
            # An account that never finished registration isn't tied to any
            # role yet (no profile committed). Let the user switch to the role
            # they just picked instead of being stuck forever in a wrong role
            # chosen by an earlier, abandoned sign-in attempt.
            account.role = role_enum
            changed = True
        if account.google_sub != google_sub:
            account.google_sub = google_sub
            changed = True
        if changed:
            await db.commit()
            await db.refresh(account)

    access = create_access_token(str(account.id), account.role.value)
    refresh = create_refresh_token(str(account.id), account.role.value)

    params = urlencode(
        {
            "access": access,
            "refresh": refresh,
            "role": account.role.value,
            "registered": "1" if account.is_registered else "0",
        }
    )
    return RedirectResponse(url=f"{target_origin}/auth/callback#{params}")


def _redirect_to_frontend_error(code: str, origin: str | None = None) -> RedirectResponse:
    """Bounce a failed sign-in back to the /login page of the app that
    STARTED the flow. Historically this always went to the website, so a
    mobile-app user who hit any OAuth error suddenly found themselves on
    medidoor.com.bd with an error banner — pass `origin` (from the `app`
    param / oauth_app session key) so each app keeps its own failures."""
    base = origin or settings.FRONTEND_URL
    return RedirectResponse(url=f"{base}/login?error={code}", status_code=302)


def _redirect_to_role_mismatch(have: str, want: str, origin: str | None = None) -> RedirectResponse:
    """A finished account tried to sign in under a different role.

    Send the user back to the login screen OF THE APP THEY CAME FROM with
    enough context (`have` = their real role, `want` = the role they just
    clicked) for the UI to show a clear Bengali message and pre-select their
    real role for a one-click retry."""
    params = urlencode({"error": "role_mismatch", "have": have, "want": want})
    base = origin or settings.FRONTEND_URL
    return RedirectResponse(url=f"{base}/login?{params}", status_code=302)


# ----------------------------- DEV-only test login -----------------------------
# Provides a way to issue a JWT pair without going through Google OAuth so that
# automated tests / local development can bootstrap accounts. Disabled when
# settings.DEBUG is False so production environments can never reach it.


@router.post("/dev-login", response_model=TokenPair, include_in_schema=False)
async def dev_login(
    gmail: str = Body(..., embed=True),
    role: Literal["customer", "pharmacy", "rider"] = Body(..., embed=True),
    db: AsyncSession = Depends(get_db),
):
    if not settings.dev_endpoints_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    role_enum = RoleEnum(role)
    existing = (
        await db.execute(select(Account).where(Account.gmail == gmail))
    ).scalars().first()
    if existing is None:
        account = Account(
            gmail=gmail,
            google_sub=f"dev-{gmail}",
            role=role_enum,
            is_registered=False,
        )
        db.add(account)
        await db.commit()
        await db.refresh(account)
    else:
        account = existing
    return TokenPair(
        access_token=create_access_token(str(account.id), account.role.value),
        refresh_token=create_refresh_token(str(account.id), account.role.value),
    )


@router.post("/admin-desktop-login", response_model=TokenPair, include_in_schema=False)
async def admin_desktop_login(
    request: Request,
    gmail: str = Body("", embed=True),
    db: AsyncSession = Depends(get_db),
):
    # Authentication is gated by the X-MediDoor-Desktop-Secret header, which
    # must equal the backend's SECRET_KEY. Anyone holding that secret is
    # treated as the operator running admin.py.
    if request.headers.get("x-medidoor-desktop-secret") != settings.SECRET_KEY:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    admin_gmails = settings.admin_gmails_list
    target_gmail = (gmail or (admin_gmails[0] if admin_gmails else "")).strip().lower()
    if not target_gmail or target_gmail not in admin_gmails:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")

    existing = (
        await db.execute(select(Account).where(Account.gmail == target_gmail))
    ).scalars().first()
    if existing is None:
        account = Account(
            gmail=target_gmail,
            google_sub=f"admin-desktop-{target_gmail}",
            role=RoleEnum.customer,
            is_registered=True,
        )
        db.add(account)
        await db.commit()
        await db.refresh(account)
    else:
        account = existing

    return TokenPair(
        access_token=create_access_token(str(account.id), account.role.value),
        refresh_token=create_refresh_token(str(account.id), account.role.value),
    )


# ----------------------------- Me + Registration -----------------------------


@router.get("/me", response_model=MeResponse)
async def me(account: Account = Depends(get_current_account), db: AsyncSession = Depends(get_db)):
    profile_data = None
    if account.role == RoleEnum.customer and account.customer:
        c = account.customer
        profile_data = {
            "first_name": c.first_name,
            "last_name": c.last_name,
            "phone_number": c.phone_number,
            "date_of_birth": c.date_of_birth.isoformat() if c.date_of_birth else None,
            "gender": c.gender.value if hasattr(c.gender, "value") else c.gender,
            "profile_photo_url": c.profile_photo_url,
            "is_banned": bool(getattr(c, "is_banned", False)),
            "ban_notice": getattr(c, "ban_notice", None),
            "banned_at": c.banned_at.isoformat() if getattr(c, "banned_at", None) else None,
            "banned_by": getattr(c, "banned_by", None),
        }
    elif account.role == RoleEnum.pharmacy and account.pharmacy:
        p = account.pharmacy
        profile_data = {
            "pharmacy_name": p.pharmacy_name,
            "owner_name": p.owner_name,
            "is_verified": p.is_verified,
            "verification_status": p.verification_status,
            "is_blocked": bool(getattr(p, "is_blocked", False)),
            "block_notice": getattr(p, "block_notice", None),
            "blocked_at": p.blocked_at.isoformat() if getattr(p, "blocked_at", None) else None,
            "blocked_by": getattr(p, "blocked_by", None),
        }
    elif account.role == RoleEnum.rider and account.rider:
        r = account.rider
        # Existing rows from before Phase 3 have NULL verification_status.
        # Fall back so the client always gets a definite "pending"/"verified"
        # value and can lock the dashboard correctly.
        v_status = r.verification_status or ("verified" if r.is_verified else "pending")
        profile_data = {
            "full_name": r.full_name,
            "nick_name": r.nick_name,
            "phone_number": r.phone_number,
            "age": r.age,
            "nid_number": r.nid_number,
            "nid_front_url": r.nid_front_url,
            "nid_back_url": r.nid_back_url,
            "birth_certificate_url": r.birth_certificate_url,
            "student_id_card_url": r.student_id_card_url,
            "profile_photo_url": r.profile_photo_url,
            "is_verified": bool(r.is_verified) and v_status == "verified",
            "verification_status": v_status,
            "verification_note": r.verification_note,
            "verification_reviewed_at": r.verification_reviewed_at.isoformat()
            if r.verification_reviewed_at else None,
        }

    return MeResponse(
        account_id=str(account.id),
        gmail=account.gmail,
        role=account.role.value,
        is_registered=account.is_registered,
        profile=profile_data,
    )


@router.patch("/me/customer", response_model=MeResponse)
async def update_customer_profile(
    payload: CustomerProfileUpdate,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
):
    if account.role != RoleEnum.customer:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only customers can edit this profile")

    profile = account.customer
    if profile is None:
        profile = CustomerProfile(
            account_id=account.id,
            first_name=payload.first_name or "Customer",
            last_name=payload.last_name or "",
            phone_number=payload.phone_number or "000000",
            date_of_birth=payload.date_of_birth,
            gender=payload.gender,
            profile_photo_url=payload.profile_photo_url,
        )
        account.customer = profile
        db.add(profile)
    else:
        updates = payload.model_dump(exclude_unset=True)
        for field, value in updates.items():
            if field in {"first_name", "last_name", "phone_number"} and value is None:
                continue
            setattr(profile, field, value)

    account.is_registered = True
    await db.commit()
    await db.refresh(profile)
    return _me_response(
        account,
        {
            "first_name": profile.first_name,
            "last_name": profile.last_name,
            "phone_number": profile.phone_number,
            "date_of_birth": profile.date_of_birth.isoformat() if profile.date_of_birth else None,
            "gender": profile.gender.value if hasattr(profile.gender, "value") else profile.gender,
            "profile_photo_url": profile.profile_photo_url,
            "is_banned": bool(getattr(profile, "is_banned", False)),
            "ban_notice": getattr(profile, "ban_notice", None),
            "banned_at": profile.banned_at.isoformat() if getattr(profile, "banned_at", None) else None,
            "banned_by": getattr(profile, "banned_by", None),
        },
    )


@router.patch("/me/rider", response_model=MeResponse)
async def update_rider_profile(
    payload: RiderProfileUpdate,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
):
    if account.role != RoleEnum.rider:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only riders can edit this profile")
    profile = account.rider
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rider profile not found — register first")

    updates = payload.model_dump(exclude_unset=True)
    for field, value in updates.items():
        if field == "phone_number" and value is None:
            continue
        setattr(profile, field, value)

    await db.commit()
    await db.refresh(profile)
    v_status = profile.verification_status or ("verified" if profile.is_verified else "pending")
    return _me_response(
        account,
        {
            "full_name": profile.full_name,
            "nick_name": profile.nick_name,
            "phone_number": profile.phone_number,
            "age": profile.age,
            "nid_number": profile.nid_number,
            "nid_front_url": profile.nid_front_url,
            "nid_back_url": profile.nid_back_url,
            "birth_certificate_url": profile.birth_certificate_url,
            "student_id_card_url": profile.student_id_card_url,
            "profile_photo_url": profile.profile_photo_url,
            "is_verified": bool(profile.is_verified) and v_status == "verified",
            "verification_status": v_status,
            "verification_note": profile.verification_note,
            "verification_reviewed_at": profile.verification_reviewed_at.isoformat()
            if profile.verification_reviewed_at else None,
        },
    )


def _ensure_role(account: Account, expected: RoleEnum) -> None:
    if account.role != expected:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Wrong role for this endpoint")
    if account.is_registered:
        raise HTTPException(status.HTTP_409_CONFLICT, "Already registered")


def _me_response(account: Account, profile_data: dict | None) -> MeResponse:
    return MeResponse(
        account_id=str(account.id),
        gmail=account.gmail,
        role=account.role.value,
        is_registered=account.is_registered,
        profile=profile_data,
    )


@router.post("/register/customer", response_model=MeResponse)
async def register_customer(
    payload: CustomerRegister,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
):
    _ensure_role(account, RoleEnum.customer)
    profile = CustomerProfile(account_id=account.id, **payload.model_dump())
    account.is_registered = True
    db.add(profile)
    await db.commit()
    return _me_response(
        account,
        {
            "first_name": profile.first_name,
            "last_name": profile.last_name,
            "phone_number": profile.phone_number,
            "date_of_birth": profile.date_of_birth.isoformat() if profile.date_of_birth else None,
            "gender": profile.gender.value if hasattr(profile.gender, "value") else profile.gender,
            "profile_photo_url": profile.profile_photo_url,
            "is_banned": False,
            "ban_notice": None,
            "banned_at": None,
            "banned_by": None,
        },
    )


@router.post("/register/pharmacy", response_model=MeResponse)
async def register_pharmacy(
    payload: PharmacyRegister,
    background: BackgroundTasks,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
):
    _ensure_role(account, RoleEnum.pharmacy)
    # Pre-check: prevent two pharmacies from claiming the same license number.
    # Only blocks if some OTHER pharmacy is currently using it as pending or
    # verified (failed/not_found rows are ignored so a typo doesn't lock
    # another pharmacist out).
    if await license_already_taken(db, payload.pharmacy_license_no):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "এই DGDA license number ইতিমধ্যে অন্য একটি pharmacy ব্যবহার করছে।",
        )
    profile = PharmacyProfile(
        account_id=account.id,
        verification_status="pending",
        verification_message="আপনার pharmacy যাচাই করা হচ্ছে — কয়েক মুহূর্ত অপেক্ষা করুন…",
        verification_attempts=0,
        **payload.model_dump(),
    )
    account.is_registered = True
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    # Kick off the DGDA bot in the background so the response stays fast.
    schedule_pharmacy_verification(background, profile.id)
    return _me_response(
        account,
        {
            "pharmacy_name": profile.pharmacy_name,
            "owner_name": profile.owner_name,
            "is_verified": profile.is_verified,
            "verification_status": profile.verification_status,
            "is_blocked": False,
            "block_notice": None,
            "blocked_at": None,
            "blocked_by": None,
        },
    )


@router.post("/register/rider", response_model=MeResponse)
async def register_rider(
    payload: RiderRegister,
    account: Account = Depends(get_current_account),
    db: AsyncSession = Depends(get_db),
):
    _ensure_role(account, RoleEnum.rider)
    existing = account.rider
    if existing is not None:
        # Resubmission flow: a rider whose previous documents were rejected by
        # the admin is allowed to overwrite their profile and re-enter the
        # pending queue. Verified riders cannot blow away their own status
        # through this endpoint.
        if (existing.verification_status or "").lower() != "rejected":
            raise HTTPException(409, "Rider profile already exists")
        for k, v in payload.model_dump().items():
            setattr(existing, k, v)
        existing.is_verified = False
        existing.verification_status = "pending"
        existing.verification_note = None
        existing.verification_reviewed_at = None
        existing.verification_reviewed_by = None
        profile = existing
    else:
        profile = RiderProfile(account_id=account.id, **payload.model_dump())
        db.add(profile)
    account.is_registered = True
    await db.commit()
    await db.refresh(profile)
    return _me_response(
        account,
        {
            "full_name": profile.full_name,
            "nick_name": profile.nick_name,
            "is_verified": profile.is_verified,
            "verification_status": profile.verification_status,
            "verification_note": profile.verification_note,
        },
    )


# ----------------------------- Refresh + Logout -----------------------------


@router.post("/refresh", response_model=TokenPair)
async def refresh_tokens(refresh_token: str = Body(..., embed=True)):
    from app.core.security import decode_token

    payload = decode_token(refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")
    sub = payload["sub"]
    role = payload["role"]
    return TokenPair(
        access_token=create_access_token(sub, role),
        refresh_token=create_refresh_token(sub, role),
    )


@router.post("/logout")
async def logout(account: Account = Depends(get_current_account)):
    # Stateless JWT — client just discards tokens. (Redis blacklist can be added later.)
    return {"ok": True}
