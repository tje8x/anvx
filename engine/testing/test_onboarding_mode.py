"""End-to-end test for ONBOARDING_TEST_MODE across all 14 connectors."""
import asyncio
import os
import sys
from pathlib import Path

# Activate test mode before any engine imports
os.environ["ONBOARDING_TEST_MODE"] = "true"

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine.connectors import (
    AWSCostsConnector,
    AnthropicBillingConnector,
    CloudflareCostsConnector,
    CryptoReader,
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
from engine.utils import get_date_range

# Each entry: (provider label, connector class, credentials dict)
_CONNECTORS = [
    ("openai", OpenAIBillingConnector, {"api_key": "sk-test-openai-12345"}),
    ("anthropic", AnthropicBillingConnector, {"api_key": "sk-ant-test-anthropic-12345"}),
    ("stripe", StripeConnector, {"api_key": "sk_test_stripe_12345"}),
    ("aws", AWSCostsConnector, {"access_key_id": "AKIATEST12345", "secret_access_key": "test-secret-12345"}),
    ("gcp", GCPCostsConnector, {"service_account_json": "test-gcp-sa.json"}),
    ("vercel", VercelCostsConnector, {"api_token": "test-vercel-token-12345"}),
    ("cloudflare", CloudflareCostsConnector, {"api_token": "test-cf-token-12345"}),
    ("twilio", TwilioCostsConnector, {"account_sid": "ACtest12345", "auth_token": "test-auth-token-12345"}),
    ("sendgrid", SendGridCostsConnector, {"api_key": "SG.test-sendgrid-12345"}),
    ("datadog", DatadogCostsConnector, {"api_key": "test-dd-api-12345", "app_key": "test-dd-app-12345"}),
    ("langsmith", LangSmithCostsConnector, {"api_key": "test-ls-key-12345"}),
    ("pinecone", PineconeCostsConnector, {"api_key": "test-pc-key-12345"}),
    ("tavily", TavilyCostsConnector, {"api_key": "tvly-test-12345"}),
    ("crypto", CryptoReader, {"wallet_addresses": ["0xTEST1234567890abcdef"]}),
]


async def main() -> None:
    start, end = get_date_range(90)
    passed = 0

    for provider, cls, creds in _CONNECTORS:
        connector = cls()

        # connect with valid test credentials
        ok = await connector.connect(creds)
        assert ok, f"{provider}: connect() returned False"
        assert connector.is_connected, f"{provider}: is_connected is False after connect()"

        # fetch records
        records = await connector.fetch_records(start, end)
        assert len(records) > 0, f"{provider}: fetch_records() returned 0 records"

        print(f"  {provider}: OK — {len(records)} records")
        passed += 1

    # Bad-credentials test (OpenAI with wrong key)
    bad = OpenAIBillingConnector()
    ok = await bad.connect({"api_key": "sk-WRONG-KEY-12345"})
    assert not ok, "bad credentials: connect() should return False"
    assert not bad.is_connected, "bad credentials: is_connected should be False"
    print(f"  openai (bad creds): correctly rejected")

    assert passed == 14, f"Only {passed}/14 connectors passed"
    print(f"\nAll 14 connectors: PASS")


if __name__ == "__main__":
    asyncio.run(main())
