"""v2 thin-wrapper tests — mocks the public API with `respx` (the httpx
equivalent of the `responses` library).

Covers happy paths for all 8 tools, the 401 (revoked token) case, the
generic 5xx case, and the missing-token case. No live network calls.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest
import respx

# Make `mcp/tools.py` importable from the tests directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tools  # noqa: E402  (path injected above)


API_BASE = "https://anvx.test"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ANVX_TOKEN", "anvx_live_test")
    monkeypatch.setenv("ANVX_API_BASE", API_BASE)


# ── Happy paths ────────────────────────────────────────────────


@respx.mock
def test_get_spend_summary():
    body = {"period": "30d", "total_cents": 12345, "by_provider": {}}
    route = respx.get(f"{API_BASE}/api/v2/spend/summary").mock(
        return_value=httpx.Response(200, json=body),
    )
    result = json.loads(tools.get_spend_summary("30d"))
    assert result == body
    assert "period=30d" in str(route.calls[0].request.url)
    assert route.calls[0].request.headers["authorization"] == "Bearer anvx_live_test"


@respx.mock
def test_get_insights():
    body = [{"kind": "top_concentration", "headline": "x", "felt_value_score": 1.0}]
    route = respx.get(f"{API_BASE}/api/v2/insights").mock(
        return_value=httpx.Response(200, json=body),
    )
    result = json.loads(tools.get_insights(limit=3))
    assert result == body
    url = str(route.calls[0].request.url)
    assert "limit=3" in url
    assert "include_score=true" in url


@respx.mock
def test_list_policies():
    body = [{"id": "p1", "name": "monthly cap"}]
    respx.get(f"{API_BASE}/api/v2/policies").mock(
        return_value=httpx.Response(200, json=body),
    )
    assert json.loads(tools.list_policies()) == body


@respx.mock
def test_list_routing_rules():
    body = [{"id": "r1", "name": "code generation"}]
    respx.get(f"{API_BASE}/api/v2/routing/rules").mock(
        return_value=httpx.Response(200, json=body),
    )
    assert json.loads(tools.list_routing_rules()) == body


@respx.mock
def test_list_connectors():
    body = [{"id": "c1", "provider": "openai"}]
    respx.get(f"{API_BASE}/api/v2/connectors").mock(
        return_value=httpx.Response(200, json=body),
    )
    assert json.loads(tools.list_connectors()) == body


@respx.mock
def test_propose_policy_returns_confirm_url():
    body = {"confirm_url": "https://anvx.io/policies/proposals/abc"}
    route = respx.post(f"{API_BASE}/api/v2/policies/proposals").mock(
        return_value=httpx.Response(200, json=body),
    )
    result = json.loads(tools.propose_policy(
        scope="workspace", limit=50_000, action="alert_only", period="monthly",
    ))
    assert result == body
    sent = json.loads(route.calls[0].request.content)
    assert sent == {
        "scope": "workspace", "limit_cents": 50_000,
        "action": "alert_only", "period": "monthly",
    }


@respx.mock
def test_propose_routing_rule_returns_confirm_url():
    body = {"confirm_url": "https://anvx.io/routing/proposals/xyz"}
    route = respx.post(f"{API_BASE}/api/v2/routing/rules/proposals").mock(
        return_value=httpx.Response(200, json=body),
    )
    result = json.loads(tools.propose_routing_rule(
        name="code", models=["anthropic/claude-sonnet-4"],
        quality_priority=80, cost_priority=20,
    ))
    assert result == body
    sent = json.loads(route.calls[0].request.content)
    assert sent["approved_models"] == ["anthropic/claude-sonnet-4"]
    assert sent["quality_priority"] == 80


@respx.mock
def test_generate_pack_preview_returns_preview_url():
    body = {"preview_url": "https://anvx.io/packs/preview/qkqk"}
    respx.post(f"{API_BASE}/api/v2/packs/previews").mock(
        return_value=httpx.Response(200, json=body),
    )
    result = json.loads(tools.generate_pack_preview(
        kind="quarterly_close", period="2026-Q1",
    ))
    assert result == body


# ── 401 (revoked token) ────────────────────────────────────────


@respx.mock
def test_revoked_token_returns_401_payload():
    respx.get(f"{API_BASE}/api/v2/spend/summary").mock(
        return_value=httpx.Response(401, json={"error": "revoked"}),
    )
    result = json.loads(tools.get_spend_summary("30d"))
    assert result["status"] == 401
    assert "Token revoked or invalid" in result["error"]
    assert "anvx.io/settings/connections" in result["error"]


@respx.mock
def test_500_returns_error_payload():
    respx.get(f"{API_BASE}/api/v2/insights").mock(
        return_value=httpx.Response(500, text="upstream broke"),
    )
    result = json.loads(tools.get_insights())
    assert result["status"] == 500
    assert "anvx API 500" in result["error"]


# ── Missing token ──────────────────────────────────────────────


def test_missing_token_returns_error_payload(monkeypatch):
    monkeypatch.delenv("ANVX_TOKEN", raising=False)
    result = json.loads(tools.get_spend_summary("30d"))
    assert "ANVX_TOKEN is not set" in result["error"]
