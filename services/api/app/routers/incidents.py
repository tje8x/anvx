from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..analytics import capture as analytics_capture
from ..auth import WorkspaceContext, require_role
from ..db import sb_service
from ..notifications.dispatch import dispatch_fire_and_forget

router = APIRouter()


class ResumeBody(BaseModel):
    note: str | None = None


@router.get("/incidents")
async def list_incidents(only_active: bool = Query(default=False), ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    q = sb.from_("incidents").select("*").eq("workspace_id", ctx.workspace_id).order("opened_at", desc=True).limit(20)
    if only_active:
        q = q.eq("status", "active")
    result = q.execute()
    return result.data or []


@router.post("/incidents/{incident_id}/resume")
async def resume_incident(incident_id: str, body: ResumeBody, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    now = datetime.now(timezone.utc).isoformat()
    result = sb.from_("incidents").update({"status": "resolved", "resumed_at": now, "resumed_by_user_id": ctx.user_id, "resume_note": body.note}).eq("id", incident_id).eq("workspace_id", ctx.workspace_id).eq("status", "active").execute()
    if not result.data:
        raise HTTPException(404, "No active incident found with this ID")
    sb.from_("audit_log").insert({"workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id, "action": "incident:resume", "target_kind": "incident", "target_id": incident_id, "details": {"note": body.note}}).execute()

    incident = (result.data or [{}])[0]
    dispatch_fire_and_forget("incident_resumed", ctx.workspace_id, {
        "incident_id": incident_id,
        "provider": incident.get("provider") or incident.get("scope_provider") or "routing",
        "note": body.note,
    })

    duration_minutes = 0
    opened_at = incident.get("opened_at")
    if opened_at:
        try:
            opened_dt = datetime.fromisoformat(str(opened_at).replace("Z", "+00:00"))
            duration_minutes = max(0, int((datetime.now(timezone.utc) - opened_dt).total_seconds() // 60))
        except Exception:
            pass
    analytics_capture(ctx.workspace_id, "incident_resumed", {"duration_minutes": duration_minutes})
    return {"ok": True}
