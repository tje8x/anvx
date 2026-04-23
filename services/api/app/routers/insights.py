from fastapi import APIRouter, Depends, Query

from ..auth import WorkspaceContext, require_role
from ..insights import generate_all

router = APIRouter()


@router.get("/insights")
async def get_insights(limit: int = Query(default=5, ge=1, le=50), ctx: WorkspaceContext = Depends(require_role("member"))):
    insights = generate_all(ctx.workspace_id)
    return [{"kind": i.kind.value, "headline": i.headline, "detail": i.detail, "value_cents": i.value_cents} for i in insights[:limit]]
