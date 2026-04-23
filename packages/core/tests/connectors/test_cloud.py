"""Tests for cloud connectors: AWS, GCP, Vercel, Cloudflare."""
import json
from datetime import datetime, timedelta

import httpx
import pytest

from anvx_core.connectors.aws import AWSConnector
from anvx_core.connectors.gcp import GCPConnector
from anvx_core.connectors.vercel import VercelConnector
from anvx_core.connectors.cloudflare import CloudflareConnector

_OriginalAsyncClient = httpx.AsyncClient

NOW = datetime.utcnow()
SINCE = NOW - timedelta(days=30)
UNTIL = NOW

AWS_CREDS = json.dumps({"access_key_id": "AKIA_TEST", "secret_access_key": "secret_test", "region": "us-east-1"})
GCP_CREDS = json.dumps({"client_email": "test@project.iam.gserviceaccount.com", "private_key": "fake"})


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


# ── AWS ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_aws_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"ResultsByTime": []})])
    conn = AWSConnector()
    await conn.validate(AWS_CREDS)


@pytest.mark.asyncio
async def test_aws_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(403, json={"Error": "InvalidKey"})])
    conn = AWSConnector()
    with pytest.raises(PermissionError):
        await conn.validate(AWS_CREDS)


@pytest.mark.asyncio
async def test_aws_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={
        "ResultsByTime": [{
            "TimePeriod": {"Start": "2026-04-01", "End": "2026-04-02"},
            "Groups": [{"Keys": ["Amazon EC2"], "Metrics": {"UnblendedCost": {"Amount": "3.50"}}}],
        }],
    })])
    conn = AWSConnector()
    records = await conn.fetch_usage(AWS_CREDS, SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].model == "Amazon EC2"
    assert records[0].total_cost_cents_usd == 350


@pytest.mark.asyncio
async def test_aws_empty_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"ResultsByTime": []})])
    conn = AWSConnector()
    records = await conn.fetch_usage(AWS_CREDS, SINCE, UNTIL)
    assert records == []


# ── GCP ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gcp_validate_success(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"access_token": "fake_token"}),
        httpx.Response(200, json={"billingAccounts": [{"name": "billingAccounts/123"}]}),
    ])
    conn = GCPConnector()
    await conn.validate(GCP_CREDS)


@pytest.mark.asyncio
async def test_gcp_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={"error": "invalid"})])
    conn = GCPConnector()
    with pytest.raises(PermissionError):
        await conn.validate(GCP_CREDS)


@pytest.mark.asyncio
async def test_gcp_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"access_token": "fake_token"}),
        httpx.Response(200, json={"billingAccounts": [{"name": "billingAccounts/123"}]}),
        httpx.Response(200, json={"costs": [{"date": "2026-04-01", "service": "Compute Engine", "amount": 5.0}]}),
    ])
    conn = GCPConnector()
    records = await conn.fetch_usage(GCP_CREDS, SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].model == "Compute Engine"
    assert records[0].total_cost_cents_usd == 500


@pytest.mark.asyncio
async def test_gcp_empty_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"access_token": "fake_token"}),
        httpx.Response(200, json={"billingAccounts": [{"name": "billingAccounts/123"}]}),
        httpx.Response(200, json={"costs": []}),
    ])
    conn = GCPConnector()
    records = await conn.fetch_usage(GCP_CREDS, SINCE, UNTIL)
    assert records == []


# ── Vercel ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_vercel_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"user": {"id": "u1"}})])
    conn = VercelConnector()
    await conn.validate("tkn_test")


@pytest.mark.asyncio
async def test_vercel_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = VercelConnector()
    with pytest.raises(PermissionError):
        await conn.validate("tkn_bad")


@pytest.mark.asyncio
async def test_vercel_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"user": {"defaultTeamId": "team1"}}),
        httpx.Response(200, json={"functionInvocations": 2_000_000, "bandwidthGB": 500, "buildMinutes": 100}),
    ])
    conn = VercelConnector()
    records = await conn.fetch_usage("tkn_test", SINCE, UNTIL)
    assert len(records) == 2  # base plan + function overage
    assert records[0].total_cost_cents_usd == 2000
    assert records[0].model == "Pro Plan"


@pytest.mark.asyncio
async def test_vercel_empty_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"user": {"defaultTeamId": ""}}),
        httpx.Response(200, json={"functionInvocations": 0, "bandwidthGB": 0, "buildMinutes": 0}),
    ])
    conn = VercelConnector()
    records = await conn.fetch_usage("tkn_test", SINCE, UNTIL)
    assert len(records) == 1  # only base plan
    assert records[0].model == "Pro Plan"


# ── Cloudflare ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cloudflare_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"success": True})])
    conn = CloudflareConnector()
    await conn.validate("cf_token")


@pytest.mark.asyncio
async def test_cloudflare_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = CloudflareConnector()
    with pytest.raises(PermissionError):
        await conn.validate("cf_bad")


@pytest.mark.asyncio
async def test_cloudflare_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"result": [{"id": "acct1"}]}),
        httpx.Response(200, json={"result": {"totals": {"requests": 15_000_000}}}),
        httpx.Response(200, json={"result": {"buckets": [{"size": 10 * 1024**3}]}}),
    ])
    conn = CloudflareConnector()
    records = await conn.fetch_usage("cf_token", SINCE, UNTIL)
    assert len(records) == 2
    assert records[0].model == "Workers"
    assert records[0].total_cost_cents_usd > 500
    assert records[1].model == "R2 Storage"


@pytest.mark.asyncio
async def test_cloudflare_empty_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"result": [{"id": "acct1"}]}),
        httpx.Response(200, json={"result": {"totals": {"requests": 0}}}),
        httpx.Response(200, json={"result": {"buckets": []}}),
    ])
    conn = CloudflareConnector()
    records = await conn.fetch_usage("cf_token", SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].model == "Workers"
    assert records[0].total_cost_cents_usd == 500
