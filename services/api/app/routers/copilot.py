from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Literal

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


class RespondBody(BaseModel):
    response: Literal["approved", "overridden"]
    override_reason: str | None = None


@router.get("/copilot-approvals")
async def list_copilot_approvals(only_unresponded: bool = Query(default=True), ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    q = sb.from_("copilot_approvals").select("*").eq("workspace_id", ctx.workspace_id).order("created_at", desc=True).limit(50)
    if only_unresponded:
        q = q.is_("user_response", "null")
    result = q.execute()
    return result.data or []


@router.post("/copilot-approvals/{approval_id}/respond")
async def respond_copilot_approval(approval_id: str, body: RespondBody, ctx: WorkspaceContext = Depends(require_role("admin"))):
    if body.response == "overridden" and not body.override_reason:
        raise HTTPException(400, "override_reason is required when response is 'overridden'")

    sb = sb_service()
    now = datetime.now(timezone.utc).isoformat()
    result = sb.from_("copilot_approvals").update({"user_response": body.response, "responded_at": now, "responded_by_user_id": ctx.user_id, "override_reason": body.override_reason}).eq("id", approval_id).eq("workspace_id", ctx.workspace_id).is_("user_response", "null").execute()
    if not result.data:
        raise HTTPException(404, "No pending approval found with this ID")
    sb.from_("audit_log").insert({"workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id, "action": f"copilot_approval:{body.response}", "target_kind": "copilot_approval", "target_id": approval_id, "details": {"response": body.response, "override_reason": body.override_reason}}).execute()
    return {"ok": True}
