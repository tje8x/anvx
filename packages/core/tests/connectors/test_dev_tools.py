"""Tests for dev-tool connectors: Cursor, GitHub Copilot, Replit, Lovable, v0, Bolt."""
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from anvx_core.connectors.cursor import CursorConnector
from anvx_core.connectors.github_copilot import GitHubCopilotConnector
from anvx_core.connectors.replit import ReplitConnector
from anvx_core.connectors.lovable import LovableConnector
from anvx_core.connectors.v0 import V0Connector
from anvx_core.connectors.bolt import BoltConnector

_OriginalAsyncClient = httpx.AsyncClient

NOW = datetime(2026, 4, 20, tzinfo=timezone.utc)
SINCE = NOW - timedelta(days=5)
UNTIL = NOW

MANIFEST_GOOD = json.dumps({"plan": "pro", "monthly_cents": 3000, "renews_on": "2026-04-01"})


def _mock_transport(responses: list[httpx.Response]) -> httpx.MockTransport:
    idx = {"i": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        i = idx["i"]
        idx["i"] += 1
        if i < len(responses):
            return responses[i]
        return httpx.Response(200, json={})

    return httpx.MockTransport(handler)


def _patch_client(monkeypatch, responses):
    transport = _mock_transport(responses)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _OriginalAsyncClient(transport=transport))


# ── Cursor ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cursor_parse_csv():
    csv = "Date,Model,Cost\n2026-04-01,gpt-4o,1.50\n2026-04-02,gpt-4o-mini,0.25\n"
    conn = CursorConnector()
    records = await conn.parse_input(csv)
    assert len(records) == 2
    assert records[0].provider == "cursor"
    assert records[0].model == "gpt-4o"
    assert records[0].total_cost_cents_usd == 150
    assert records[1].total_cost_cents_usd == 25


@pytest.mark.asyncio
async def test_cursor_parse_csv_with_preface():
    csv = "Cursor Usage Export\nGenerated: 2026-04-20\n\nDate,Cost,Model\n2026-04-01,2.00,claude-sonnet\n"
    conn = CursorConnector()
    records = await conn.parse_input(csv)
    assert len(records) == 1
    assert records[0].model == "claude-sonnet"


@pytest.mark.asyncio
async def test_cursor_missing_columns():
    csv = "Foo,Bar\n1,2\n"
    conn = CursorConnector()
    with pytest.raises(ValueError, match="missing required"):
        await conn.parse_input(csv)


# ── GitHub Copilot ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_copilot_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"login": "user"}, headers={"X-OAuth-Scopes": "repo, manage_billing:copilot"})])
    conn = GitHubCopilotConnector()
    await conn.validate("ghp_test")


@pytest.mark.asyncio
async def test_copilot_validate_missing_scope(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"login": "user"}, headers={"X-OAuth-Scopes": "repo"})])
    conn = GitHubCopilotConnector()
    with pytest.raises(PermissionError, match="manage_billing:copilot"):
        await conn.validate("ghp_test")


@pytest.mark.asyncio
async def test_copilot_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json=[{"login": "myorg"}]),
        httpx.Response(200, json={"total_seats": 10}),
    ])
    conn = GitHubCopilotConnector()
    records = await conn.fetch_usage("ghp_test", SINCE, UNTIL)
    assert len(records) == 5  # 5 days
    assert all(r.total_cost_cents_usd == 10 * 63 for r in records)


@pytest.mark.asyncio
async def test_copilot_no_orgs(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json=[])])
    conn = GitHubCopilotConnector()
    records = await conn.fetch_usage("ghp_test", SINCE, UNTIL)
    assert records == []


# ── Replit ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_replit_parse_csv():
    csv = "Date,Cost\n2026-04-01,0.50\n2026-04-02,0.75\n"
    conn = ReplitConnector()
    records = await conn.parse_input(csv)
    assert len(records) == 2
    assert records[0].provider == "replit"
    assert records[0].total_cost_cents_usd == 50


@pytest.mark.asyncio
async def test_replit_missing_columns():
    csv = "X,Y\n1,2\n"
    conn = ReplitConnector()
    with pytest.raises(ValueError):
        await conn.parse_input(csv)


# ── Lovable ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_lovable_parse_manifest():
    conn = LovableConnector()
    records = await conn.parse_input(MANIFEST_GOOD)
    assert len(records) > 0
    assert all(r.provider == "lovable" for r in records)
    assert all(r.model == "pro" for r in records)
    assert all(r.total_cost_cents_usd == 3000 // 30 for r in records)


@pytest.mark.asyncio
async def test_lovable_invalid_plan():
    bad = json.dumps({"plan": "free", "monthly_cents": 0, "renews_on": "2026-04-01"})
    conn = LovableConnector()
    with pytest.raises(ValueError, match="Invalid plan"):
        await conn.parse_input(bad)


@pytest.mark.asyncio
async def test_lovable_invalid_json():
    conn = LovableConnector()
    with pytest.raises(ValueError, match="Invalid manifest JSON"):
        await conn.parse_input("not json")


# ── v0 ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_v0_parse_manifest():
    conn = V0Connector()
    records = await conn.parse_input(MANIFEST_GOOD)
    assert len(records) > 0
    assert all(r.provider == "v0" for r in records)
    assert all(r.total_cost_cents_usd == 3000 // 30 for r in records)


@pytest.mark.asyncio
async def test_v0_subsumed_by_vercel():
    conn = V0Connector()
    records = await conn.parse_input(MANIFEST_GOOD, vercel_connected=True)
    assert len(records) > 0
    assert all(r.total_cost_cents_usd == 0 for r in records)
    assert all(r.raw.get("subsumed_by") == "vercel" for r in records)


@pytest.mark.asyncio
async def test_v0_invalid_plan():
    bad = json.dumps({"plan": "hobby", "monthly_cents": 0, "renews_on": "2026-04-01"})
    conn = V0Connector()
    with pytest.raises(ValueError, match="Invalid plan"):
        await conn.parse_input(bad)


# ── Bolt ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bolt_parse_manifest():
    conn = BoltConnector()
    records = await conn.parse_input(MANIFEST_GOOD)
    assert len(records) > 0
    assert all(r.provider == "bolt" for r in records)
    assert all(r.model == "pro" for r in records)


@pytest.mark.asyncio
async def test_bolt_invalid_json():
    conn = BoltConnector()
    with pytest.raises(ValueError, match="Invalid manifest JSON"):
        await conn.parse_input("{bad")
