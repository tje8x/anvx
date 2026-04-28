import asyncio
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

from fastapi import APIRouter, Depends, HTTPException
from jinja2 import Environment, FileSystemLoader, select_autoescape
from pydantic import BaseModel, EmailStr, Field

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


# ─── Invitation email helper ──────────────────────────────────────────────

_ROLE_LABELS = {
    "admin": "Admin",
    "member": "Member",
    "viewer": "Viewer",
    "accountant_viewer": "Accountant",
}


def _send_invitation_email(sb, ctx: WorkspaceContext, invite_row: dict, body) -> None:
    """Render and dispatch the invitation email asynchronously. Failures land
    on the notification_events row's email_error column; never raises into the
    caller (so invite creation succeeds even if email is misconfigured).
    """
    template_dir = Path(__file__).resolve().parent.parent / "notifications" / "templates"
    env = Environment(loader=FileSystemLoader(str(template_dir)), autoescape=select_autoescape(["html"]))
    ws = (sb.from_("workspaces").select("name").eq("id", ctx.workspace_id).single().execute()).data or {}
    ws_name = ws.get("name") or "ANVX workspace"

    ctx_vars = {
        "workspace_id": ctx.workspace_id,
        "workspace_name": ws_name,
        "inviter_name": ctx.email or "A teammate",
        "role": body.role,
        "role_label": _ROLE_LABELS.get(body.role, body.role),
        "invitation_id": invite_row["id"],
    }

    try:
        text = env.get_template("workspace_invitation.txt").render(**ctx_vars)
        html = env.get_template("workspace_invitation.html").render(**ctx_vars)
        subject = (text.splitlines()[0] if text.splitlines() else "ANVX workspace invitation")[:200]
    except Exception as e:
        # Render error — record but don't block invite creation.
        try:
            sb.from_("notification_events").insert({
                "workspace_id": ctx.workspace_id,
                "kind": "workspace_invitation",
                "payload": ctx_vars,
                "email_error": f"template render failed: {e}"[:300],
            }).execute()
        except Exception:
            pass
        return

    # Record an event row up-front so delivery state has a place to land.
    ev_id = None
    try:
        ev_insert = sb.from_("notification_events").insert({
            "workspace_id": ctx.workspace_id,
            "kind": "workspace_invitation",
            "payload": ctx_vars,
        }).execute()
        ev_id = ((ev_insert.data or [None])[0] or {}).get("id")
    except Exception:
        # If the kind isn't yet allowed by the CHECK constraint, the insert
        # will fail. Fall through and still attempt to send the email.
        pass

    async def _send() -> None:
        try:
            from ..notifications.email import send_email
            await send_email(body.email, subject, text, html)
            if ev_id:
                sb.from_("notification_events").update({
                    "delivered_email_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", ev_id).execute()
        except Exception as e:
            if ev_id:
                try:
                    sb.from_("notification_events").update({
                        "email_error": str(e)[:300],
                    }).eq("id", ev_id).execute()
                except Exception:
                    pass

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_send())
    except RuntimeError:
        threading.Thread(target=lambda: asyncio.run(_send()), daemon=True).start()


# ─── Existing routing-mode update (kept for backward compat) ──────────────


class WorkspaceUpdate(BaseModel):
    routing_mode: Literal["observer", "copilot", "autopilot"]


@router.get("/workspace/me")
async def workspace_me(ctx: WorkspaceContext = Depends(require_role("accountant_viewer"))):
    sb = sb_service()
    ws = (
        sb.from_("workspaces")
        .select("id, name, slug, timezone, fiscal_year_start_month, default_currency, copilot_approvers, slack_webhook_url, notification_email, autopilot_digest, routing_mode, handoff_schedule, handoff_email, handoff_format")
        .eq("id", ctx.workspace_id).single().execute()
    ).data or {}
    return {
        "workspace_id": ctx.workspace_id,
        "user_id": ctx.user_id,
        "role": ctx.role,
        "email": ctx.email,
        **{k: v for k, v in ws.items() if k != "id"},
    }


