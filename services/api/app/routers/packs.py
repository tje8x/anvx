import os
from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel

from ..auth import WorkspaceContext, require_role
from ..db import sb_service
from ..packs.close_pack import generate_close_pack

router = APIRouter()

ALLOWED_KINDS = {"close_pack", "ai_audit_pack", "audit_trail_export"}
MAX_PERIOD_DAYS = 92


class PackRequest(BaseModel):
    kind: Literal["close_pack", "ai_audit_pack", "audit_trail_export"]
    period_start: date
    period_end: date


def _audit(sb, workspace_id: str, actor_user_id: str, action: str, target_id: str, details: dict | None = None):
    sb.from_("audit_log").insert({
        "workspace_id": workspace_id,
        "actor_user_id": actor_user_id,
        "action": action,
        "target_kind": "pack",
        "target_id": target_id,
        "details": details or {},
    }).execute()


def _lookup_price(sb, workspace_id: str, kind: str) -> int:
    workspace_row = (
        sb.from_("pack_prices").select("price_cents")
        .eq("workspace_id", workspace_id).eq("kind", kind).limit(1).execute()
    ).data or []
    if workspace_row:
        return int(workspace_row[0]["price_cents"])
    global_row = (
        sb.from_("pack_prices").select("price_cents")
        .is_("workspace_id", "null").eq("kind", kind).limit(1).execute()
    ).data or []
    if global_row:
        return int(global_row[0]["price_cents"])
    raise HTTPException(500, f"No price configured for kind={kind}")


@router.post("/packs")
async def create_pack(
    body: PackRequest,
    background: BackgroundTasks,
    ctx: WorkspaceContext = Depends(require_role("admin")),
):
    if body.kind not in ALLOWED_KINDS:
        raise HTTPException(400, f"Invalid kind {body.kind}")
    if body.period_end > date.today():
        raise HTTPException(400, "period_end must not be in the future")
    if body.period_start >= body.period_end:
        raise HTTPException(400, "period_start must be before period_end")
    if (body.period_end - body.period_start).days > MAX_PERIOD_DAYS:
        raise HTTPException(400, f"period must not exceed {MAX_PERIOD_DAYS} days")

    sb = sb_service()
    price_cents = _lookup_price(sb, ctx.workspace_id, body.kind)

    insert = (
        sb.from_("packs").insert({
            "workspace_id": ctx.workspace_id,
            "kind": body.kind,
            "period_start": body.period_start.isoformat(),
            "period_end": body.period_end.isoformat(),
            "status": "requested",
            "price_cents": price_cents,
            "requested_by_user_id": ctx.user_id,
        }).execute()
    )
    pack_row = insert.data[0] if insert.data else None
    if not pack_row:
        raise HTTPException(500, "Failed to create pack")

    _audit(sb, ctx.workspace_id, ctx.user_id, "pack:request", pack_row["id"], {
        "kind": body.kind, "period_start": body.period_start.isoformat(),
        "period_end": body.period_end.isoformat(), "price_cents": price_cents,
    })

    if price_cents == 0:
        background.add_task(generate_close_pack, pack_row["id"])

    # Return the latest row state (BackgroundTasks runs after the response)
    return pack_row


@router.get("/packs")
async def list_packs(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    rows = (
        sb.from_("packs")
        .select("*")
        .eq("workspace_id", ctx.workspace_id)
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    ).data or []
    return rows


@router.get("/packs/{pack_id}/download")
async def pack_download(pack_id: str, ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    pack = (
        sb.from_("packs").select("status, storage_path")
        .eq("id", pack_id).eq("workspace_id", ctx.workspace_id)
        .single().execute()
    ).data
    if not pack:
        raise HTTPException(404, "Pack not found")
    if pack.get("status") != "ready" or not pack.get("storage_path"):
        raise HTTPException(404, "Pack is not ready")

    try:
        signed = sb.storage.from_("packs").create_signed_url(pack["storage_path"], 300)
    except Exception as e:
        raise HTTPException(502, f"Failed to sign download URL: {e}")

    url = signed.get("signedURL") or signed.get("signed_url")
    if not url:
        raise HTTPException(502, "Storage did not return a signed URL")
    return {"url": url}


@router.post("/jobs/generate-pack")
async def cron_generate_pack(request: Request):
    secret = os.environ.get("CRON_SECRET", "")
    provided = request.headers.get("x-cron-secret", "")
    if not secret or provided != secret:
        raise HTTPException(401, "Invalid cron secret")

    sb = sb_service()
    candidate = (
        sb.from_("packs")
        .select("id")
        .eq("status", "requested")
        .eq("price_cents", 0)
        .order("created_at", desc=False)
        .limit(1)
        .execute()
    ).data or []

    if not candidate:
        return {"processed": False}

    pack_id = candidate[0]["id"]
    generate_close_pack(pack_id)
    return {"processed": True, "pack_id": pack_id}
