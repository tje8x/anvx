"""PostHog server-side capture for FastAPI surfaces.

Mirrors apps/web/src/lib/analytics/server.ts on the Python side.
NEVER captures: API keys, raw prompts, response bodies, transaction
descriptions, document contents.
"""
from __future__ import annotations

import os
from typing import Any

try:
    from posthog import Posthog  # type: ignore
except ImportError:  # pragma: no cover
    Posthog = None  # type: ignore


_client: Any = None


def _get_client() -> Any:
    global _client
    api_key = os.getenv("POSTHOG_KEY")
    if not api_key or Posthog is None:
        return None
    if _client is None:
        _client = Posthog(
            project_api_key=api_key,
            host=os.getenv("POSTHOG_HOST", "https://us.i.posthog.com"),
            sync_mode=True,  # serverless: ship per-event, no background flusher
        )
    return _client


def capture(distinct_id: str, event: str, properties: dict[str, Any] | None = None) -> None:
    """Best-effort capture. Never raises."""
    c = _get_client()
    if c is None:
        return
    try:
        c.capture(distinct_id=distinct_id, event=event, properties=properties or {})
    except Exception:
        pass


def shutdown() -> None:
    if _client is not None:
        try:
            _client.shutdown()
        except Exception:
            pass
