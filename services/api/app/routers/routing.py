from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


@router.get("/routing/spend")
async def get_routing_spend(scope_provider: str | None = Query(default=None), scope_project_tag: str | None = Query(default=None), ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    now = datetime.now(timezone.utc)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()

    # Daily spend
    day_q = sb.from_("routing_usage_records").select("provider_cost_cents").eq("workspace_id", ctx.workspace_id).gte("created_at", day_start)
    if scope_provider:
        day_q = day_q.eq("provider", scope_provider)
    if scope_project_tag:
        day_q = day_q.eq("project_tag", scope_project_tag)
    day_res = day_q.execute()
    day_cents = sum(r.get("provider_cost_cents", 0) for r in (day_res.data or []))

    # Monthly spend
    month_q = sb.from_("routing_usage_records").select("provider_cost_cents").eq("workspace_id", ctx.workspace_id).gte("created_at", month_start)
    if scope_provider:
        month_q = month_q.eq("provider", scope_provider)
    if scope_project_tag:
        month_q = month_q.eq("project_tag", scope_project_tag)
    month_res = month_q.execute()
    month_cents = sum(r.get("provider_cost_cents", 0) for r in (month_res.data or []))

    return {"day_cents": day_cents, "month_cents": month_cents}
