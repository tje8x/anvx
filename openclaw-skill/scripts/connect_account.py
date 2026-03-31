"""Connect a new account to the financial model."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine.analytics import EventTracker
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
from engine.intelligence import FinancialModelManager
from engine.utils import get_date_range

_PROVIDERS = {
    "openai": {
        "cls": OpenAIBillingConnector,
        "fields": [("api_key", "OpenAI API key (sk-...)")],
    },
    "anthropic": {
        "cls": AnthropicBillingConnector,
        "fields": [("api_key", "Anthropic API key")],
    },
    "stripe": {
        "cls": StripeConnector,
        "fields": [("api_key", "Stripe secret key (sk_...)")],
    },
    "crypto": {
        "cls": CryptoReader,
        "fields": [("wallet_addresses", "Wallet address(es), comma-separated")],
    },
    "aws": {
        "cls": AWSCostsConnector,
        "fields": [("access_key_id", "AWS Access Key ID"), ("secret_access_key", "AWS Secret Access Key")],
    },
    "gcp": {
        "cls": GCPCostsConnector,
        "fields": [("service_account_json", "GCP service account JSON")],
    },
    "vercel": {
        "cls": VercelCostsConnector,
        "fields": [("api_token", "Vercel API token")],
    },
    "cloudflare": {
        "cls": CloudflareCostsConnector,
        "fields": [("api_token", "Cloudflare API token")],
    },
    "twilio": {
        "cls": TwilioCostsConnector,
        "fields": [("account_sid", "Twilio Account SID"), ("auth_token", "Twilio Auth Token")],
    },
    "sendgrid": {
        "cls": SendGridCostsConnector,
        "fields": [("api_key", "SendGrid API key")],
    },
    "datadog": {
        "cls": DatadogCostsConnector,
        "fields": [("api_key", "Datadog API key"), ("app_key", "Datadog App key")],
    },
    "langsmith": {
        "cls": LangSmithCostsConnector,
        "fields": [("api_key", "LangSmith API key")],
    },
    "pinecone": {
        "cls": PineconeCostsConnector,
        "fields": [("api_key", "Pinecone API key")],
    },
    "tavily": {
        "cls": TavilyCostsConnector,
        "fields": [("api_key", "Tavily API key")],
    },
}


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: connect_account.py <provider>")
        print(f"Available: {', '.join(sorted(_PROVIDERS.keys()))}")
        sys.exit(1)

    provider_name = sys.argv[1].lower()
    if provider_name not in _PROVIDERS:
        print(f"Unknown provider: {provider_name}")
        print(f"Available: {', '.join(sorted(_PROVIDERS.keys()))}")
        sys.exit(1)

    provider = _PROVIDERS[provider_name]
    tracker = EventTracker()

    # Collect credentials
    print(f"Connecting {provider_name}...")
    credentials: dict = {}
    for field_key, field_label in provider["fields"]:
        value = input(f"  {field_label}: ").strip()
        if field_key == "wallet_addresses":
            credentials[field_key] = [a.strip() for a in value.split(",")]
        else:
            credentials[field_key] = value

    asyncio.run(_connect(provider_name, provider, credentials, tracker))


async def _connect(
    name: str,
    provider: dict,
    credentials: dict,
    tracker: EventTracker,
) -> None:
    connector = provider["cls"]()

    connected = await connector.connect(credentials)
    if not connected:
        print(f"Failed to connect {name}. Check your credentials.")
        return

    print(f"Connected to {name}. Fetching records...")
    start, end = get_date_range(90)
    records = await connector.fetch_records(start, end)

    model = FinancialModelManager()
    model.load()
    n = model.add_records(records, name)
    model.save()

    print(f"Added {n} records from {name}.")
    tracker.track("account_connected", "lifecycle", "openclaw", {"provider": name})


if __name__ == "__main__":
    main()
