from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Literal

from ..auth import WorkspaceContext, require_role
from ..db import sb_service
from ..shadow import list_shadow_recommendations

router = APIRouter()


class RespondBody(BaseModel):
    response: Literal["accepted", "dismissed"]


@router.get("/shadow/recommendations")
async def get_shadow_recommendations(ctx: WorkspaceContext = Depends(require_role("member"))):
    recs = list_shadow_recommendations(ctx.workspace_id)
    return [{"id": r.id, "kind": r.kind.value, "headline": r.headline, "detail": r.detail, "savings_cents": r.savings_cents, "metadata": r.metadata} for r in recs]


@router.post("/shadow/recommendations/{rec_id}/respond")
async def respond_to_recommendation(rec_id: str, body: RespondBody, ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id,
        "actor_user_id": ctx.user_id,
        "action": f"shadow_recommendation:{body.response}",
        "target_kind": "shadow_recommendation",
        "target_id": rec_id,
        "details": {"response": body.response},
    }).execute()
    return {"ok": True}
