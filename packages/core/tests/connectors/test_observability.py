"""Tests for Twilio, SendGrid, Datadog, LangSmith, Pinecone, Tavily connectors."""
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from anvx_core.connectors.twilio import TwilioConnector
from anvx_core.connectors.sendgrid import SendGridConnector
from anvx_core.connectors.datadog import DatadogConnector
from anvx_core.connectors.langsmith import LangSmithConnector
from anvx_core.connectors.pinecone import PineconeConnector
from anvx_core.connectors.tavily import TavilyConnector

_OriginalAsyncClient = httpx.AsyncClient

NOW = datetime.now(timezone.utc)
SINCE = NOW - timedelta(days=30)
UNTIL = NOW

TWILIO_CREDS = json.dumps({"account_sid": "AC_TEST", "auth_token": "tok_test"})
DATADOG_CREDS = json.dumps({"api_key": "dd_key", "app_key": "dd_app"})


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


# ── Twilio ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_twilio_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"sid": "AC_TEST"})])
    conn = TwilioConnector()
    await conn.validate(TWILIO_CREDS)


@pytest.mark.asyncio
async def test_twilio_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = TwilioConnector()
    with pytest.raises(PermissionError):
        await conn.validate(TWILIO_CREDS)


@pytest.mark.asyncio
async def test_twilio_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"usage_records": [{"category": "sms", "price": "1.50", "start_date": "2026-04-01", "count": "10", "count_unit": "messages"}]})])
    conn = TwilioConnector()
    records = await conn.fetch_usage(TWILIO_CREDS, SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].model == "sms"
    assert records[0].total_cost_cents_usd == 150


@pytest.mark.asyncio
async def test_twilio_empty_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"usage_records": []})])
    conn = TwilioConnector()
    records = await conn.fetch_usage(TWILIO_CREDS, SINCE, UNTIL)
    assert records == []


# ── SendGrid ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sendgrid_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"type": "pro"})])
    conn = SendGridConnector()
    await conn.validate("sg_key")


@pytest.mark.asyncio
async def test_sendgrid_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = SendGridConnector()
    with pytest.raises(PermissionError):
        await conn.validate("sg_bad")


@pytest.mark.asyncio
async def test_sendgrid_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"type": "pro"}),
        httpx.Response(200, json=[{"date": "2026-04", "stats": [{"metrics": {"requests": 50000}}]}]),
    ])
    conn = SendGridConnector()
    records = await conn.fetch_usage("sg_key", SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].total_cost_cents_usd == 8995  # pro plan


@pytest.mark.asyncio
async def test_sendgrid_empty_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"type": "free"}),
        httpx.Response(200, json=[]),
    ])
    conn = SendGridConnector()
    records = await conn.fetch_usage("sg_key", SINCE, UNTIL)
    assert records == []  # free plan = $0


# ── Datadog ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_datadog_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"valid": True})])
    conn = DatadogConnector()
    await conn.validate(DATADOG_CREDS)


@pytest.mark.asyncio
async def test_datadog_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(403, json={})])
    conn = DatadogConnector()
    with pytest.raises(PermissionError):
        await conn.validate(DATADOG_CREDS)


@pytest.mark.asyncio
async def test_datadog_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"data": [{"attributes": {"host_count": 5}}]}),  # infra
        httpx.Response(200, json={"data": [{"attributes": {"ingested_bytes": 2 * 1024**3}}]}),  # logs (2GB)
        httpx.Response(200, json={"data": [{"attributes": {"apm_host_count": 3}}]}),  # apm
    ])
    conn = DatadogConnector()
    records = await conn.fetch_usage(DATADOG_CREDS, SINCE, UNTIL)
    assert len(records) == 3
    assert records[0].model == "Infrastructure Hosts"
    assert records[0].total_cost_cents_usd == 7500  # 5 * $15
    assert records[1].model == "Log Management"
    assert records[1].total_cost_cents_usd == 600  # 2GB * $3
    assert records[2].model == "APM Hosts"
    assert records[2].total_cost_cents_usd == 2400  # 3 * $8


@pytest.mark.asyncio
async def test_datadog_empty_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"data": []}),
        httpx.Response(200, json={"data": []}),
        httpx.Response(200, json={"data": []}),
    ])
    conn = DatadogConnector()
    records = await conn.fetch_usage(DATADOG_CREDS, SINCE, UNTIL)
    assert records == []


# ── LangSmith ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_langsmith_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"version": "1.0"})])
    conn = LangSmithConnector()
    await conn.validate("ls_key")


@pytest.mark.asyncio
async def test_langsmith_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = LangSmithConnector()
    with pytest.raises(PermissionError):
        await conn.validate("ls_bad")


@pytest.mark.asyncio
async def test_langsmith_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"usage": [{"base_traces": 10000, "extended_traces": 1000, "seats": 2}]})])
    conn = LangSmithConnector()
    records = await conn.fetch_usage("ls_key", SINCE, UNTIL)
    assert len(records) == 2  # trace cost + seat cost
    # Trace cost: (10000-5000)/1000 * 250 + 1000/1000 * 500 = 1250 + 500 = 1750
    assert records[0].total_cost_cents_usd == 1750
    # Seat cost: 2 * 3900 = 7800
    assert records[1].total_cost_cents_usd == 7800


@pytest.mark.asyncio
async def test_langsmith_empty_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"usage": []})])
    conn = LangSmithConnector()
    records = await conn.fetch_usage("ls_key", SINCE, UNTIL)
    assert records == []


# ── Pinecone ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_pinecone_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"indexes": []})])
    conn = PineconeConnector()
    await conn.validate("pc_key")


@pytest.mark.asyncio
async def test_pinecone_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = PineconeConnector()
    with pytest.raises(PermissionError):
        await conn.validate("pc_bad")


@pytest.mark.asyncio
async def test_pinecone_fetch_usage(monkeypatch):
    # index list + describe_index_stats
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"indexes": [{"name": "idx1", "host": "idx1.svc.pinecone.io"}]}),
        httpx.Response(200, json={"totalVectorCount": 1000000, "dimension": 1536}),
    ])
    conn = PineconeConnector()
    records = await conn.fetch_usage("pc_key", SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].model == "storage"
    assert records[0].total_cost_cents_usd > 0


@pytest.mark.asyncio
async def test_pinecone_empty_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"indexes": []})])
    conn = PineconeConnector()
    records = await conn.fetch_usage("pc_key", SINCE, UNTIL)
    assert records == []


# ── Tavily ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tavily_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"results": []})])
    conn = TavilyConnector()
    await conn.validate("tvly_key")


@pytest.mark.asyncio
async def test_tavily_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = TavilyConnector()
    with pytest.raises(PermissionError):
        await conn.validate("tvly_bad")


@pytest.mark.asyncio
async def test_tavily_fetch_usage(monkeypatch):
    resp = httpx.Response(200, json={"results": []}, headers={"x-credits-total": "5000", "x-credits-remaining": "3000"})
    _patch_client(monkeypatch, [resp])
    conn = TavilyConnector()
    records = await conn.fetch_usage("tvly_key", SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].model == "search"
    assert records[0].total_cost_cents_usd == 2000  # 2000 credits used * 1 cent


@pytest.mark.asyncio
async def test_tavily_empty_usage(monkeypatch):
    resp = httpx.Response(200, json={"results": []}, headers={"x-credits-total": "5000", "x-credits-remaining": "5000"})
    _patch_client(monkeypatch, [resp])
    conn = TavilyConnector()
    records = await conn.fetch_usage("tvly_key", SINCE, UNTIL)
    assert records == []  # no credits used
