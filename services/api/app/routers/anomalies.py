import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..auth import WorkspaceContext, require_role
from ..db import sb_service
from ..anomaly import run_for_all_workspaces

router = APIRouter()


@router.get("/anomalies")
async def list_anomalies(only_unacked: bool = Query(default=True), ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    q = sb.from_("anomalies").select("*").eq("workspace_id", ctx.workspace_id).order("created_at", desc=True).limit(50)
    if only_unacked:
        q = q.is_("acknowledged_at", "null")
    result = q.execute()
    return result.data or []


@router.post("/anomalies/{anomaly_id}/acknowledge")
async def acknowledge_anomaly(anomaly_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    now = datetime.now(timezone.utc).isoformat()
    sb.from_("anomalies").update({"acknowledged_at": now, "acknowledged_by_user_id": ctx.user_id}).eq("id", anomaly_id).eq("workspace_id", ctx.workspace_id).execute()
    sb.from_("audit_log").insert({"workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id, "action": "anomaly:acknowledge", "target_kind": "anomaly", "target_id": anomaly_id, "details": {}}).execute()
    return {"ok": True}


@router.post("/jobs/anomaly-scan")
async def anomaly_scan(request: Request):
    secret = os.environ.get("CRON_SECRET", "")
    provided = request.headers.get("x-cron-secret", "")
    if not secret or provided != secret:
        raise HTTPException(401, "Invalid cron secret")
    result = run_for_all_workspaces()
    return result
