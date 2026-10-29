from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True, extra="ignore")

    APP_NAME: str = "MediDoor"
    APP_ENV: str = "production"
    DEBUG: bool = False

    BACKEND_URL: str = "http://localhost:8000"
    FRONTEND_URL: str = "http://localhost:3000"
    # Origins for the standalone mobile apps. Used by the OAuth callback
    # to bounce a logged-in user back into the app they came from instead
    # of always landing on the website.
    MOBILE_CUSTOMER_URL: str = "http://localhost:3100"
    MOBILE_PHARMACY_URL: str = "http://localhost:3200"
    MOBILE_RIDER_URL: str = "http://localhost:3300"

    SECRET_KEY: str = Field(..., min_length=16)
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/api/auth/google/callback"

    # Gemini (Medi AI)
    GEMINI_API_KEY: str = ""           # legacy single-key (still honoured)
    GEMINI_API_KEYS: str = ""          # comma-separated pool, rotates on quota/error
    GEMINI_MODEL: str = "gemini-2.5-flash-lite"

    # Barikoi (reverse geocoding for customer "Locate me" pill)
    BARIKOI_API_KEY: str = ""

    # Default to SQLite for zero-setup local dev. Override with Postgres URL in prod.
    DATABASE_URL: str = "sqlite+aiosqlite:///./medidoor.db"
    REDIS_URL: str = "redis://localhost:6379/0"

    # Comma-separated origins allowed to call this API. Defaults include
    # the website (3000) and the customer mobile app (3100). Pharmacy /
    # rider mobile apps will join later (3200 / 3300 by convention).
    CORS_ORIGINS: str = (
        "http://localhost:3000,http://localhost:3100,"
        "http://localhost:3200,http://localhost:3300"
    )

    # Comma-separated gmail addresses allowed to call /api/admin/* endpoints.
    # In DEBUG mode the dev account `admin@medidoor.app` is auto-allowed.
    ADMIN_GMAILS: str = "admin@medidoor.app"

    # Single password that unlocks the web Admin Console (/admin). Set it via
    # the ADMIN_CONSOLE_PASSWORD env var — keep it strong. Empty = console
    # login is disabled (every attempt is rejected).
    ADMIN_CONSOLE_PASSWORD: str = ""

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def gemini_api_keys_list(self) -> List[str]:
        """Effective Gemini key pool: union of GEMINI_API_KEYS (csv) and GEMINI_API_KEY (legacy).
        Order preserved, duplicates dropped."""
        seen: List[str] = []
        for raw in (self.GEMINI_API_KEYS or "").split(","):
            k = raw.strip()
            if k and k not in seen:
                seen.append(k)
        legacy = (self.GEMINI_API_KEY or "").strip()
        if legacy and legacy not in seen:
            seen.append(legacy)
        return seen

    @property
    def admin_gmails_list(self) -> List[str]:
        return [g.strip().lower() for g in self.ADMIN_GMAILS.split(",") if g.strip()]

    @property
    def dev_endpoints_enabled(self) -> bool:
        """Whether dev-only shortcuts (the /dev-login token minter and the
        DEBUG `admin@medidoor.app` auto-admin bypass) are allowed.

        These MUST never be reachable in production — leaving DEBUG=true in a
        production deployment would otherwise let anyone mint tokens for any
        role (and become admin). So we additionally require APP_ENV to not be
        'production'."""
        return self.DEBUG and self.APP_ENV.strip().lower() != "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
