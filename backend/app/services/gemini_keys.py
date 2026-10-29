"""
Gemini API-key rotator.

A tiny in-process pool of Google AI Studio keys. When the active key fails
(429 quota, 5xx, or transport error) we mark it "cooling" for a short window
and move on to the next healthy key. When every key is cooling we still
return the least-recently-failed one so the caller gets a real error
instead of None.

Usage:
    from app.services.gemini_keys import key_pool
    key = key_pool.next()
    ...
    if status == 429: key_pool.mark_bad(key, cooldown=120)
    else:             key_pool.mark_good(key)
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import List

from app.core.config import settings


@dataclass
class _KeyState:
    key: str
    bad_until: float = 0.0          # epoch seconds; 0 = healthy
    last_failure: float = 0.0
    failures: int = 0


class _KeyPool:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._states: List[_KeyState] = []
        self._cursor: int = 0
        self._refresh_from_settings()

    def _refresh_from_settings(self) -> None:
        keys = settings.gemini_api_keys_list
        if not keys:
            self._states = []
            return
        # preserve existing health state for keys still present
        existing = {s.key: s for s in self._states}
        self._states = [existing.get(k, _KeyState(key=k)) for k in keys]
        if self._cursor >= len(self._states):
            self._cursor = 0

    def has_keys(self) -> bool:
        return bool(settings.gemini_api_keys_list)

    def next(self) -> str | None:
        """Return a healthy key (round-robin). Falls back to the
        least-recently-failed key if every key is currently cooling."""
        with self._lock:
            self._refresh_from_settings()
            if not self._states:
                return None
            now = time.time()
            n = len(self._states)
            for offset in range(n):
                idx = (self._cursor + offset) % n
                st = self._states[idx]
                if st.bad_until <= now:
                    self._cursor = (idx + 1) % n
                    return st.key
            # All cooling — pick the one whose cooldown ends soonest
            soonest = min(self._states, key=lambda s: s.bad_until)
            return soonest.key

    def mark_bad(self, key: str, cooldown: float = 120.0) -> None:
        if not key:
            return
        with self._lock:
            for st in self._states:
                if st.key == key:
                    st.bad_until = time.time() + cooldown
                    st.last_failure = time.time()
                    st.failures += 1
                    return

    def mark_good(self, key: str) -> None:
        if not key:
            return
        with self._lock:
            for st in self._states:
                if st.key == key:
                    st.bad_until = 0.0
                    return

    def snapshot(self) -> List[dict]:
        with self._lock:
            now = time.time()
            return [
                {
                    "key_tail": s.key[-6:],
                    "healthy": s.bad_until <= now,
                    "cooldown_seconds_left": max(0, int(s.bad_until - now)),
                    "failures": s.failures,
                }
                for s in self._states
            ]


key_pool = _KeyPool()
