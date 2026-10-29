from __future__ import annotations

from fastapi import HTTPException, status

from app.models import Account, RoleEnum


def customer_ban_payload(account: Account) -> dict:
    customer = account.customer
    return {
        "code": "customer_banned",
        "message": (customer.ban_notice if customer else None) or "MediDoor admin আপনার customer account সাময়িকভাবে restricted করেছে।",
        "banned_at": customer.banned_at.isoformat() if customer and customer.banned_at else None,
        "banned_by": customer.banned_by if customer else None,
    }


def is_customer_banned(account: Account) -> bool:
    return account.role == RoleEnum.customer and bool(account.customer and account.customer.is_banned)


def ensure_customer_not_banned(account: Account) -> None:
    if is_customer_banned(account):
        raise HTTPException(status.HTTP_423_LOCKED, detail=customer_ban_payload(account))