from typing import AsyncGenerator
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import decode_token
from app.db.base import AsyncSessionLocal
from app.models import Account


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session


async def get_current_account(
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> Account:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")

    token = authorization.split(" ", 1)[1].strip()
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")

    try:
        account_id = UUID(payload["sub"])
    except (KeyError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token subject")

    account = (
        await db.execute(
            select(Account)
            .where(Account.id == account_id)
            .options(
                selectinload(Account.customer),
                selectinload(Account.pharmacy),
                selectinload(Account.rider),
            )
        )
    ).scalar_one_or_none()
    if not account or not account.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account not found or inactive")

    return account
