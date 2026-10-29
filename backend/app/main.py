from contextlib import asynccontextmanager
import asyncio
import logging
import traceback
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import JSONResponse

from app.api.routes import admin_users as admin_users_routes
from app.api.routes import admin_orders as admin_orders_routes
from app.api.routes import admin_console as admin_console_routes
from app.api.routes import auth as auth_routes
from app.api.routes import ai as ai_routes
from app.api.routes import content as content_routes
from app.api.routes import conversations as conversation_routes
from app.api.routes import customer as customer_routes
from app.api.routes import files as files_routes
from app.api.routes import geo as geo_routes
from app.api.routes import moderation as moderation_routes
from app.api.routes import notifications as notification_routes
from app.api.routes import orders as order_routes
from app.api.routes import pharmacy as pharmacy_routes
from app.api.routes import rider as rider_routes
from app.api.routes import storefront as storefront_routes
from app.api.routes import uploads as upload_routes
from app.core.config import settings
from app.db.base import Base, engine
from app.db.migrate import autopatch_sqlite

UPLOAD_DIR = Path(__file__).resolve().parents[1] / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Auto-create tables in dev. Use Alembic for prod migrations.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    notes = await autopatch_sqlite(engine)
    for n in notes:
        print(f"[migrate] {n}", flush=True)
    # Postgres counterpart — autopatch_sqlite is a no-op on Postgres, so this
    # keeps the live DB schema in sync with the models on every boot and
    # prevents the "column ... does not exist" -> HTTP 500 class of bug.
    from app.db.pg_autopatch import pg_autopatch
    for n in await pg_autopatch(engine):
        print(f"[pg_autopatch] {n}", flush=True)
    # Seed the global category catalogue if missing (idempotent).
    from app.db.base import AsyncSessionLocal
    from app.db.seed_category_catalog import seed_category_catalog
    async with AsyncSessionLocal() as db:
        added = await seed_category_catalog(db)
        if added:
            print(f"[seed] +{added} category-catalog rows", flush=True)

    # 90-day retention sweep — runs once a day at 03:00 Asia/Dhaka.
    from app.services.retention import retention_loop
    # N7 — periodic DGDA re-verification + auto-unpublish of expired pharmacies.
    from app.services.pharmacy_verify import pharmacy_reverify_loop
    stop_event = asyncio.Event()
    retention_task = asyncio.create_task(retention_loop(stop_event), name="retention_loop")
    reverify_task = asyncio.create_task(
        pharmacy_reverify_loop(stop_event), name="pharmacy_reverify_loop"
    )

    try:
        yield
    finally:
        stop_event.set()
        for _task in (retention_task, reverify_task):
            _task.cancel()
            try:
                await _task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass


app = FastAPI(title=settings.APP_NAME, debug=settings.DEBUG, lifespan=lifespan)

# The OAuth `state` is carried in this session cookie across a cross-site
# round-trip to Google and back. A `SameSite=Lax` + non-Secure cookie can be
# dropped on the longer first-time-consent redirect chain, which surfaces as
# `oauth_error:mismatching_state` and a failed sign-in. In production (HTTPS)
# we therefore use `SameSite=None; Secure` so the cookie reliably survives the
# round-trip; on plain-HTTP localhost dev we fall back to Lax (None requires
# Secure, which a browser won't set over http).
_secure_session = (
    settings.BACKEND_URL.lower().startswith("https://")
    or settings.GOOGLE_REDIRECT_URI.lower().startswith("https://")
)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SECRET_KEY,
    same_site="none" if _secure_session else "lax",
    https_only=_secure_session,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CrossOriginResourcePolicyMiddleware(BaseHTTPMiddleware):
    """Allow /uploads/* assets to be embedded by the Next.js dev origins.

    Chrome's Opaque Response Blocking (ORB) drops cross-origin <img> requests
    served without a permissive CORP header, which broke product/avatar images
    on localhost:3000/3100/3200. Setting cross-origin here is safe: these are
    public catalog images already served via /uploads.
    """

    async def dispatch(self, request, call_next):  # type: ignore[override]
        response = await call_next(request)
        if request.url.path.startswith("/uploads/"):
            response.headers.setdefault("Cross-Origin-Resource-Policy", "cross-origin")
        return response


app.add_middleware(CrossOriginResourcePolicyMiddleware)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Defense-in-depth headers on every backend response: block MIME sniffing,
    deny framing (clickjacking), and never leak the Referer. The admin console
    route adds its own stricter CSP + no-store on top of these."""

    async def dispatch(self, request, call_next):  # type: ignore[override]
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response


app.add_middleware(SecurityHeadersMiddleware)

app.include_router(auth_routes.router)
app.include_router(files_routes.router)
app.include_router(upload_routes.router)
app.include_router(content_routes.router)
app.include_router(ai_routes.router)
app.include_router(geo_routes.router)
app.include_router(storefront_routes.router)
app.include_router(pharmacy_routes.router)
app.include_router(order_routes.router)
app.include_router(rider_routes.router)
app.include_router(conversation_routes.router)
app.include_router(moderation_routes.router)
app.include_router(admin_users_routes.router)
app.include_router(admin_orders_routes.router)
app.include_router(admin_console_routes.router)
app.include_router(notification_routes.router)
app.include_router(customer_routes.router)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


@app.get("/health")
async def health():
    return {"status": "ok", "app": settings.APP_NAME}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logging.exception("Unhandled exception in request handler")
    # Never leak internal error text / file paths to clients in production.
    # The full exception is logged server-side above; the client only sees a
    # generic message unless DEBUG is on (local dev).
    detail = str(exc) if (settings.DEBUG and exc) else "Internal Server Error"
    return JSONResponse(status_code=500, content={"detail": detail})


class _CatchAllExceptionMiddleware(BaseHTTPMiddleware):
    """Catch any exception that escapes the route handlers so we return a
    JSON body with the error detail instead of the generic 'Internal Server
    Error' text from the web server.  This is the last-resort net — the
    ``@app.exception_handler`` above handles exceptions raised inside
    FastAPI route functions; this middleware also covers exceptions raised
    inside other middleware (CORSMiddleware, SessionMiddleware, etc.) that
    the FastAPI handler cannot see.
    """

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        try:
            return await call_next(request)
        except Exception as exc:
            logging.exception("Unhandled exception in middleware pipeline")
            # Full traceback is logged server-side. Only expose it to the client
            # in DEBUG (local dev); production returns a generic message so we
            # don't leak internals (file paths, secrets in messages, stack).
            if settings.DEBUG:
                try:
                    detail = str(exc) if str(exc) else type(exc).__name__
                except Exception:  # noqa: BLE001
                    detail = type(exc).__name__
                return JSONResponse(
                    status_code=500,
                    content={"detail": detail, "traceback": traceback.format_exc()},
                )
            return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


app.add_middleware(_CatchAllExceptionMiddleware)
