"""Tests for crypto connectors: Ethereum, Solana, Base wallets, Coinbase, Binance."""
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from anvx_core.connectors.ethereum_wallet import EthereumWalletConnector
from anvx_core.connectors.solana_wallet import SolanaWalletConnector
from anvx_core.connectors.base_wallet import BaseWalletConnector
from anvx_core.connectors.coinbase import CoinbaseConnector
from anvx_core.connectors.binance import BinanceConnector

_OriginalAsyncClient = httpx.AsyncClient

NOW = datetime.now(timezone.utc)
SINCE = NOW - timedelta(days=5)
UNTIL = NOW

ETH_ADDR = "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28"
SOL_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA8w9Sx9hAFKP2Y"
TS_UNIX = str(int(NOW.timestamp()) - 3600)

BINANCE_CREDS = json.dumps({"api_key": "bn_key", "api_secret": "bn_secret"})


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


# ── Ethereum Wallet ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_eth_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": "0x1"})])
    conn = EthereumWalletConnector()
    await conn.validate(ETH_ADDR)


@pytest.mark.asyncio
async def test_eth_validate_bad_format():
    conn = EthereumWalletConnector()
    with pytest.raises(PermissionError, match="must start with 0x"):
        await conn.validate("not_an_address")


@pytest.mark.asyncio
async def test_eth_validate_rpc_error(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "error": {"message": "invalid address"}})])
    conn = EthereumWalletConnector()
    with pytest.raises(PermissionError, match="Invalid Ethereum address"):
        await conn.validate(ETH_ADDR)


@pytest.mark.asyncio
async def test_eth_fetch_usage(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"ethereum": {"usd": 3000}}),  # coingecko
        httpx.Response(200, json={"result": [{"timeStamp": TS_UNIX, "gasUsed": "21000", "gasPrice": "20000000000", "hash": "0xabc", "isError": "0"}]}),  # etherscan
    ])
    conn = EthereumWalletConnector()
    records = await conn.fetch_usage(ETH_ADDR, SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].provider == "ethereum_wallet"
    assert records[0].model == "gas"
    assert records[0].total_cost_cents_usd > 0


@pytest.mark.asyncio
async def test_eth_fetch_skips_failed_txs(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"ethereum": {"usd": 3000}}),
        httpx.Response(200, json={"result": [{"timeStamp": TS_UNIX, "gasUsed": "21000", "gasPrice": "20000000000", "hash": "0xfail", "isError": "1"}]}),
    ])
    conn = EthereumWalletConnector()
    records = await conn.fetch_usage(ETH_ADDR, SINCE, UNTIL)
    assert records == []


# ── Solana Wallet ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sol_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"value": 1000000}})])
    conn = SolanaWalletConnector()
    await conn.validate(SOL_ADDR)


@pytest.mark.asyncio
async def test_sol_validate_bad_format():
    conn = SolanaWalletConnector()
    with pytest.raises(PermissionError, match="32-44 characters"):
        await conn.validate("short")


@pytest.mark.asyncio
async def test_sol_fetch_usage(monkeypatch):
    block_time = int(NOW.timestamp()) - 1800
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"solana": {"usd": 150}}),  # coingecko
        httpx.Response(200, json={"result": [{"signature": "sig1", "blockTime": block_time, "err": None}]}),  # rpc
    ])
    conn = SolanaWalletConnector()
    records = await conn.fetch_usage(SOL_ADDR, SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].provider == "solana_wallet"


# ── Base Wallet ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_base_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": "0x1"})])
    conn = BaseWalletConnector()
    await conn.validate(ETH_ADDR)


@pytest.mark.asyncio
async def test_base_validate_bad_format():
    conn = BaseWalletConnector()
    with pytest.raises(PermissionError, match="must start with 0x"):
        await conn.validate("bad")


@pytest.mark.asyncio
async def test_base_fetch_empty(monkeypatch):
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"ethereum": {"usd": 3000}}),
        httpx.Response(200, json={"result": []}),
    ])
    conn = BaseWalletConnector()
    records = await conn.fetch_usage(ETH_ADDR, SINCE, UNTIL)
    assert records == []


# ── Coinbase ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_coinbase_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"data": {"id": "user1"}}, headers={"X-CoinbaseApiScopes": "wallet:transactions:read, wallet:accounts:read"})])
    conn = CoinbaseConnector()
    await conn.validate("cb_token")


@pytest.mark.asyncio
async def test_coinbase_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = CoinbaseConnector()
    with pytest.raises(PermissionError, match="Invalid Coinbase"):
        await conn.validate("cb_bad")


@pytest.mark.asyncio
async def test_coinbase_validate_rejects_write_scope(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"data": {"id": "user1"}}, headers={"X-CoinbaseApiScopes": "wallet:transactions:read, wallet:transactions:write"})])
    conn = CoinbaseConnector()
    with pytest.raises(PermissionError, match="READ-ONLY"):
        await conn.validate("cb_write")


@pytest.mark.asyncio
async def test_coinbase_fetch_transactions(monkeypatch):
    ts_iso = NOW.isoformat()
    _patch_client(monkeypatch, [
        httpx.Response(200, json={"data": [{"id": "acct1"}]}),  # accounts
        httpx.Response(200, json={"data": [{"type": "buy", "created_at": ts_iso, "native_amount": {"amount": "50.00", "currency": "USD"}, "description": "Bought BTC"}]}),  # txs
    ])
    conn = CoinbaseConnector()
    records = await conn.fetch_transactions("cb_token", SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].direction == "out"
    assert records[0].amount_cents == 5000
    assert records[0].category_hint == "crypto_purchase"


# ── Binance ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_binance_validate_success(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"permissions": ["SPOT"], "canTrade": False})])
    conn = BinanceConnector()
    await conn.validate(BINANCE_CREDS)


@pytest.mark.asyncio
async def test_binance_validate_invalid(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(401, json={})])
    conn = BinanceConnector()
    with pytest.raises(PermissionError, match="Invalid Binance"):
        await conn.validate(BINANCE_CREDS)


@pytest.mark.asyncio
async def test_binance_validate_rejects_trade_enabled(monkeypatch):
    _patch_client(monkeypatch, [httpx.Response(200, json={"permissions": ["SPOT"], "canTrade": True})])
    conn = BinanceConnector()
    with pytest.raises(PermissionError, match="READ-ONLY"):
        await conn.validate(BINANCE_CREDS)


@pytest.mark.asyncio
async def test_binance_fetch_transactions(monkeypatch):
    trade_time = int(NOW.timestamp() * 1000) - 60000
    _patch_client(monkeypatch, [httpx.Response(200, json=[{"symbol": "BTCUSDT", "price": "60000", "qty": "0.01", "time": trade_time, "isBuyer": True}])])
    conn = BinanceConnector()
    records = await conn.fetch_transactions(BINANCE_CREDS, SINCE, UNTIL)
    assert len(records) == 1
    assert records[0].direction == "out"  # buyer
    assert records[0].amount_cents == 60000  # 0.01 * 60000 * 100
    assert records[0].category_hint == "crypto_trade"
