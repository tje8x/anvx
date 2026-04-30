"""Optimization insight endpoints.

Surface the computed insight set to the Optimization tab UI. Insights are
persisted in `optimization_insights` so dismiss / add-to-pack survive page
reloads. The compute pass is triggered on the GET when the table is empty
or all rows for the workspace are expired — otherwise we serve cached.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..auth import WorkspaceContext, require_role
from ..db import sb_service
from ..optimization import OptimizationInsight, compute_insights

router = APIRouter()


def _ensure_workspace_match(workspace_id: str, ctx: WorkspaceContext) -> None:
    if workspace_id != ctx.workspace_id:
        raise HTTPException(403, "workspace mismatch")


def _row_to_insight(row: dict[str, Any]) -> dict[str, Any]:
    # Pass through; the front-end consumes the same shape Pydantic produces.
    return row


def _persist(workspace_id: str, insights: list[OptimizationInsight]) -> list[dict[str, Any]]:
    sb = sb_service()
    if not insights:
        return []
    rows = []
    for ins in insights:
        rows.append({
            "id": ins.id,
            "workspace_id": workspace_id,
            "type": ins.type,
            "title": ins.title,
            "impact": ins.impact,
            "impact_cents": ins.impact_cents,
            "description": ins.description,
            "provider": ins.provider,
            "action_type": ins.action_type,
            "action_label": ins.action_label,
            "action_payload": ins.action_payload,
            "generated_at": ins.generated_at.isoformat(),
            "expires_at": ins.expires_at.isoformat(),
        })
    sb.from_("optimization_insights").insert(rows).execute()
    return rows


def _fetch_active(workspace_id: str) -> list[dict[str, Any]]:
    sb = sb_service()
    now = datetime.now(timezone.utc).isoformat()
    res = (
        sb.from_("optimization_insights")
        .select("*")
        .eq("workspace_id", workspace_id)
        .is_("dismissed_at", "null")
        .gt("expires_at", now)
        .order("impact_cents", desc=True)
        .execute()
    )
    return res.data or []


@router.get("/workspaces/{workspace_id}/optimization-insights")
async def list_insights(
    workspace_id: str,
    ctx: WorkspaceContext = Depends(require_role("viewer")),
) -> dict[str, Any]:
    _ensure_workspace_match(workspace_id, ctx)
    rows = _fetch_active(workspace_id)
    if not rows:
        # No active insights — recompute on the spot so the page isn't empty
        # on first load. Subsequent loads use the cached set until expiry.
        insights = await compute_insights(workspace_id)
        _persist(workspace_id, insights)
        rows = _fetch_active(workspace_id)
    return {"insights": [_row_to_insight(r) for r in rows]}


@router.post("/workspaces/{workspace_id}/optimization-insights/{insight_id}/dismiss")
async def dismiss_insight(
    workspace_id: str,
    insight_id: str,
    ctx: WorkspaceContext = Depends(require_role("member")),
) -> dict[str, Any]:
    _ensure_workspace_match(workspace_id, ctx)
    sb = sb_service()
    now = datetime.now(timezone.utc).isoformat()
    res = (
        sb.from_("optimization_insights")
        .update({"dismissed_at": now})
        .eq("id", insight_id)
        .eq("workspace_id", workspace_id)
        .execute()
    )
    rows = res.data or []
    if not rows:
        raise HTTPException(404, "insight not found")
    return {"insight": rows[0]}


@router.post("/workspaces/{workspace_id}/optimization-insights/{insight_id}/add-to-pack")
async def add_to_pack(
    workspace_id: str,
    insight_id: str,
    ctx: WorkspaceContext = Depends(require_role("member")),
) -> dict[str, Any]:
    _ensure_workspace_match(workspace_id, ctx)
    sb = sb_service()
    now = datetime.now(timezone.utc).isoformat()
    res = (
        sb.from_("optimization_insights")
        .update({"added_to_pack_at": now})
        .eq("id", insight_id)
        .eq("workspace_id", workspace_id)
        .execute()
    )
    rows = res.data or []
    if not rows:
        raise HTTPException(404, "insight not found")
    return {"insight": rows[0]}


@router.post("/workspaces/{workspace_id}/optimization-insights/refresh")
async def refresh_insights(
    workspace_id: str,
    ctx: WorkspaceContext = Depends(require_role("member")),
) -> dict[str, Any]:
    _ensure_workspace_match(workspace_id, ctx)
    sb = sb_service()
    now = datetime.now(timezone.utc).isoformat()
    # Mark all currently-live (non-dismissed, non-expired) insights as expired
    # so the new compute pass replaces them cleanly. We don't delete — keeping
    # the history makes it easy to look back at what we suggested when.
    (
        sb.from_("optimization_insights")
        .update({"expires_at": now})
        .eq("workspace_id", workspace_id)
        .is_("dismissed_at", "null")
        .gt("expires_at", now)
        .execute()
    )
    insights = await compute_insights(workspace_id)
    _persist(workspace_id, insights)
    rows = _fetch_active(workspace_id)
    return {"insights": [_row_to_insight(r) for r in rows]}
