from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Literal

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


class WorkspaceUpdate(BaseModel):
    routing_mode: Literal["shadow", "copilot", "autopilot"]


@router.get("/workspace/me")
async def workspace_me(ctx: WorkspaceContext = Depends(require_role("member"))):
    return {"workspace_id": ctx.workspace_id, "user_id": ctx.user_id, "role": ctx.role, "email": ctx.email}


@router.patch("/workspace/me")
async def update_workspace(body: WorkspaceUpdate, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    sb.from_("workspaces").update({"routing_mode": body.routing_mode}).eq("id", ctx.workspace_id).execute()
    sb.from_("audit_log").insert({"workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id, "action": "workspace:update", "target_kind": "workspace", "target_id": ctx.workspace_id, "details": {"routing_mode": body.routing_mode}}).execute()
    return {"ok": True, "routing_mode": body.routing_mode}
