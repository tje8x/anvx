"""Tests for Stripe revenue connector."""
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from anvx_core.connectors.stripe import StripeConnector

_OriginalAsyncClient = httpx.AsyncClient

NOW = datetime.now(timezone.utc)
SINCE = NOW - timedelta(days=30)
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


def _make_txn(txn_id: str, txn_type: str, amount: int, description: str = "") -> dict:
    return {"id": txn_id, "type": txn_type, "amount": amount, "currency": "usd", "created": int(NOW.timestamp()), "description": description}


# ── Validate ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"id": "acct_123"})])
    conn = StripeConnector()
    await conn.validate("sk_test_abc")


@pytest.mark.asyncio
async def test_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={"error": {"message": "Invalid API Key"}})])
    conn = StripeConnector()
    with pytest.raises(PermissionError):
        await conn.validate("sk_bad")


# ── Classification ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_classify_mixed_types(monkeypatch):
    txns = [
        _make_txn("txn_1", "charge", 5000, "Customer A payment"),
        _make_txn("txn_2", "refund", -1500, "Refund for order #42"),
        _make_txn("txn_3", "payout", -3000),
        _make_txn("txn_4", "stripe_fee", -150),
        _make_txn("txn_5", "application_fee", -50),
    ]
    _patch_client(monkeypatch, [httpx.Response(200, json={"data": txns, "has_more": False})])
    conn = StripeConnector()
    records = await conn.fetch_transactions("sk_test", SINCE, UNTIL)

    assert len(records) == 5

    # charge → direction='in'
    assert records[0].direction == "in"
    assert records[0].counterparty == "Customer A payment"
    assert records[0].amount_cents == 5000
    assert records[0].category_hint == "revenue"

    # refund → direction='out'
    assert records[1].direction == "out"
    assert records[1].amount_cents == 1500
    assert records[1].category_hint == "refund"

    # payout → direction='out', counterparty='payout'
    assert records[2].direction == "out"
    assert records[2].counterparty == "payout"
    assert records[2].category_hint == "payout"

    # stripe_fee → direction='out', counterparty='stripe_fees'
    assert records[3].direction == "out"
    assert records[3].counterparty == "stripe_fees"
    assert records[3].category_hint == "fees"

    # application_fee → same as stripe_fee
    assert records[4].direction == "out"
    assert records[4].counterparty == "stripe_fees"
    assert records[4].category_hint == "fees"


# ── Pagination ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_pagination(monkeypatch):
    page1 = [_make_txn("txn_a", "charge", 1000, "Page 1")]
    page2 = [_make_txn("txn_b", "charge", 2000, "Page 2")]

    _patch_client(monkeypatch, [
        httpx.Response(200, json={"data": page1, "has_more": True}),
        httpx.Response(200, json={"data": page2, "has_more": False}),
    ])
    conn = StripeConnector()
    records = await conn.fetch_transactions("sk_test", SINCE, UNTIL)
    assert len(records) == 2
    assert records[0].amount_cents == 1000
    assert records[1].amount_cents == 2000


# ── Empty ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_empty_returns_empty_list(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"data": [], "has_more": False})])
    conn = StripeConnector()
    records = await conn.fetch_transactions("sk_test", SINCE, UNTIL)
    assert records == []


# ── TransactionRecord.as_insert_row ──────────────────────────────


@pytest.mark.asyncio
async def test_as_insert_row(monkeypatch):
    txns = [_make_txn("txn_row", "charge", 9900, "Test")]
    _patch_client(monkeypatch, [httpx.Response(200, json={"data": txns, "has_more": False})])
    conn = StripeConnector()
    records = await conn.fetch_transactions("sk_test", SINCE, UNTIL)
    row = records[0].as_insert_row("ws-123", "pk-456")
    assert row["workspace_id"] == "ws-123"
    assert row["provider_key_id"] == "pk-456"
    assert row["provider"] == "stripe"
    assert row["direction"] == "in"
    assert row["amount_cents"] == 9900
