import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


class CreateTokenBody(BaseModel):
    label: str


def _audit(sb, workspace_id: str, actor_user_id: str, action: str, target_kind: str, target_id: str, details: dict | None = None):
    sb.from_("audit_log").insert({
        "workspace_id": workspace_id,
        "actor_user_id": actor_user_id,
        "action": action,
        "target_kind": target_kind,
        "target_id": target_id,
        "details": details or {},
    }).execute()


@router.post("/tokens")
async def create_token(body: CreateTokenBody, ctx: WorkspaceContext = Depends(require_role("admin"))):
    plaintext = "anvx_live_" + secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(plaintext.encode()).hexdigest()
    token_prefix = plaintext[:18]

    sb = sb_service()
    result = sb.from_("anvx_api_tokens").insert({
        "workspace_id": ctx.workspace_id,
        "label": body.label,
        "token_hash": token_hash,
        "token_prefix": token_prefix,
        "created_by_user_id": ctx.user_id,
    }).execute()

    row = result.data[0]
    _audit(sb, ctx.workspace_id, ctx.user_id, "token:create", "token", row["id"], {"label": body.label})

    return {"id": row["id"], "label": row["label"], "prefix": token_prefix, "created_at": row["created_at"], "plaintext": plaintext}


@router.get("/tokens")
async def list_tokens(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    result = sb.from_("anvx_api_tokens").select("id, label, token_prefix, created_at, last_used_at, revoked_at, created_by_user_id").eq("workspace_id", ctx.workspace_id).is_("revoked_at", "null").order("created_at", desc=True).execute()
    return [{"id": r["id"], "label": r["label"], "prefix": r["token_prefix"], "created_at": r["created_at"], "last_used_at": r.get("last_used_at"), "revoked_at": r.get("revoked_at"), "created_by_user_id": r["created_by_user_id"]} for r in (result.data or [])]


@router.post("/tokens/{token_id}/revoke")
async def revoke_token(token_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    now = datetime.now(timezone.utc).isoformat()
    sb.from_("anvx_api_tokens").update({"revoked_at": now}).eq("id", token_id).eq("workspace_id", ctx.workspace_id).execute()
    _audit(sb, ctx.workspace_id, ctx.user_id, "token:revoke", "token", token_id)
    return {"ok": True}
