from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query

from ..attribution import attribution_for_period
from ..auth import WorkspaceContext, require_role

router = APIRouter()

MAX_RANGE_DAYS = 366


@router.get("/attribution")
async def get_attribution(
    start: date = Query(..., description="period start (inclusive, YYYY-MM-DD)"),
    end: date = Query(..., description="period end (exclusive, YYYY-MM-DD)"),
    ctx: WorkspaceContext = Depends(require_role("member")),
):
    if not start < end:
        raise HTTPException(400, "start must be strictly before end")
    if (end - start).days > MAX_RANGE_DAYS:
        raise HTTPException(400, f"range may not exceed {MAX_RANGE_DAYS} days")

    return attribution_for_period(ctx.workspace_id, start, end)
