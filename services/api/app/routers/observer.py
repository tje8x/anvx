from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Literal

from ..auth import WorkspaceContext, require_role
from ..db import sb_service
from ..observer import refresh_recommendations, list_for_workspace

router = APIRouter()


class RespondBody(BaseModel):
    response: Literal["accepted", "dismissed"]


@router.get("/observer/recommendations")
async def get_observer_recommendations(ctx: WorkspaceContext = Depends(require_role("member"))):
    try:
        refresh_recommendations(ctx.workspace_id)
    except Exception:
        pass  # Best-effort refresh — don't block the list
    return list_for_workspace(ctx.workspace_id)


@router.post("/observer/recommendations/{rec_id}/respond")
async def respond_to_recommendation(rec_id: str, body: RespondBody, ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()

    # Update the recommendation row
    sb.from_("observer_recommendations").update({
        "user_response": body.response,
        "responded_at": datetime.now(timezone.utc).isoformat(),
        "responded_by_user_id": ctx.user_id,
    }).eq("id", rec_id).eq("workspace_id", ctx.workspace_id).execute()

    # Audit log
    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id,
        "actor_user_id": ctx.user_id,
        "action": f"observer_recommendation:{body.response}",
        "target_kind": "observer_recommendation",
        "target_id": rec_id,
        "details": {"response": body.response},
    }).execute()

    return {"ok": True}