@router.patch("/workspace/me")
async def update_workspace(body: WorkspaceUpdate, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    sb.from_("workspaces").update({"routing_mode": body.routing_mode}).eq("id", ctx.workspace_id).execute()
    sb.from_("audit_log").insert({"workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id, "action": "workspace:update", "target_kind": "workspace", "target_id": ctx.workspace_id, "details": {"routing_mode": body.routing_mode}}).execute()
    return {"ok": True, "routing_mode": body.routing_mode}


# ─── General settings (Settings → General) ────────────────────────────────


class GeneralSettingsBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    timezone: str | None = None
    fiscal_year_start_month: int | None = Field(default=None, ge=1, le=12)
    default_currency: str | None = None
    copilot_approvers: Literal["admins_only", "admins_and_members"] | None = None
    handoff_schedule: Literal["1st", "last", "custom", "disabled"] | None = None
    handoff_email: str | None = None
    handoff_format: Literal["pdf_csv", "pdf_only", "csv_only"] | None = None


@router.patch("/workspace/settings")
async def patch_workspace_settings(body: GeneralSettingsBody, ctx: WorkspaceContext = Depends(require_role("admin"))):
    raw = body.dict(exclude_unset=True)

    if "handoff_email" in raw:
        e = raw["handoff_email"]
        if e is not None and e != "" and not _EMAIL_RE.match(e):
            raise HTTPException(400, "invalid email format")

    update: dict = {}
    for k, v in raw.items():
        if k == "handoff_email":
            update[k] = None if (v is None or v == "") else v
        elif v is not None:
            update[k] = v
    if not update:
        raise HTTPException(400, "no fields provided")
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    sb = sb_service()
    result = (
        sb.from_("workspaces").update(update).eq("id", ctx.workspace_id).execute()
    )
    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id,
        "action": "workspace:settings_update", "target_kind": "workspace",
        "target_id": ctx.workspace_id, "details": {"changes": update},
    }).execute()
    return (result.data or [{}])[0]


# ─── Team / membership listing ────────────────────────────────────────────


@router.get("/workspace/members")
async def list_members(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    members = (
        sb.from_("workspace_members")
        .select("user_id, role, created_at, users(id, email, display_name, avatar_url)")
        .eq("workspace_id", ctx.workspace_id)
        .execute()
    ).data or []
    out = []
    for m in members:
        user = m.get("users") or {}
        out.append({
            "user_id": m["user_id"],
            "role": m["role"],
            "created_at": m.get("created_at"),
            "email": user.get("email"),
            "display_name": user.get("display_name"),
            "avatar_url": user.get("avatar_url"),
        })
    return out


class MemberRoleUpdate(BaseModel):
    role: Literal["admin", "member", "viewer", "accountant_viewer"]


@router.patch("/workspace/members/{user_id}")
async def update_member_role(user_id: str, body: MemberRoleUpdate, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    ws = (sb.from_("workspaces").select("owner_user_id").eq("id", ctx.workspace_id).single().execute()).data or {}
    if ws.get("owner_user_id") == user_id and body.role != "admin":
        raise HTTPException(409, "Cannot demote the workspace owner")

    result = (
        sb.from_("workspace_members").update({"role": body.role})
        .eq("workspace_id", ctx.workspace_id).eq("user_id", user_id)
        .execute()
    )
    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id,
        "action": "workspace:member_role_update", "target_kind": "user",
        "target_id": user_id, "details": {"new_role": body.role},
    }).execute()
    return (result.data or [{}])[0]


@router.delete("/workspace/members/{user_id}")
async def remove_member(user_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    ws = (sb.from_("workspaces").select("owner_user_id").eq("id", ctx.workspace_id).single().execute()).data or {}
    if ws.get("owner_user_id") == user_id:
        raise HTTPException(409, "Cannot remove the workspace owner")
    sb.from_("workspace_members").delete().eq("workspace_id", ctx.workspace_id).eq("user_id", user_id).execute()
    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id,
        "action": "workspace:member_remove", "target_kind": "user",
        "target_id": user_id, "details": {},
    }).execute()
    return {"ok": True}


# ─── Invitations ─────────────────────────────────────────────────────────


class InvitationCreate(BaseModel):
    email: EmailStr
    role: Literal["admin", "member", "viewer", "accountant_viewer"]


@router.get("/workspace/invitations")
async def list_invitations(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    rows = (
        sb.from_("workspace_invitations")
        .select("id, email, role, status, created_at, expires_at, invited_by")
        .eq("workspace_id", ctx.workspace_id)
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    ).data or []
    return rows


@router.post("/workspace/invitations")
async def create_invitation(body: InvitationCreate, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    existing = (
        sb.from_("workspace_invitations")
        .select("id, status")
        .eq("workspace_id", ctx.workspace_id)
        .eq("email", body.email)
        .eq("status", "pending")
        .limit(1).execute()
    ).data or []
    if existing:
        raise HTTPException(409, f"A pending invitation already exists for {body.email}")

    insert = sb.from_("workspace_invitations").insert({
        "workspace_id": ctx.workspace_id,
        "email": body.email,
        "role": body.role,
        "invited_by": ctx.user_id,
    }).execute()
    row = (insert.data or [None])[0]
    if not row:
        raise HTTPException(500, "Failed to create invitation")

    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id,
        "action": "workspace:invitation_create", "target_kind": "invitation",
        "target_id": row["id"], "details": {"email": body.email, "role": body.role},
    }).execute()

    _send_invitation_email(sb, ctx, row, body)
    return row


