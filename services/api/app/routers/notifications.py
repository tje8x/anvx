"""Notification routes.

Currently exposes one cron-triggered endpoint that drains the per-workspace
autopilot_optimization queue into a single daily digest delivered via the
configured channels (email + slack).
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from jinja2 import Environment, FileSystemLoader, select_autoescape
from pydantic import BaseModel

from ..auth import WorkspaceContext, require_role
from ..db import sb_service
from ..notifications.dispatch import dispatch_test, get_or_create_settings
from ..notifications.email import send_email
from ..notifications.slack import send_slack
from ..settings import settings

router = APIRouter()


class SettingsBody(BaseModel):
    email_enabled: bool | None = None
    email_recipient: str | None = None
    slack_enabled: bool | None = None
    slack_webhook_url: str | None = None
    digest_enabled: bool | None = None
    runway_alert_threshold_months: float | None = None
    thresholds: dict | None = None


class TestBody(BaseModel):
    channel: str  # 'email' | 'slack'


def _audit_settings(sb, ctx: WorkspaceContext, details: dict) -> None:
    sb.from_("audit_log").insert({
        "workspace_id": ctx.workspace_id, "actor_user_id": ctx.user_id,
        "action": "notifications:settings_update",
        "target_kind": "notification_settings", "target_id": ctx.workspace_id,
        "details": details,
    }).execute()


@router.get("/notifications/settings")
async def get_settings(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    return get_or_create_settings(sb, ctx.workspace_id)


@router.put("/notifications/settings")
async def update_settings(body: SettingsBody, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    get_or_create_settings(sb, ctx.workspace_id)

    update = {k: v for k, v in body.dict(exclude_unset=True).items()}
    if not update:
        return get_or_create_settings(sb, ctx.workspace_id)

    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = (
        sb.from_("notification_settings").update(update)
        .eq("workspace_id", ctx.workspace_id).execute()
    )
    _audit_settings(sb, ctx, {"changes": update})
    return (result.data or [{}])[0]


@router.post("/notifications/test")
async def send_test(body: TestBody, ctx: WorkspaceContext = Depends(require_role("admin"))):
    if body.channel not in ("email", "slack"):
        raise HTTPException(400, "channel must be 'email' or 'slack'")
    payload = {
        "test": True,
        "headline": "ANVX test notification",
        "detail": "This is a test message from your ANVX notification settings.",
    }
    # Reuse the incident_resumed template (always present, neutral copy).
    result = await dispatch_test("incident_resumed", ctx.workspace_id, payload, body.channel)
    return result


@router.get("/notifications/events")
async def list_events(
    limit: int = Query(50, ge=1, le=200),
    ctx: WorkspaceContext = Depends(require_role("member")),
):
    sb = sb_service()
    rows = (
        sb.from_("notification_events").select("*")
        .eq("workspace_id", ctx.workspace_id)
        .order("created_at", desc=True).limit(limit).execute()
    ).data or []
    return rows


TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "notifications" / "templates"
_env = Environment(
    loader=FileSystemLoader(str(TEMPLATE_DIR)),
    autoescape=select_autoescape(["html"]),
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truncate(s: str, n: int = 300) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _utc_today_start() -> datetime:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)


def _resolve_email_recipient(sb, workspace_id: str, settings_row: dict) -> str | None:
    if settings_row.get("email_recipient"):
        return settings_row["email_recipient"]
    ws = (
        sb.from_("workspaces").select("owner_user_id, name")
        .eq("id", workspace_id).single().execute()
    ).data or {}
    owner_id = ws.get("owner_user_id")
    if not owner_id:
        return None
    user = (
        sb.from_("users").select("email")
        .eq("id", owner_id).single().execute()
    ).data or {}
    return user.get("email")


def _workspace_name(sb, workspace_id: str) -> str:
    ws = (
        sb.from_("workspaces").select("name")
        .eq("id", workspace_id).single().execute()
    ).data or {}
    return ws.get("name") or workspace_id


def _render(kind: str, ext: str, ctx: dict) -> str:
    return _env.get_template(f"{kind}.{ext}").render(**ctx)


async def _deliver_digest(
    settings_row: dict,
    email_recipient: str | None,
    subject: str,
    text: str,
    html: str,
    slack_blocks: list[dict],
) -> tuple[tuple[bool, str | None], tuple[bool, str | None]]:
    """Send email + slack in parallel. Returns ((email_ok, email_err), (slack_ok, slack_err))."""
    async def _email() -> tuple[bool, str | None]:
        if not settings_row.get("email_enabled") or not email_recipient:
            return False, "email disabled" if not settings_row.get("email_enabled") else "no recipient"
        try:
            await send_email(email_recipient, subject, text, html)
            return True, None
        except Exception as e:
            return False, _truncate(str(e))

    async def _slack() -> tuple[bool, str | None]:
        url = settings_row.get("slack_webhook_url")
        if not settings_row.get("slack_enabled") or not url:
            return False, "slack disabled" if not settings_row.get("slack_enabled") else "no webhook configured"
        try:
            await send_slack(url, slack_blocks)
            return True, None
        except Exception as e:
            return False, _truncate(str(e))

    return await asyncio.gather(_email(), _slack())


@router.post("/jobs/digest-daily")
async def digest_daily(request: Request):
    """Drain pending autopilot_optimization events into one digest per workspace.

    Auth: x-cron-secret header must match $CRON_SECRET (same pattern as the
    anomaly-scan and generate-pack crons).
    """
    secret = os.environ.get("CRON_SECRET", "")
    provided = request.headers.get("x-cron-secret", "")
    if not secret or provided != secret:
        raise HTTPException(401, "Invalid cron secret")

    sb = sb_service()

    # Window: from 24h before today's UTC midnight to now.
    today_start = _utc_today_start()
    window_start = today_start - timedelta(days=1)
    window_start_iso = window_start.isoformat()
    window_end_iso = datetime.now(timezone.utc).isoformat()

    digest_workspaces = (
        sb.from_("notification_settings")
        .select("workspace_id, email_enabled, email_recipient, slack_enabled, slack_webhook_url, digest_enabled")
        .eq("digest_enabled", True)
        .execute()
    ).data or []

    workspaces_processed = 0
    events_delivered = 0

    for ws_settings in digest_workspaces:
        workspace_id = ws_settings["workspace_id"]
        events = (
            sb.from_("notification_events")
            .select("id, kind, payload, created_at")
            .eq("workspace_id", workspace_id)
            .eq("kind", "autopilot_optimization")
            .is_("delivered_email_at", "null")
            .gte("created_at", window_start_iso)
            .order("created_at", desc=False)
            .execute()
        ).data or []

        if not events:
            continue

        workspaces_processed += 1

        # Compute aggregates for the template.
        total_savings_cents = 0
        for ev in events:
            payload = ev.get("payload") or {}
            try:
                total_savings_cents += int(payload.get("estimated_savings_cents") or 0)
            except (TypeError, ValueError):
                pass

        ctx = {
            "workspace_id": workspace_id,
            "workspace_name": _workspace_name(sb, workspace_id),
            "events": events,
            "event_count": len(events),
            "total_savings_cents": total_savings_cents,
            "window_start": window_start_iso[:19].replace("T", " ") + " UTC",
            "window_end": window_end_iso[:19].replace("T", " ") + " UTC",
            "webapp_base_url": settings.webapp_base_url,
        }

        # Render templates. A render failure marks all events as failed but
        # doesn't crash the loop — other workspaces still get processed.
        try:
            text = _render("autopilot_digest", "txt", ctx)
            subject = text.splitlines()[0] if text.splitlines() else "Daily autopilot digest"
            html = _render("autopilot_digest", "html", ctx)
            slack_payload = json.loads(_render("autopilot_digest", "slack.json", ctx))
            slack_blocks = slack_payload.get("blocks", [])
        except Exception as e:
            err = _truncate(f"template render failed: {e}")
            sb.from_("notification_events").update({
                "email_error": err, "slack_error": err,
            }).in_("id", [ev["id"] for ev in events]).execute()
            continue

        email_recipient = _resolve_email_recipient(sb, workspace_id, ws_settings)

        (email_ok, email_err), (slack_ok, slack_err) = await _deliver_digest(
            ws_settings, email_recipient, subject, text, html, slack_blocks,
        )

        # Bulk update all events in this digest with the delivery outcome.
        update: dict[str, Any] = {}
        if email_ok:
            update["delivered_email_at"] = _now_iso()
        elif email_err and ws_settings.get("email_enabled"):
            update["email_error"] = email_err
        if slack_ok:
            update["delivered_slack_at"] = _now_iso()
        elif slack_err and ws_settings.get("slack_enabled"):
            update["slack_error"] = slack_err

        if update:
            sb.from_("notification_events").update(update).in_(
                "id", [ev["id"] for ev in events]
            ).execute()
            if email_ok or slack_ok:
                events_delivered += len(events)

    return {
        "workspaces_processed": workspaces_processed,
        "events_delivered": events_delivered,
    }
