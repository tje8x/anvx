from fastapi import APIRouter, Depends

from ..auth import WorkspaceContext, require_role

router = APIRouter()


@router.get("/workspace/me")
async def workspace_me(
    ctx: WorkspaceContext = Depends(require_role("member")),
):
    return {
        "workspace_id": ctx.workspace_id,
        "user_id": ctx.user_id,
        "role": ctx.role,
        "email": ctx.email,
    }
