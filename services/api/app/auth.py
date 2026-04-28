"""Shared auth + RBAC dependency for FastAPI routes.

Verifies Clerk-issued JWTs against Clerk's JWKS endpoint. Expected claim shape:
- sub: Clerk user id (e.g. "user_2abc...")
- o:   active organization. Either { id: "org_..." } or the bare id string.
       (Some Clerk templates surface it as top-level `org_id` instead.)
- email: user email (optional)

If no org is present in the token, we fall back to a single-workspace lookup
for the user — useful when an active org hasn't been selected yet but the
user only belongs to one workspace.

Every protected route in services/api/ uses Depends(require_role("member")) or higher.
"""
from __future__ import annotations

import time
from typing import Any, Literal

import jwt
from fastapi import Depends, HTTPException, Request
from jwt import PyJWKClient
from pydantic import BaseModel

import structlog

from .settings import settings

Role = Literal["owner", "admin", "member", "viewer", "accountant_viewer"]
ROLE_RANK = {
    "owner": 5,
    "admin": 4,
    "member": 3,
    "viewer": 2,
    "accountant_viewer": 1,
}


class WorkspaceContext(BaseModel):
    user_id: str          # DB users.id (uuid)
    clerk_user_id: str
    workspace_id: str     # DB workspaces.id (uuid)
    clerk_org_id: str
    role: Role
    email: str


# ── JWKS client cache ──────────────────────────────────────────────
# PyJWKClient does its own per-process JWKS caching; we refresh the
# client object hourly as a belt-and-suspenders against stale state.

_JWKS_TTL_S = 3600.0
_jwks_client: PyJWKClient | None = None
_jwks_loaded_at: float = 0.0


def _get_jwks_client() -> PyJWKClient:
    global _jwks_client, _jwks_loaded_at
    now = time.time()
    if _jwks_client is None or (now - _jwks_loaded_at) > _JWKS_TTL_S:
        _jwks_client = PyJWKClient(
            settings.clerk_jwks_url,
            cache_jwk_set=True,
            lifespan=int(_JWKS_TTL_S),
        )
        _jwks_loaded_at = now
    return _jwks_client


async def _verify_jwt(request: Request) -> dict[str, Any]:
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = auth_header.removeprefix("Bearer ")

    try:
        client = _get_jwks_client()
        signing_key = client.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            # Clerk session JWTs don't carry a fixed `aud` value across templates.
            options={"verify_aud": False},
        )
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Invalid token: {e}")
    return claims


def _extract_org_id(claims: dict[str, Any]) -> str | None:
    """Pull the active Clerk org id from a JWT, tolerating multiple shapes."""
    o = claims.get("o")
    if isinstance(o, dict):
        v = o.get("id")
        if isinstance(v, str) and v:
            return v
    if isinstance(o, str) and o:
        return o
    for k in ("org_id", "workspace_id", "active_organization_id"):
        v = claims.get(k)
        if isinstance(v, str) and v:
            return v
    return None


async def get_context(request: Request) -> WorkspaceContext:
    claims = await _verify_jwt(request)

    clerk_user_id = claims.get("sub")
    if not clerk_user_id or not isinstance(clerk_user_id, str):
        raise HTTPException(401, "Token missing 'sub' claim")

    clerk_org_id = _extract_org_id(claims)

    from app.db import resolve_workspace_member, resolve_single_workspace_for_user

    row: dict | None = None
    if clerk_org_id:
        row = await resolve_workspace_member(clerk_user_id, clerk_org_id)
    if not row:
        # Fallback: if the user belongs to exactly one workspace, use it.
        single = await resolve_single_workspace_for_user(clerk_user_id)
        if single:
            clerk_org_id = single["clerk_org_id"]
            row = single

    if not row:
        raise HTTPException(403, "User is not a member of this workspace")

    ctx = WorkspaceContext(
        user_id=row["user_id"],
        clerk_user_id=clerk_user_id,
        workspace_id=row["workspace_id"],
        clerk_org_id=clerk_org_id or "",
        role=row["role"],
        email=str(claims.get("email") or claims.get("primary_email") or ""),
    )

    structlog.contextvars.bind_contextvars(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
    )

    try:
        import sentry_sdk
        sentry_sdk.set_tag("workspace_id", ctx.workspace_id)
        req_id = request.headers.get("x-request-id")
        if req_id:
            sentry_sdk.set_tag("request_id", req_id)
            sentry_sdk.set_extra("request_id", req_id)
    except Exception:
        pass

    return ctx


def require_role(min_role: Role):
    """FastAPI dependency: enforces the caller has at least min_role."""
    async def _checker(ctx: WorkspaceContext = Depends(get_context)) -> WorkspaceContext:
        if ROLE_RANK[ctx.role] < ROLE_RANK[min_role]:
            raise HTTPException(403, f"Requires role >= {min_role}, have {ctx.role}")
        return ctx
    return _checker
