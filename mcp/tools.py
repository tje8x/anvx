"""v2 tool implementations — thin HTTP wrappers over the anvx public API.

NO Supabase access. NO keychain reads. NO business logic.
Every function is a single HTTP call, JSON in, JSON out.
"""
from __future__ import annotations

import json
import os
from typing import Any

import httpx

DEFAULT_API_BASE = "https://anvx.io"
TIMEOUT_S = 15.0


class AnvxAPIError(Exception):
    """Raised when the v2 API returns a non-2xx response."""

    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"anvx API {status}: {body[:200]}")


def _api_base() -> str:
    return os.getenv("ANVX_API_BASE", DEFAULT_API_BASE).rstrip("/")


def _token() -> str:
    token = os.getenv("ANVX_TOKEN")
    if not token:
        raise RuntimeError("ANVX_TOKEN is not set — cannot call v2 API")
    return token


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_token()}",
        "Content-Type": "application/json",
        "User-Agent": "anvx-mcp/2.0.0",
    }


def _request(method: str, path: str, *, params: dict | None = None,
             body: dict | None = None) -> Any:
    url = f"{_api_base()}{path}"
    with httpx.Client(timeout=TIMEOUT_S) as client:
        resp = client.request(
            method, url, headers=_headers(), params=params, json=body,
        )
    if resp.status_code == 401:
        raise AnvxAPIError(401, "Token revoked or invalid. Regenerate at "
                                 "https://anvx.io/settings/connections")
    if resp.status_code >= 400:
        raise AnvxAPIError(resp.status_code, resp.text)
    if not resp.content:
        return None
    return resp.json()


def _err_payload(exc: Exception) -> str:
    if isinstance(exc, AnvxAPIError):
        return json.dumps({"error": str(exc), "status": exc.status})
    return json.dumps({"error": str(exc)})


# ── Read tools ──────────────────────────────────────────────────


def get_spend_summary(period: str = "30d") -> str:
    """Get spend summary for a period (e.g. '7d', '30d', '90d')."""
    try:
        data = _request("GET", "/api/v2/spend/summary", params={"period": period})
        return json.dumps(data, indent=2)
    except Exception as exc:
        return _err_payload(exc)


def get_insights(limit: int = 5) -> str:
    """Get the top N ranked insights for this workspace."""
    try:
        data = _request("GET", "/api/v2/insights",
                        params={"limit": limit, "include_score": "true"})
        return json.dumps(data, indent=2)
    except Exception as exc:
        return _err_payload(exc)


def list_policies() -> str:
    """List all budget policies for this workspace."""
    try:
        data = _request("GET", "/api/v2/policies")
        return json.dumps(data, indent=2)
    except Exception as exc:
        return _err_payload(exc)


def list_routing_rules() -> str:
    """List all routing rules for this workspace."""
    try:
        data = _request("GET", "/api/v2/routing/rules")
        return json.dumps(data, indent=2)
    except Exception as exc:
        return _err_payload(exc)


def list_connectors() -> str:
    """List all connected providers for this workspace."""
    try:
        data = _request("GET", "/api/v2/connectors")
        return json.dumps(data, indent=2)
    except Exception as exc:
        return _err_payload(exc)


# ── Propose-then-confirm tools ─────────────────────────────────


def propose_policy(scope: str, limit: int, action: str, period: str) -> str:
    """Propose a new budget policy. Returns a confirm_url the user opens
    in their browser to review and approve. No mutation happens until
    the user confirms in-browser.

    Args:
        scope: 'workspace', 'provider:<name>', 'project:<tag>', or 'user:<hint>'.
        limit: Limit in cents (USD).
        action: 'alert_only', 'downgrade', or 'pause'.
        period: 'daily', 'monthly', or 'per_request'.
    """
    try:
        data = _request(
            "POST", "/api/v2/policies/proposals",
            body={"scope": scope, "limit_cents": limit,
                  "action": action, "period": period},
        )
        return json.dumps(data, indent=2)
    except Exception as exc:
        return _err_payload(exc)


def propose_routing_rule(name: str, models: list[str],
                         quality_priority: int, cost_priority: int) -> str:
    """Propose a new routing rule. Returns a confirm_url the user opens
    to review and approve. No mutation happens until the user confirms.

    Args:
        name: Human-readable rule name.
        models: List of approved model identifiers (e.g. ['anthropic/claude-sonnet-4']).
        quality_priority: 0-100, weight on output quality.
        cost_priority: 0-100, weight on cost. Should sum with quality_priority to 100.
    """
    try:
        data = _request(
            "POST", "/api/v2/routing/rules/proposals",
            body={"name": name, "approved_models": models,
                  "quality_priority": quality_priority,
                  "cost_priority": cost_priority},
        )
        return json.dumps(data, indent=2)
    except Exception as exc:
        return _err_payload(exc)


def generate_pack_preview(kind: str, period: str) -> str:
    """Generate a preview of a close pack (quarterly_close, annual_tax_prep, etc.).
    Returns a preview_url the user opens to review and download.

    Args:
        kind: Pack kind (e.g. 'quarterly_close', 'annual_tax_prep').
        period: Period identifier (e.g. '2026-Q1', '2025').
    """
    try:
        data = _request(
            "POST", "/api/v2/packs/previews",
            body={"kind": kind, "period": period},
        )
        return json.dumps(data, indent=2)
    except Exception as exc:
        return _err_payload(exc)


# ── Registration helper ─────────────────────────────────────────


def register(server) -> None:
    """Register all v2 tools on a FastMCP server instance."""
    server.tool()(get_spend_summary)
    server.tool()(get_insights)
    server.tool()(list_policies)
    server.tool()(list_routing_rules)
    server.tool()(list_connectors)
    server.tool()(propose_policy)
    server.tool()(propose_routing_rule)
    server.tool()(generate_pack_preview)
