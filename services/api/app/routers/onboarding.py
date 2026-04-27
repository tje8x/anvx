"""Onboarding state endpoints.

Tracks where each workspace is in the 5-step onboarding flow. The
`onboarding_state` table is keyed by workspace_id and tracks the current step
plus a completion timestamp per step. The frontend reads `current_step` to
resume the flow if a user drops out mid-flow.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


def _ensure_state(sb, workspace_id: str) -> dict:
    rows = (
        sb.from_("onboarding_state").select("*")
        .eq("workspace_id", workspace_id).limit(1).execute()
    ).data or []
    if rows:
        return rows[0]
    insert = (
        sb.from_("onboarding_state").insert({
            "workspace_id": workspace_id, "current_step": 1,
        }).execute()
    )
    return (insert.data or [{"workspace_id": workspace_id, "current_step": 1}])[0]


@router.get("/onboarding/state")
async def get_state(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    return _ensure_state(sb, ctx.workspace_id)


class AdvanceBody(BaseModel):
    step: int = Field(ge=1, le=5)
    action: Literal["completed", "skipped"]
    ms_in_step: int | None = None


@router.post("/onboarding/advance")
async def advance(body: AdvanceBody, ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    state = _ensure_state(sb, ctx.workspace_id)

    now_iso = datetime.now(timezone.utc).isoformat()
    update: dict = {
        f"step_{body.step}_completed_at": now_iso,
        "updated_at": now_iso,
    }
    # Only advance forward — never regress on re-entry.
    next_step = body.step + 1
    if int(state.get("current_step") or 1) < next_step:
        update["current_step"] = next_step

    result = (
        sb.from_("onboarding_state").update(update)
        .eq("workspace_id", ctx.workspace_id).execute()
    )

    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id,
        "action": f"onboarding:step_{body.step}_{body.action}",
        "target_kind": "workspace", "target_id": ctx.workspace_id,
        "details": {"ms_in_step": body.ms_in_step},
    }).execute()

    return (result.data or [{}])[0]
