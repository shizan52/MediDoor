"""Shared path/env bootstrap for every script under tools/tests/.

Before this existed each test hand-rolled its own `sys.path.insert(...)` and
`Path(__file__).parents[N]` arithmetic — which silently broke the moment the
files moved, and one of them even hard-coded an `h:\\MediDoor\\backend` that no
longer exists. Import this first instead:

    from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS   # noqa: F401

It is import-safe and idempotent:
  * puts `backend/` on sys.path so `import app...` works from any cwd,
  * forces UTF-8 stdout (Windows consoles are cp1252 and choke on ✓/Bengali),
  * gives every test the same repo-relative paths.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# tools/tests/_bootstrap.py -> tools/tests -> tools -> <repo root>
ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
DB_PATH = BACKEND / "medidoor.db"
ASSETS = ROOT / "assets"

if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

# Tests may import app.core.config, which requires a SECRET_KEY.
os.environ.setdefault("SECRET_KEY", "tools-tests-bootstrap-key")

# Windows consoles default to cp1252 and cannot print ✓ or Bengali text.
# Use reconfigure() rather than wrapping sys.stdout.buffer in a fresh
# TextIOWrapper: a second wrapper leaves the first one unreferenced, and when
# the GC finalises it the shared buffer is closed underneath us
# ("ValueError: I/O operation on closed file" mid-test).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # not a real stream (piped/captured)
        pass

__all__ = ["ROOT", "BACKEND", "DB_PATH", "ASSETS"]
