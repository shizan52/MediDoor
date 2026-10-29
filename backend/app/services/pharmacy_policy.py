from __future__ import annotations

from fastapi import HTTPException, status

from app.models import Account, RoleEnum


def pharmacy_block_payload(account: Account) -> dict:
    pharmacy = account.pharmacy
    return {
        "code": "pharmacy_blocked",
        "message": (pharmacy.block_notice if pharmacy else None) or "MediDoor admin আপনার pharmacy account সাময়িকভাবে restricted করেছে।",
        "blocked_at": pharmacy.blocked_at.isoformat() if pharmacy and pharmacy.blocked_at else None,
        "blocked_by": pharmacy.blocked_by if pharmacy else None,
    }


def is_pharmacy_blocked(account: Account) -> bool:
    return account.role == RoleEnum.pharmacy and bool(account.pharmacy and account.pharmacy.is_blocked)


def ensure_pharmacy_not_blocked(account: Account) -> None:
    if is_pharmacy_blocked(account):
        raise HTTPException(status.HTTP_423_LOCKED, detail=pharmacy_block_payload(account))