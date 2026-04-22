from fastapi import APIRouter, Depends

from ..auth import WorkspaceContext, require_role

router = APIRouter()


@router.get("/connectors")
async def list_connectors(
    ctx: WorkspaceContext = Depends(require_role("member")),
):
    return []
