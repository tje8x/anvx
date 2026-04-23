"""Tests for LLM connectors: Google AI, Cohere, Replicate, Together, Fireworks."""
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from anvx_core.connectors.google_ai import GoogleAIConnector
from anvx_core.connectors.cohere import CohereConnector
from anvx_core.connectors.replicate import ReplicateConnector
from anvx_core.connectors.together import TogetherConnector
from anvx_core.connectors.fireworks import FireworksConnector

_OriginalAsyncClient = httpx.AsyncClient

NOW = datetime.now(timezone.utc)
SINCE = NOW - timedelta(days=5)
UNTIL = NOW


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


# ── Google AI ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_google_ai_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"models": []})])
    conn = GoogleAIConnector()
    await conn.validate("AIza_test")


@pytest.mark.asyncio
async def test_google_ai_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(403, json={"error": {"message": "API key not valid"}})])
    conn = GoogleAIConnector()
    with pytest.raises(PermissionError):
        await conn.validate("bad_key")


@pytest.mark.asyncio
async def test_google_ai_fetch_returns_empty(monkeypatch):
    conn = GoogleAIConnector()
    records = await conn.fetch_usage("AIza_test", SINCE, UNTIL)
    assert records == []


# ── Cohere ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cohere_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"models": []})])
    conn = CohereConnector()
    await conn.validate("co_test")


@pytest.mark.asyncio
async def test_cohere_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = CohereConnector()
    with pytest.raises(PermissionError):
        await conn.validate("co_bad")


@pytest.mark.asyncio
async def test_cohere_fetch_returns_pending(monkeypatch):
    conn = CohereConnector()
    records = await conn.fetch_usage("co_test", SINCE, UNTIL)
    assert len(records) >= 1
    assert all(r.total_cost_cents_usd == 0 for r in records)
    assert all(r.raw.get("status") == "pending_billing_api" for r in records)


# ── Replicate ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_replicate_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"username": "testuser"})])
    conn = ReplicateConnector()
    await conn.validate("r8_test")


@pytest.mark.asyncio
async def test_replicate_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = ReplicateConnector()
    with pytest.raises(PermissionError):
        await conn.validate("r8_bad")


@pytest.mark.asyncio
async def test_replicate_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"current_period_used": 15.0, "limit": 100.0})])
    conn = ReplicateConnector()
    records = await conn.fetch_usage("r8_test", SINCE, UNTIL)
    assert len(records) == 5  # 5 days
    total_cents = sum(r.total_cost_cents_usd for r in records)
    assert total_cents == 1500  # $15.00


@pytest.mark.asyncio
async def test_replicate_fetch_empty(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"current_period_used": 0})])
    conn = ReplicateConnector()
    records = await conn.fetch_usage("r8_test", SINCE, UNTIL)
    assert len(records) == 5
    assert all(r.total_cost_cents_usd == 0 for r in records)


# ── Together ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_together_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json=[])])
    conn = TogetherConnector()
    await conn.validate("tog_test")


@pytest.mark.asyncio
async def test_together_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = TogetherConnector()
    with pytest.raises(PermissionError):
        await conn.validate("tog_bad")


@pytest.mark.asyncio
async def test_together_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"data": [
        {"date": "2026-04-18", "model": "meta-llama/Llama-3-70b", "input_tokens": 10000, "output_tokens": 5000, "cost": 0.50},
        {"date": "2026-04-19", "model": "meta-llama/Llama-3-8b", "input_tokens": 20000, "output_tokens": 8000, "cost": 0.10},
    ]})])
    conn = TogetherConnector()
    records = await conn.fetch_usage("tog_test", SINCE, UNTIL)
    assert len(records) == 2
    assert records[0].model == "meta-llama/Llama-3-70b"
    assert records[0].total_cost_cents_usd == 50
    assert records[1].total_cost_cents_usd == 10


@pytest.mark.asyncio
async def test_together_fetch_empty(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"data": []})])
    conn = TogetherConnector()
    records = await conn.fetch_usage("tog_test", SINCE, UNTIL)
    assert records == []


# ── Fireworks ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fireworks_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"accounts": [{"id": "acct1"}]})])
    conn = FireworksConnector()
    await conn.validate("fw_test")


@pytest.mark.asyncio
async def test_fireworks_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = FireworksConnector()
    with pytest.raises(PermissionError):
        await conn.validate("fw_bad")


@pytest.mark.asyncio
async def test_fireworks_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"accounts": [{"id": "acct1"}]}),
        httpx.Response(200, json={"data": [
            {"date": "2026-04-18", "model": "accounts/fireworks/models/llama-v3-70b", "input_tokens": 5000, "output_tokens": 2000, "cost": 0.25},
        ]}),
    ])
    conn = FireworksConnector()
    records = await conn.fetch_usage("fw_test", SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].total_cost_cents_usd == 25


@pytest.mark.asyncio
async def test_fireworks_fetch_no_accounts(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"accounts": []})])
    conn = FireworksConnector()
    records = await conn.fetch_usage("fw_test", SINCE, UNTIL)
    assert records == []
