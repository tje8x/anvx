"""Lightweight health endpoint.

GET /api/health → 200 with { ok, service, db, ts }.

The endpoint never returns non-2xx based on DB state — if the SELECT 1 fails
or times out, we return 200 with `db: 'error'` so upstream load balancers and
status pages still report the service as up. This keeps a degraded-but-running
API from being yanked out of rotation.

DB probe is cached for 5 seconds in process memory so health pings do not turn
into a synthetic load source.
"""

from __future__ import annotations

import asyncio
import threading
import time
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Request, Response

from ..db import sb_service

router = APIRouter()

_DB_CACHE_TTL_S = 5.0
_DB_PROBE_TIMEOUT_S = 1.5

_cache_lock = threading.Lock()
_cache_state: dict[str, float | str] = {"status": "unknown", "expires_at": 0.0}


def _probe_db_sync() -> Literal["ok", "error"]:
    try:
        # Cheapest readable table — workspaces always exists post-migration.
        # `head=True` avoids transferring rows; `limit(1)` keeps the planner happy.
        sb_service().from_("workspaces").select("id", head=True, count=None).limit(1).execute()
        return "ok"
    except Exception:
        return "error"


async def _probe_db() -> Literal["ok", "error"]:
    now = time.monotonic()
    with _cache_lock:
        if _cache_state["expires_at"] > now and _cache_state["status"] in ("ok", "error"):
            return _cache_state["status"]  # type: ignore[return-value]

    try:
        status = await asyncio.wait_for(
            asyncio.to_thread(_probe_db_sync),
            timeout=_DB_PROBE_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        status = "error"
    except Exception:
        status = "error"

    with _cache_lock:
        _cache_state["status"] = status
        _cache_state["expires_at"] = now + _DB_CACHE_TTL_S
    return status


@router.get("/api/health")
async def health(response: Response) -> dict:
    db_status = await _probe_db()
    response.headers["Cache-Control"] = "public, max-age=5"
    return {
        "ok": True,
        "service": "api",
        "db": db_status,
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


# Explicit 405 for non-GET. FastAPI returns 405 by default for unmatched
# methods on an existing path, but we declare them so OpenAPI/clients see it.
@router.api_route("/api/health", methods=["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def health_method_not_allowed(request: Request) -> Response:  # noqa: ARG001
    return Response(
        content='{"ok":false,"error":"method_not_allowed"}',
        media_type="application/json",
        status_code=405,
        headers={"Allow": "GET"},
    )
