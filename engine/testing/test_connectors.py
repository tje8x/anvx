"""Test suite: every connector with synthetic data, validation, error handling."""
import asyncio
from datetime import date, timedelta
from decimal import Decimal

import pytest

from engine.connectors import (
    AWSCostsConnector,
    AnthropicBillingConnector,
    BinanceExchangeConnector,
    CloudflareCostsConnector,
    CoinbaseExchangeConnector,
    CryptoWalletConnector,
    DatadogCostsConnector,
    GCPCostsConnector,
    LangSmithCostsConnector,
    OpenAIBillingConnector,
    PineconeCostsConnector,
    SendGridCostsConnector,
    StripeConnector,
    TavilyCostsConnector,
    TwilioCostsConnector,
    VercelCostsConnector,
)
from engine.models import FinancialRecord, Provider, SpendCategory

# ── Test data ───────────────────────────────────────────────────

_END = date.today()
_START = _END - timedelta(days=90)

_ALL_CONNECTORS = [
    ("OpenAI", OpenAIBillingConnector, Provider.OPENAI, SpendCategory.AI_INFERENCE),
    ("Anthropic", AnthropicBillingConnector, Provider.ANTHROPIC, SpendCategory.AI_INFERENCE),
    ("Stripe", StripeConnector, Provider.STRIPE, None),  # mixed categories
    ("CryptoWallet", CryptoWalletConnector, Provider.CRYPTO_WALLET, SpendCategory.CRYPTO_HOLDINGS),
    ("Coinbase", CoinbaseExchangeConnector, Provider.COINBASE, SpendCategory.CRYPTO_HOLDINGS),
    ("Binance", BinanceExchangeConnector, Provider.BINANCE, SpendCategory.CRYPTO_HOLDINGS),
    ("AWS", AWSCostsConnector, Provider.AWS, SpendCategory.CLOUD_INFRASTRUCTURE),
    ("GCP", GCPCostsConnector, Provider.GCP, SpendCategory.CLOUD_INFRASTRUCTURE),
    ("Vercel", VercelCostsConnector, Provider.VERCEL, SpendCategory.CLOUD_INFRASTRUCTURE),
    ("Cloudflare", CloudflareCostsConnector, Provider.CLOUDFLARE, SpendCategory.CLOUD_INFRASTRUCTURE),
    ("Twilio", TwilioCostsConnector, Provider.TWILIO, SpendCategory.COMMUNICATION),
    ("SendGrid", SendGridCostsConnector, Provider.SENDGRID, SpendCategory.COMMUNICATION),
    ("Datadog", DatadogCostsConnector, Provider.DATADOG, SpendCategory.MONITORING),
    ("LangSmith", LangSmithCostsConnector, Provider.LANGSMITH, SpendCategory.MONITORING),
    ("Pinecone", PineconeCostsConnector, Provider.PINECONE, SpendCategory.SEARCH_DATA),
    ("Tavily", TavilyCostsConnector, Provider.TAVILY, SpendCategory.SEARCH_DATA),
]


# ── Synthetic data tests ────────────────────────────────────────


class TestSyntheticData:
    """Every connector returns valid FinancialRecord objects in synthetic mode."""

    @pytest.mark.parametrize(
        "name,cls,expected_provider,expected_category",
        _ALL_CONNECTORS,
        ids=[c[0] for c in _ALL_CONNECTORS],
    )
    def test_synthetic_returns_records(
        self, name, cls, expected_provider, expected_category
    ):
        connector = cls()
        records = connector.get_synthetic_records(_START, _END)

        assert len(records) > 0, f"{name} returned no synthetic records"

        # Monthly-billed connectors may round to start of month
        earliest_allowed = _START.replace(day=1)

        for r in records:
            assert isinstance(r, FinancialRecord), f"{name}: not a FinancialRecord"
            assert r.record_date >= earliest_allowed, f"{name}: record_date before start month"
            assert r.record_date <= _END, f"{name}: record_date after end"
            assert isinstance(r.amount, Decimal), f"{name}: amount not Decimal"
            assert r.source == "synthetic", f"{name}: source should be 'synthetic'"
            assert r.provider == expected_provider, (
                f"{name}: expected provider {expected_provider}, got {r.provider}"
            )
            if expected_category is not None:
                assert r.category == expected_category, (
                    f"{name}: expected category {expected_category}, got {r.category}"
                )

    @pytest.mark.parametrize(
        "name,cls,expected_provider,expected_category",
        _ALL_CONNECTORS,
        ids=[c[0] for c in _ALL_CONNECTORS],
    )
    def test_synthetic_deterministic(self, name, cls, expected_provider, expected_category):
        """Synthetic data is deterministic (same seed = same output)."""
        connector1 = cls()
        connector2 = cls()
        records1 = connector1.get_synthetic_records(_START, _END)
        records2 = connector2.get_synthetic_records(_START, _END)
        assert len(records1) == len(records2), f"{name}: record count differs across runs"
        for r1, r2 in zip(records1, records2):
            assert r1.amount == r2.amount, f"{name}: amounts differ across runs"

    def test_all_14_connectors_present(self):
        """Verify we have exactly 14 connectors in the registry."""
        assert len(_ALL_CONNECTORS) == 14


# ── Error handling tests ────────────────────────────────────────


class TestErrorHandling:
    """Connectors handle invalid credentials gracefully."""

    @pytest.mark.asyncio
    async def test_openai_invalid_key(self):
        c = OpenAIBillingConnector()
        result = await c.connect({"api_key": "invalid"})
        assert result is False
        assert c.is_connected is False

    @pytest.mark.asyncio
    async def test_anthropic_empty_key(self):
        c = AnthropicBillingConnector()
        result = await c.connect({"api_key": ""})
        assert result is False

    @pytest.mark.asyncio
    async def test_stripe_invalid_format(self):
        c = StripeConnector()
        result = await c.connect({"api_key": "not_a_stripe_key"})
        assert result is False

    @pytest.mark.asyncio
    async def test_aws_missing_credentials(self):
        c = AWSCostsConnector()
        result = await c.connect({})
        assert result is False

    @pytest.mark.asyncio
    async def test_twilio_missing_credentials(self):
        c = TwilioCostsConnector()
        result = await c.connect({"account_sid": "", "auth_token": ""})
        assert result is False

    @pytest.mark.asyncio
    async def test_crypto_no_addresses(self):
        c = CryptoReader()
        result = await c.connect({})
        assert result is False

    @pytest.mark.asyncio
    async def test_fetch_without_connect(self):
        """fetch_records returns empty list if not connected."""
        c = OpenAIBillingConnector()
        records = await c.fetch_records(_START, _END)
        assert records == []


# ── Synthetic mode check ────────────────────────────────────────


class TestSyntheticMode:
    """Synthetic mode works for every connector without real API keys."""

    @pytest.mark.parametrize(
        "name,cls,expected_provider,expected_category",
        _ALL_CONNECTORS,
        ids=[c[0] for c in _ALL_CONNECTORS],
    )
    def test_synthetic_no_api_key_needed(self, name, cls, expected_provider, expected_category):
        """get_synthetic_records works without calling connect()."""
        connector = cls()
        assert connector.is_connected is False
        records = connector.get_synthetic_records(_START, _END)
        assert len(records) > 0, f"{name}: synthetic data requires no connection"