@router.delete("/workspace/invitations/{invitation_id}")
async def revoke_invitation(invitation_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    sb.from_("workspace_invitations").update({"status": "expired"}).eq("id", invitation_id).eq("workspace_id", ctx.workspace_id).execute()
    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id,
        "action": "workspace:invitation_revoke", "target_kind": "invitation",
        "target_id": invitation_id, "details": {},
    }).execute()
    return {"ok": True}


# ─── Notification preferences (event matrix) ──────────────────────────────


EVENT_TYPES = [
    "circuit_breaker", "budget_warning", "copilot_approval_request",
    "autopilot_optimization", "close_pack_ready", "runway_alert",
]


def _ensure_default_prefs(sb, workspace_id: str) -> list[dict]:
    rows = (
        sb.from_("notification_preferences").select("*")
        .eq("workspace_id", workspace_id).execute()
    ).data or []
    existing_kinds = {r["event_type"] for r in rows}
    missing = [k for k in EVENT_TYPES if k not in existing_kinds]
    if missing:
        sb.from_("notification_preferences").insert([
            {"workspace_id": workspace_id, "event_type": k} for k in missing
        ]).execute()
        rows = (
            sb.from_("notification_preferences").select("*")
            .eq("workspace_id", workspace_id).execute()
        ).data or []
    return rows


class NotifPrefsUpdate(BaseModel):
    preferences: list[dict]
    slack_webhook_url: str | None = None
    notification_email: str | None = None
    autopilot_digest: Literal["per_event", "daily", "weekly"] | None = None


@router.get("/workspace/notification-preferences")
async def get_notif_prefs(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    prefs = _ensure_default_prefs(sb, ctx.workspace_id)
    ws = (
        sb.from_("workspaces")
        .select("slack_webhook_url, notification_email, autopilot_digest")
        .eq("id", ctx.workspace_id).single().execute()
    ).data or {}
    return {"preferences": prefs, **ws}


@router.patch("/workspace/notification-preferences")
async def patch_notif_prefs(body: NotifPrefsUpdate, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    _ensure_default_prefs(sb, ctx.workspace_id)
    for p in body.preferences:
        kind = p.get("event_type")
        if kind not in EVENT_TYPES:
            continue
        update = {}
        if "email_enabled" in p:
            update["email_enabled"] = bool(p["email_enabled"])
        if "slack_enabled" in p:
            update["slack_enabled"] = bool(p["slack_enabled"])
        if update:
            sb.from_("notification_preferences").update(update).eq(
                "workspace_id", ctx.workspace_id
            ).eq("event_type", kind).execute()

    ws_update: dict = {}
    if body.slack_webhook_url is not None:
        ws_update["slack_webhook_url"] = body.slack_webhook_url or None
    if body.notification_email is not None:
        ws_update["notification_email"] = body.notification_email or None
    if body.autopilot_digest is not None:
        ws_update["autopilot_digest"] = body.autopilot_digest
    if ws_update:
        sb.from_("workspaces").update(ws_update).eq("id", ctx.workspace_id).execute()

    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id,
        "action": "workspace:notif_prefs_update", "target_kind": "workspace",
        "target_id": ctx.workspace_id, "details": {"changes": body.dict(exclude_unset=True)},
    }).execute()

    return await get_notif_prefs(ctx)


# ─── Routing status (used by onboarding step 4) ───────────────────────────


@router.get("/workspace/routing-status")
async def routing_status(ctx: WorkspaceContext = Depends(require_role("member"))):
    """Report whether the workspace has yet observed any routing usage.

    The onboarding flow polls this after the user pastes the routing snippet
    into their app — first detection means observer mode is live.
    """
    sb = sb_service()
    rows = (
        sb.from_("routing_usage_records").select("id, created_at")
        .eq("workspace_id", ctx.workspace_id)
        .order("created_at", desc=True)
        .limit(1).execute()
    ).data or []
    return {
        "has_recorded_routing": len(rows) > 0,
        "first_seen_at": rows[0]["created_at"] if rows else None,
    }
