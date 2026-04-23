"""Tests for Mercury, Wise, PayPal, Notion, Supabase connectors."""
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from anvx_core.connectors.mercury import MercuryConnector
from anvx_core.connectors.wise import WiseConnector
from anvx_core.connectors.paypal import PayPalConnector
from anvx_core.connectors.notion import NotionConnector
from anvx_core.connectors.supabase_billing import SupabaseBillingConnector

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


# ── Mercury ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mercury_parse_returns_empty_stub():
    conn = MercuryConnector()
    records = await conn.parse_input("Date,Description,Amount,Status,Type\n2026-04-01,Test,100.00,Completed,Debit\n")
    assert records == []


@pytest.mark.asyncio
async def test_mercury_kind():
    conn = MercuryConnector()
    assert conn.kind == "csv_source"


# ── Wise ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wise_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json=[{"id": 123}])])
    conn = WiseConnector()
    await conn.validate("wise_token")


@pytest.mark.asyncio
async def test_wise_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = WiseConnector()
    with pytest.raises(PermissionError, match="Invalid Wise"):
        await conn.validate("wise_bad")


@pytest.mark.asyncio
async def test_wise_fetch_transactions(monkeypatch):
    ts_iso = NOW.isoformat()
    _patch_client(monkeypatch, [
        httpx.Response(200, json=[{"id": 123}]),  # profiles
        httpx.Response(200, json=[{"created": ts_iso, "sourceValue": 500.00, "sourceCurrency": "USD", "targetAccount": {"name": "Vendor A"}}]),  # transfers
    ])
    conn = WiseConnector()
    records = await conn.fetch_transactions("wise_token", SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].direction == "out"
    assert records[0].amount_cents == 50000
    assert records[0].counterparty == "Vendor A"


@pytest.mark.asyncio
async def test_wise_fetch_empty(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json=[{"id": 123}]),
        httpx.Response(200, json=[]),
    ])
    conn = WiseConnector()
    records = await conn.fetch_transactions("wise_token", SINCE, UNTIL)
    assert records == []


# ── PayPal ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_paypal_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"access_token": "tok", "token_type": "Bearer"})])
    conn = PayPalConnector()
    await conn.validate("client_id:client_secret")


@pytest.mark.asyncio
async def test_paypal_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = PayPalConnector()
    with pytest.raises(PermissionError, match="Invalid PayPal"):
        await conn.validate("bad_id:bad_secret")


@pytest.mark.asyncio
async def test_paypal_validate_bad_format():
    conn = PayPalConnector()
    with pytest.raises(PermissionError, match="client_id:client_secret"):
        await conn.validate("no_colon_here")


@pytest.mark.asyncio
async def test_paypal_fetch_transactions(monkeypatch):
    ts_iso = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"access_token": "tok"}),  # auth
        httpx.Response(200, json={"transaction_details": [{"transaction_info": {"transaction_updated_date": ts_iso, "transaction_amount": {"value": "25.50", "currency_code": "USD"}}, "payer_info": {"payer_name": {"alternate_full_name": "John Doe"}}}]}),
    ])
    conn = PayPalConnector()
    records = await conn.fetch_transactions("cid:csecret", SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].direction == "in"
    assert records[0].amount_cents == 2550
    assert records[0].counterparty == "John Doe"


# ── Notion ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_notion_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"type": "bot"})])
    conn = NotionConnector()
    await conn.validate("ntn_test")


@pytest.mark.asyncio
async def test_notion_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = NotionConnector()
    with pytest.raises(PermissionError, match="Invalid Notion"):
        await conn.validate("ntn_bad")


@pytest.mark.asyncio
async def test_notion_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"results": [{"type": "person"}, {"type": "person"}, {"type": "bot"}]})])
    conn = NotionConnector()
    records = await conn.fetch_usage("ntn_test", SINCE, UNTIL)
    assert len(records) == 5  # 5 days
    # 2 person members * 1000 cents / 30 days ≈ 66-67 cents/day
    assert all(r.total_cost_cents_usd > 0 for r in records)
    assert all(r.raw["members"] == 2 for r in records)


@pytest.mark.asyncio
async def test_notion_fetch_no_members(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"results": [{"type": "bot"}]})])
    conn = NotionConnector()
    records = await conn.fetch_usage("ntn_test", SINCE, UNTIL)
    assert records == []


# ── Supabase Billing ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_supabase_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json=[{"slug": "my-org"}])])
    conn = SupabaseBillingConnector()
    await conn.validate("sbp_test")


@pytest.mark.asyncio
async def test_supabase_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = SupabaseBillingConnector()
    with pytest.raises(PermissionError, match="Invalid Supabase"):
        await conn.validate("sbp_bad")


@pytest.mark.asyncio
async def test_supabase_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json=[{"slug": "my-org"}]),  # orgs
        httpx.Response(200, json={"total_cost": 25.0, "plan": "pro"}),  # billing
    ])
    conn = SupabaseBillingConnector()
    records = await conn.fetch_usage("sbp_test", SINCE, UNTIL)
    assert len(records) == 5  # 5 days
    total_cents = sum(r.total_cost_cents_usd for r in records)
    assert total_cents == 2500  # $25 total


@pytest.mark.asyncio
async def test_supabase_fetch_no_orgs(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json=[])])
    conn = SupabaseBillingConnector()
    records = await conn.fetch_usage("sbp_test", SINCE, UNTIL)
    assert records == []
