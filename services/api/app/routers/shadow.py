from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Literal

from ..auth import WorkspaceContext, require_role
from ..db import sb_service
from ..shadow import refresh_recommendations, list_for_workspace

router = APIRouter()


class RespondBody(BaseModel):
    response: Literal["accepted", "dismissed"]


@router.get("/shadow/recommendations")
async def get_shadow_recommendations(ctx: WorkspaceContext = Depends(require_role("member"))):
    refresh_recommendations(ctx.workspace_id)
    return list_for_workspace(ctx.workspace_id)


@router.post("/shadow/recommendations/{rec_id}/respond")
async def respond_to_recommendation(rec_id: str, body: RespondBody, ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()

    # Update the recommendation row
    sb.from_("shadow_recommendations").update({
        "user_response": body.response,
        "responded_at": datetime.now(timezone.utc).isoformat(),
        "responded_by_user_id": ctx.user_id,
    }).eq("id", rec_id).eq("workspace_id", ctx.workspace_id).execute()

    # Audit log
    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id,
        "actor_user_id": ctx.user_id,
        "action": f"shadow_recommendation:{body.response}",
        "target_kind": "shadow_recommendation",
        "target_id": rec_id,
        "details": {"response": body.response},
    }).execute()

    return {"ok": True}
