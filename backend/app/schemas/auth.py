from datetime import date
from typing import Literal, Optional

from pydantic import BaseModel, EmailStr, Field, model_validator

Role = Literal["customer", "pharmacy", "rider"]


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class MeResponse(BaseModel):
    account_id: str
    gmail: EmailStr
    role: Role
    is_registered: bool
    profile: Optional[dict] = None


# ---------- Registration payloads (one per role) ----------


class CustomerRegister(BaseModel):
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    phone_number: str = Field(min_length=6, max_length=20)
    date_of_birth: Optional[date] = None
    gender: Optional[Literal["male", "female", "other"]] = None
    profile_photo_url: Optional[str] = None


class CustomerProfileUpdate(BaseModel):
    first_name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    last_name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    phone_number: Optional[str] = Field(default=None, min_length=6, max_length=20)
    date_of_birth: Optional[date] = None
    gender: Optional[Literal["male", "female", "other"]] = None
    profile_photo_url: Optional[str] = Field(default=None, max_length=500)


class RiderProfileUpdate(BaseModel):
    """Post-registration self-service edits — safe fields only.

    Identity documents (NID / birth certificate) intentionally excluded:
    changing those must go through admin re-verification, not a self PATCH.
    """

    nick_name: Optional[str] = Field(default=None, max_length=80)
    phone_number: Optional[str] = Field(default=None, min_length=6, max_length=20)
    profile_photo_url: Optional[str] = Field(default=None, max_length=500)


class PharmacyRegister(BaseModel):
    pharmacy_name: str = Field(min_length=1, max_length=160)
    owner_name: str = Field(min_length=1, max_length=160)
    business_name: str = Field(min_length=1, max_length=160)
    pharmacy_license_no: str = Field(min_length=1, max_length=120)
    # Registered pharmacist (DGDA "drug seller") — mandatory for legal
    # operation. The platform verifies these against the registry's
    # drug_seller_name + drug_seller_code.
    pharmacist_name: str = Field(min_length=1, max_length=160)
    pharmacist_reg_no: str = Field(min_length=1, max_length=60)
    pharmacy_license_doc_url: Optional[str] = None
    banner_photo_url: Optional[str] = None


class RiderRegister(BaseModel):
    """Rider self-registration payload.

    `phone_number` is treated as the rider's WhatsApp number (single contact
    channel — the UI is labelled accordingly).

    Identity documents are EITHER:
      • NID  → `nid_number` + `nid_front_url` + `nid_back_url`  (all three),
      • OR Birth-certificate → `birth_certificate_url` AND `student_id_card_url`
        (both — student ID is mandatory when the rider can't supply a NID,
        per platform policy for under-NID-age applicants).

    The rule is enforced in :meth:`_check_documents` so an admin verifying a
    rider in `admin.py` can trust the data is internally consistent.
    """

    full_name: str = Field(min_length=1, max_length=160)
    nick_name: Optional[str] = Field(default=None, max_length=80)
    phone_number: str = Field(min_length=6, max_length=20)
    age: int = Field(ge=15, le=80)

    # NID path
    nid_number: Optional[str] = Field(default=None, min_length=5, max_length=40)
    nid_front_url: Optional[str] = None
    nid_back_url: Optional[str] = None

    # Birth-certificate fallback (must be paired with a student ID)
    birth_certificate_url: Optional[str] = None
    student_id_card_url: Optional[str] = None

    profile_photo_url: Optional[str] = None

    @model_validator(mode="after")
    def _check_documents(self) -> "RiderRegister":
        nid_complete = bool(
            (self.nid_number or "").strip()
            and (self.nid_front_url or "").strip()
            and (self.nid_back_url or "").strip()
        )
        birth_complete = bool(
            (self.birth_certificate_url or "").strip()
            and (self.student_id_card_url or "").strip()
        )
        if not (nid_complete or birth_complete):
            raise ValueError(
                "Either complete NID (number + front + back) OR both "
                "birth-certificate photo AND student-ID photo are required."
            )
        return self
