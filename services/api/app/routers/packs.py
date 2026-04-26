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

    # Duplicate guard for paid kinds: refuse if a live pack already covers
    # this period for this workspace. Dismissed and failed rows don't block.
    if body.kind in ("close_pack", "ai_audit_pack"):
        existing = (
            sb.from_("packs").select("id, status")
            .eq("workspace_id", ctx.workspace_id)
            .eq("kind", body.kind)
            .eq("period_start", body.period_start.isoformat())
            .eq("period_end", body.period_end.isoformat())
            .in_("status", ["requested", "generating", "ready", "delivered"])
            .limit(1).execute()
        ).data or []
        if existing:
            kind_label = body.kind.replace("_", " ")
            raise HTTPException(
                409,
                f"A {kind_label} already exists for this period (status: {existing[0]['status']})",
            )

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
        .neq("status", "dismissed")
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


# ─── Internal: paid-pack generation kicked off by Stripe webhook ────


class GeneratePaidBody(BaseModel):
    pack_id: str


@router.post("/jobs/generate-pack-paid")
async def generate_pack_paid(body: GeneratePaidBody, request: Request):
    """Internal endpoint called by the Stripe webhook handler after a successful
    checkout. Authenticated via shared INTERNAL_SECRET, NOT a user JWT.

    The webhook flips status from 'requested' → 'generating' before invoking
    this. We validate that and then run generation. Returns 200 with
    `processed: false` if state is unexpected so Stripe doesn't retry-loop.
    """
    secret = os.environ.get("INTERNAL_SECRET", "")
    provided = request.headers.get("x-internal-secret", "")
    if not secret or provided != secret:
        raise HTTPException(401, "Invalid internal secret")

    sb = sb_service()
    pack = (
        sb.from_("packs")
        .select("id, status")
        .eq("id", body.pack_id)
        .single()
        .execute()
    ).data
    if not pack:
        raise HTTPException(404, "Pack not found")
    if pack["status"] != "generating":
        return {"processed": False, "reason": f"pack status is {pack['status']!r}"}

    generate_close_pack(body.pack_id)
    return {"processed": True, "pack_id": body.pack_id}


# ─── Retry: reset a failed paid pack so the user can re-purchase ────


@router.post("/packs/{pack_id}/retry")
async def retry_pack(pack_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    pack = (
        sb.from_("packs")
        .select("id, status")
        .eq("id", pack_id)
        .eq("workspace_id", ctx.workspace_id)
        .single()
        .execute()
    ).data
    if not pack:
        raise HTTPException(404, "Pack not found")
    if pack["status"] != "failed":
        raise HTTPException(409, f"Cannot retry pack in status {pack['status']!r}")

    sb.from_("packs").update({
        "status": "requested",
        "error_message": None,
    }).eq("id", pack_id).eq("workspace_id", ctx.workspace_id).execute()

    _audit(sb, ctx.workspace_id, ctx.user_id, "pack:retry", pack_id, {})
    return {"ok": True}


# ─── Dismiss: soft-cancel an unwanted 'requested' pack ───────────────


@router.post("/packs/{pack_id}/dismiss")
async def dismiss_pack(pack_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    """Soft-cancel a pack the user created but doesn't want to generate.
    Only 'requested' packs can be dismissed — anything past that has either
    consumed compute or, for paid kinds, been charged.
    """
    sb = sb_service()
    pack = (
        sb.from_("packs").select("id, kind, status, period_start, period_end")
        .eq("id", pack_id).eq("workspace_id", ctx.workspace_id)
        .single().execute()
    ).data
    if not pack:
        raise HTTPException(404, "Pack not found")
    if pack["status"] != "requested":
        raise HTTPException(409, f"Cannot dismiss pack in status {pack['status']!r}")

    sb.from_("packs").update({"status": "dismissed"}).eq("id", pack_id).eq("workspace_id", ctx.workspace_id).execute()
    _audit(sb, ctx.workspace_id, ctx.user_id, "pack:dismiss", pack_id, {
        "kind": pack["kind"], "period_start": pack["period_start"], "period_end": pack["period_end"],
    })
    return {"ok": True}


# ─── Design-partner shortcut: paid pack → generate without checkout ──


@router.post("/packs/{pack_id}/generate-now")
async def generate_pack_now(
    pack_id: str,
    background: BackgroundTasks,
    ctx: WorkspaceContext = Depends(require_role("admin")),
):
    """Design-partner-mode shortcut: generate a paid pack without going through
    Stripe checkout. Workspace-scoped, admin-only, only valid on 'requested'.
    """
    sb = sb_service()
    pack = (
        sb.from_("packs").select("id, status")
        .eq("id", pack_id).eq("workspace_id", ctx.workspace_id)
        .single().execute()
    ).data
    if not pack:
        raise HTTPException(404, "Pack not found")
    if pack["status"] != "requested":
        raise HTTPException(409, f"Cannot generate pack in status {pack['status']!r}")

    sb.from_("packs").update({"status": "generating"}).eq("id", pack_id).eq("workspace_id", ctx.workspace_id).execute()
    background.add_task(generate_close_pack, pack_id)
    _audit(sb, ctx.workspace_id, ctx.user_id, "pack:generate_now", pack_id, {"design_partner_mode": True})
    return {"ok": True}
