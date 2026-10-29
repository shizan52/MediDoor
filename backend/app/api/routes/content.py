"""
Serves and updates the role-aware login page content (left pane).
The Tkinter `admin.py` app at the repo root edits the same JSON file.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, Body, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.api.routes.moderation import get_admin_account

router = APIRouter(prefix="/api/content", tags=["content"])

# Admin-managed content (login text, site/footer, medi-AI, CMS pages) must
# ALWAYS reflect the latest admin edit instantly on the public website. Mark
# every GET as no-store so no browser / CDN / proxy ever serves a stale copy.
_NO_STORE = "no-store, no-cache, must-revalidate, max-age=0"


def _no_cache(response: Response) -> None:
    response.headers["Cache-Control"] = _NO_STORE

CONTENT_FILE = Path(__file__).resolve().parents[3] / "content" / "login_content.json"
MEDI_AI_FILE = Path(__file__).resolve().parents[3] / "content" / "medi_ai.json"
SITE_FILE = Path(__file__).resolve().parents[3] / "content" / "site_content.json"
DOCS_FILE = Path(__file__).resolve().parents[3] / "content" / "documents.json"

VALID_KEYS = {"default", "customer", "pharmacy", "rider"}


class FeatureIn(BaseModel):
    icon: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=200)


class SectionIn(BaseModel):
    eyebrow: str = Field(min_length=1, max_length=80)
    title_top: str = Field(min_length=1, max_length=80)
    title_highlight: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=400)
    stat_value: str = Field(min_length=1, max_length=20)
    stat_label: str = Field(min_length=1, max_length=40)
    features: List[FeatureIn]


def _read() -> Dict[str, Any]:
    if not CONTENT_FILE.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Content file missing")
    return json.loads(CONTENT_FILE.read_text(encoding="utf-8"))


def _write(data: Dict[str, Any]) -> None:
    CONTENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONTENT_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


@router.get("/login")
async def get_login_content(response: Response) -> Dict[str, Any]:
    _no_cache(response)
    return _read()


@router.put("/login/{section}")
async def update_login_section(section: str, payload: SectionIn, _admin=Depends(get_admin_account)) -> Dict[str, Any]:
    if section not in VALID_KEYS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown section")
    data = _read()
    data[section] = payload.model_dump()
    _write(data)
    return data[section]


# --------------------------- Medi AI knowledge ---------------------------


class MediAIIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    system_prompt: str = Field(min_length=1, max_length=4000)
    knowledge: List[str] = Field(default_factory=list)


def _read_ai() -> Dict[str, Any]:
    if not MEDI_AI_FILE.exists():
        return {"name": "medi AI", "system_prompt": "", "knowledge": []}
    return json.loads(MEDI_AI_FILE.read_text(encoding="utf-8"))


def _write_ai(data: Dict[str, Any]) -> None:
    MEDI_AI_FILE.parent.mkdir(parents=True, exist_ok=True)
    MEDI_AI_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


@router.get("/medi-ai")
async def get_medi_ai(response: Response) -> Dict[str, Any]:
    _no_cache(response)
    return _read_ai()


@router.put("/medi-ai")
async def update_medi_ai(payload: MediAIIn, _admin=Depends(get_admin_account)) -> Dict[str, Any]:
    cleaned = [k.strip() for k in payload.knowledge if k and k.strip()]
    data = {
        "name": payload.name.strip(),
        "system_prompt": payload.system_prompt.strip(),
        "knowledge": cleaned,
    }
    _write_ai(data)
    return data


# --------------------------- Site content (banner / bot / footer) ----------


def _read_site() -> Dict[str, Any]:
    if not SITE_FILE.exists():
        return {"banner": {}, "bot": {}, "favicon": {}, "footer": {"columns": [], "socials": []}}
    return json.loads(SITE_FILE.read_text(encoding="utf-8"))


def _write_site(data: Dict[str, Any]) -> None:
    SITE_FILE.parent.mkdir(parents=True, exist_ok=True)
    SITE_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


@router.get("/site")
async def get_site_content(response: Response) -> Dict[str, Any]:
    _no_cache(response)
    return _read_site()


@router.put("/site")
async def update_site_content(payload: Dict[str, Any] = Body(...), _admin=Depends(get_admin_account)) -> Dict[str, Any]:
    # Permissive update — admin.py is the only client and it ships well-formed
    # JSON. We just guard top-level shape.
    safe = {
        "banner": dict(payload.get("banner") or {}),
        "bot": dict(payload.get("bot") or {}),
        "admin_support": dict(payload.get("admin_support") or {}),
        "favicon": dict(payload.get("favicon") or {}),
        "footer": dict(payload.get("footer") or {}),
        "pharmacy_notice": payload.get("pharmacy_notice") or "",
    }
    _write_site(safe)
    return safe


# --------------------------- Footer documents (rich pages) ----------------
# CMS-style pages reachable at /p/<slug> on the website. Each document is an
# ordered list of styled blocks (heading / text / image / divider). GET is
# public (the website renders it); the bulk PUT is admin-gated.

def _read_docs() -> List[Dict[str, Any]]:
    if not DOCS_FILE.exists():
        return []
    try:
        data = json.loads(DOCS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _write_docs(data: List[Dict[str, Any]]) -> None:
    DOCS_FILE.parent.mkdir(parents=True, exist_ok=True)
    DOCS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


@router.get("/documents")
async def list_documents(response: Response) -> List[Dict[str, Any]]:
    """All documents, ordered. Public (website + admin both read this)."""
    _no_cache(response)
    docs = _read_docs()
    docs.sort(key=lambda d: (d.get("order", 9999), d.get("title", "")))
    return docs


@router.get("/documents/{slug}")
async def get_document(slug: str, response: Response) -> Dict[str, Any]:
    _no_cache(response)
    for d in _read_docs():
        if d.get("slug") == slug:
            return d
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")


@router.put("/documents")
async def update_documents(
    payload: List[Dict[str, Any]] = Body(...),
    _admin=Depends(get_admin_account),
) -> Dict[str, Any]:
    """Replace the whole documents list. Admin-gated (the web console sends a
    bearer token)."""
    cleaned: List[Dict[str, Any]] = []
    for i, raw in enumerate(payload or []):
        slug = str(raw.get("slug") or "").strip().lower().replace(" ", "-")
        if not slug:
            continue
        cleaned.append({
            "slug": slug,
            "title": str(raw.get("title") or "").strip() or slug,
            "subtitle": str(raw.get("subtitle") or ""),
            "updated": str(raw.get("updated") or ""),
            "order": int(raw.get("order", i)),
            "visible": bool(raw.get("visible", True)),
            "blocks": list(raw.get("blocks") or []),
        })
    _write_docs(cleaned)
    return {"ok": True, "count": len(cleaned)}
