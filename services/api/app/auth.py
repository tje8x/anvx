"""
Shared auth + RBAC dependency for FastAPI routes.

Every protected route in services/api/ uses Depends(require_role("member")) or higher. Never skip this.
"""
from typing import Literal
from fastapi import Depends, HTTPException, Request
from jose import jwt, JWTError
from pydantic import BaseModel
import os

import structlog

Role = Literal["owner", "admin", "member", "viewer", "accountant_viewer"]
ROLE_RANK = {
    "owner": 5,
    "admin": 4,
    "member": 3,
    "viewer": 2,
    "accountant_viewer": 1,
}

SUPABASE_JWT_SECRET = os.environ["SUPABASE_JWT_SECRET"]

SUPABASE_JWT_AUD = "authenticated"

class WorkspaceContext(BaseModel):
	user_id: str				# DB users.id (uuid)
	clerk_user_id: str
	workspace_id: str		# DB workspaces.id (uuid)
	clerk_org_id: str
	role: Role
	email: str

async def _verify_jwt(request: Request) -> dict:
	auth_header = request.headers.get("authorization", "")
	if not auth_header.startswith("Bearer "):
		raise HTTPException(401, "Missing bearer token")
	token = auth_header.removeprefix("Bearer ")
	try:
		claims = jwt.decode(
			token,
			SUPABASE_JWT_SECRET,
			algorithms=["HS256"],
			audience=SUPABASE_JWT_AUD,
		)
	except JWTError as e:
		raise HTTPException(401, f"Invalid token: {e}")
	return claims


async def get_context(request: Request) -> WorkspaceContext:
	claims = await _verify_jwt(request)
	clerk_user_id = claims.get("user_id")
	clerk_org_id = claims.get("workspace_id")
	if not clerk_user_id or not clerk_org_id:
		raise HTTPException(403, "Token missing user or workspace claim")
	# Resolve DB ids + role via Supabase (see services/api/app/db.py; added Day 6)
	from app.db import resolve_workspace_member
	row = await resolve_workspace_member(clerk_user_id, clerk_org_id)
	if not row:
		raise HTTPException(403, "User is not a member of this workspace")

	ctx = WorkspaceContext(
		user_id=row["user_id"],
		clerk_user_id=clerk_user_id,
		workspace_id=row["workspace_id"],
		clerk_org_id=clerk_org_id,
		role=row["role"],
		email=claims.get("email", ""),
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
