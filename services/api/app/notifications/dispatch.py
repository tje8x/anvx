"""Notification dispatch.

Single public entry: `dispatch(kind, workspace_id, payload)` records an event
row, looks up workspace settings, and (for non-digestible kinds) sends email
and Slack in parallel. Never raises — failures are written back to the event
row so the caller (anomaly/incident/pack/budget code) is never blocked or
crashed by a transport problem.

Sync callers fire-and-forget via `dispatch_fire_and_forget(...)` which picks
the right scheduling strategy depending on whether a loop is already running.
"""
from __future__ import annotations

import asyncio
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

from ..db import sb_service
from ..settings import settings
from .email import send_email
from .slack import send_slack

TEMPLATE_DIR = Path(__file__).parent / "templates"
_env = Environment(
    loader=FileSystemLoader(str(TEMPLATE_DIR)),
    autoescape=select_autoescape(["html"]),
)

DIGESTIBLE_KINDS = {"autopilot_optimization", "autopilot_digest"}

DEFAULT_SETTINGS = {
    "email_enabled": True,
    "email_recipient": None,
    "slack_enabled": False,
    "slack_webhook_url": None,
    "digest_enabled": True,
    "runway_alert_threshold_months": None,
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truncate(s: str, n: int = 300) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def get_or_create_settings(sb, workspace_id: str) -> dict:
    rows = (
        sb.from_("notification_settings")
        .select("*").eq("workspace_id", workspace_id)
        .limit(1).execute()
    ).data or []
    if rows:
        return rows[0]
    insert = sb.from_("notification_settings").insert({
        "workspace_id": workspace_id, **DEFAULT_SETTINGS,
    }).execute()
    return (insert.data or [{**DEFAULT_SETTINGS, "workspace_id": workspace_id}])[0]


def _resolve_email_recipient(sb, workspace_id: str, settings_row: dict) -> str | None:
    """Recipient resolution priority:
    1. notification_settings.email_recipient (legacy schema)
    2. workspaces.notification_email (new schema)
    3. workspace owner's email (final fallback)
    """
    if settings_row.get("email_recipient"):
        return settings_row["email_recipient"]
    ws = (
        sb.from_("workspaces").select("owner_user_id, name, notification_email")
        .eq("id", workspace_id).single().execute()
    ).data or {}
    if ws.get("notification_email"):
        return ws["notification_email"]
    owner_id = ws.get("owner_user_id")
    if not owner_id:
        return None
    user = (
        sb.from_("users").select("email")
        .eq("id", owner_id).single().execute()
    ).data or {}
    return user.get("email")


def _resolve_slack_url(sb, workspace_id: str, settings_row: dict) -> str | None:
    """Slack URL priority: workspaces.slack_webhook_url (new schema)
    falls back to notification_settings.slack_webhook_url (legacy)."""
    ws = (
        sb.from_("workspaces").select("slack_webhook_url")
        .eq("id", workspace_id).single().execute()
    ).data or {}
    return ws.get("slack_webhook_url") or settings_row.get("slack_webhook_url")


def _resolve_channel_gates(
    sb, workspace_id: str, kind: str, settings_row: dict,
) -> tuple[bool, bool]:
    """Per-event preferences win when present; fall back to legacy
    notification_settings.email_enabled / .slack_enabled flags otherwise.
    """
    pref_rows = (
        sb.from_("notification_preferences")
        .select("email_enabled, slack_enabled")
        .eq("workspace_id", workspace_id)
        .eq("event_type", kind)
        .limit(1).execute()
    ).data or []
    if pref_rows:
        p = pref_rows[0]
        return bool(p.get("email_enabled")), bool(p.get("slack_enabled"))
    return bool(settings_row.get("email_enabled")), bool(settings_row.get("slack_enabled"))


def _workspace_name(sb, workspace_id: str) -> str:
    ws = (
        sb.from_("workspaces").select("name")
        .eq("id", workspace_id).single().execute()
    ).data or {}
    return ws.get("name") or workspace_id


def _render(kind: str, ext: str, ctx: dict) -> str:
    return _env.get_template(f"{kind}.{ext}").render(**ctx)


async def _deliver_email(to: str | None, subject: str, text: str, html: str) -> tuple[bool, str | None]:
    if not to:
        return False, "no email_recipient configured and no owner email available"
    try:
        await send_email(to, subject, text, html)
        return True, None
    except Exception as e:
        return False, _truncate(str(e))


async def _deliver_slack(webhook_url: str | None, slack_blocks: list[dict]) -> tuple[bool, str | None]:
    if not webhook_url:
        return False, "no slack_webhook_url configured"
    try:
        await send_slack(webhook_url, slack_blocks)
        return True, None
    except Exception as e:
        return False, _truncate(str(e))


async def dispatch(kind: str, workspace_id: str, payload: dict) -> dict | None:
    """Record + deliver. Returns the event row dict (or None on hard failure).

    Spec: NEVER raises. Transport failures are captured into email_error /
    slack_error fields on the event row.
    """
    try:
        sb = sb_service()
        settings_row = get_or_create_settings(sb, workspace_id)

        event_insert = (
            sb.from_("notification_events").insert({
                "workspace_id": workspace_id,
                "kind": kind,
                "payload": payload,
            }).execute()
        )
        event = (event_insert.data or [None])[0]
        if not event:
            return None

        # Digestible kinds: leave for the daily digest cron.
        if kind in DIGESTIBLE_KINDS and settings_row.get("digest_enabled"):
            return event

        ctx = {
            "workspace_id": workspace_id,
            "workspace_name": _workspace_name(sb, workspace_id),
            "webapp_base_url": settings.webapp_base_url,
            **payload,
        }
        try:
            text = _render(kind, "txt", ctx)
            subject = (text.splitlines()[0] if text.splitlines() else kind)[:200]
            html = _render(kind, "html", ctx)
            slack_payload = json.loads(_render(kind, "slack.json", ctx))
            slack_blocks = slack_payload.get("blocks", [])
        except Exception as render_err:
            err_str = _truncate(f"template render failed: {render_err}")
            sb.from_("notification_events").update({
                "email_error": err_str, "slack_error": err_str,
            }).eq("id", event["id"]).execute()
            return event

        email_enabled, slack_enabled = _resolve_channel_gates(sb, workspace_id, kind, settings_row)
        email_recipient = _resolve_email_recipient(sb, workspace_id, settings_row) if email_enabled else None
        slack_url = _resolve_slack_url(sb, workspace_id, settings_row) if slack_enabled else None

        async def _email_branch() -> tuple[bool, str | None]:
            if not email_enabled:
                return False, "email disabled"
            return await _deliver_email(email_recipient, subject, text, html)

        async def _slack_branch() -> tuple[bool, str | None]:
            if not slack_enabled:
                return False, "slack disabled"
            return await _deliver_slack(slack_url, slack_blocks)

        (email_ok, email_err), (slack_ok, slack_err) = await asyncio.gather(_email_branch(), _slack_branch())

        update: dict[str, Any] = {}
        if email_ok:
            update["delivered_email_at"] = _now_iso()
        elif email_err and email_enabled:
            update["email_error"] = email_err
        if slack_ok:
            update["delivered_slack_at"] = _now_iso()
        elif slack_err and slack_enabled:
            update["slack_error"] = slack_err

        if update:
            sb.from_("notification_events").update(update).eq("id", event["id"]).execute()
        return {**event, **update}
    except Exception as e:
        # Last-ditch: NEVER raise from dispatch.
        try:
            sb_service().from_("notification_events").insert({
                "workspace_id": workspace_id, "kind": kind, "payload": payload,
                "email_error": _truncate(f"dispatch crashed: {e}"),
            }).execute()
        except Exception:
            pass
        return None


async def dispatch_test(kind: str, workspace_id: str, payload: dict, channel: str) -> dict:
    """Test-message variant: bypasses settings.email_enabled/slack_enabled gating
    so the user can verify configuration even when channels are toggled off.
    """
    try:
        sb = sb_service()
        settings_row = get_or_create_settings(sb, workspace_id)

        event_insert = sb.from_("notification_events").insert({
            "workspace_id": workspace_id, "kind": kind, "payload": payload,
        }).execute()
        event = (event_insert.data or [None])[0]
        if not event:
            return {"delivered": False, "error": "could not record event"}

        ctx = {
            "workspace_id": workspace_id,
            "workspace_name": _workspace_name(sb, workspace_id),
            "webapp_base_url": settings.webapp_base_url,
            **payload,
        }
        try:
            text = _render(kind, "txt", ctx)
            subject = (text.splitlines()[0] if text.splitlines() else kind)[:200]
            html = _render(kind, "html", ctx)
            slack_payload = json.loads(_render(kind, "slack.json", ctx))
            slack_blocks = slack_payload.get("blocks", [])
        except Exception as e:
            err = _truncate(f"template render failed: {e}")
            sb.from_("notification_events").update({
                "email_error": err, "slack_error": err,
            }).eq("id", event["id"]).execute()
            return {"delivered": False, "error": err}

        if channel == "email":
            email_recipient = _resolve_email_recipient(sb, workspace_id, settings_row)
            ok, err = await _deliver_email(email_recipient, f"[TEST] {subject}", text, html)
            field = "delivered_email_at" if ok else "email_error"
            sb.from_("notification_events").update(
                {field: _now_iso() if ok else err}
            ).eq("id", event["id"]).execute()
            return {"delivered": ok, "error": err}
        elif channel == "slack":
            ok, err = await _deliver_slack(settings_row.get("slack_webhook_url"), slack_blocks)
            field = "delivered_slack_at" if ok else "slack_error"
            sb.from_("notification_events").update(
                {field: _now_iso() if ok else err}
            ).eq("id", event["id"]).execute()
            return {"delivered": ok, "error": err}
        else:
            return {"delivered": False, "error": f"unknown channel: {channel}"}
    except Exception as e:
        return {"delivered": False, "error": _truncate(str(e))}


def dispatch_fire_and_forget(kind: str, workspace_id: str, payload: dict) -> None:
    """Schedule dispatch without blocking the caller. Safe from sync or async."""
    coro = dispatch(kind, workspace_id, payload)
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(coro)
    except RuntimeError:
        # No running loop — run on a daemon thread so cron/sync paths work.
        def _runner():
            try:
                asyncio.run(coro)
            except Exception:
                pass
        threading.Thread(target=_runner, daemon=True).start()
