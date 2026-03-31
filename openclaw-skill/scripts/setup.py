"""First-run setup — check deps, create data dir, connect accounts, initial fetch."""
import asyncio
import json
import os
import sys
from pathlib import Path

# Add project root to path
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
from engine.intelligence import FinancialModelManager, categorise_records
from engine.utils import format_currency, get_date_range, is_synthetic_mode

_DATA_DIR = Path.home() / ".token-economy-intel"
_CREDENTIALS_FILE = _DATA_DIR / "credentials.json"

_ACCOUNT_GROUPS = [
    {
        "group": "LLM Billing",
        "accounts": [
            {"name": "openai", "label": "OpenAI", "cls": OpenAIBillingConnector,
             "fields": [("api_key", "OpenAI API key (sk-...)")]},
            {"name": "anthropic", "label": "Anthropic", "cls": AnthropicBillingConnector,
             "fields": [("api_key", "Anthropic API key")]},
        ],
    },
    {
        "group": "Payments",
        "accounts": [
            {"name": "stripe", "label": "Stripe", "cls": StripeConnector,
             "fields": [("api_key", "Stripe secret key (sk_...)")]},
        ],
    },
    {
        "group": "Crypto",
        "accounts": [
            {"name": "crypto", "label": "Crypto Wallet", "cls": CryptoReader,
             "fields": [("wallet_addresses", "Ethereum wallet address(es), comma-separated")]},
        ],
    },
    {
        "group": "Infrastructure",
        "accounts": [
            {"name": "aws", "label": "AWS", "cls": AWSCostsConnector,
             "fields": [("access_key_id", "AWS Access Key ID"), ("secret_access_key", "AWS Secret Access Key")]},
            {"name": "gcp", "label": "GCP", "cls": GCPCostsConnector,
             "fields": [("service_account_json", "GCP service account JSON (paste full JSON)")]},
            {"name": "vercel", "label": "Vercel", "cls": VercelCostsConnector,
             "fields": [("api_token", "Vercel API token")]},
            {"name": "cloudflare", "label": "Cloudflare", "cls": CloudflareCostsConnector,
             "fields": [("api_token", "Cloudflare API token")]},
        ],
    },
    {
        "group": "Communication",
        "accounts": [
            {"name": "twilio", "label": "Twilio", "cls": TwilioCostsConnector,
             "fields": [("account_sid", "Twilio Account SID"), ("auth_token", "Twilio Auth Token")]},
            {"name": "sendgrid", "label": "SendGrid", "cls": SendGridCostsConnector,
             "fields": [("api_key", "SendGrid API key")]},
        ],
    },
    {
        "group": "Monitoring",
        "accounts": [
            {"name": "datadog", "label": "Datadog", "cls": DatadogCostsConnector,
             "fields": [("api_key", "Datadog API key"), ("app_key", "Datadog App key")]},
            {"name": "langsmith", "label": "LangSmith", "cls": LangSmithCostsConnector,
             "fields": [("api_key", "LangSmith API key")]},
        ],
    },
    {
        "group": "Search & Data",
        "accounts": [
            {"name": "pinecone", "label": "Pinecone", "cls": PineconeCostsConnector,
             "fields": [("api_key", "Pinecone API key")]},
            {"name": "tavily", "label": "Tavily", "cls": TavilyCostsConnector,
             "fields": [("api_key", "Tavily API key")]},
        ],
    },
]


def main() -> None:
    tracker = EventTracker()
    synthetic = is_synthetic_mode()

    print("Token Economy Intelligence — Setup")
    print("=" * 50)
    print()

    # 1. Create data directory
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Data directory: {_DATA_DIR}")

    # 2. Check if model already exists
    model = FinancialModelManager()
    model.load()
    if model.get_summary().record_count > 0:
        print(f"Existing model found: {model.get_summary().record_count:,} records")
        print("Run scripts/status.py for current overview.")
        return

    if synthetic:
        print("Running in SYNTHETIC MODE — no real API keys needed.")
        print()
        _run_synthetic(model, tracker)
    else:
        print("Let's connect your accounts. Skip any you don't use.")
        print()
        credentials = _collect_credentials()
        asyncio.run(_connect_and_fetch(model, credentials, tracker))

    print()
    tracker.track("setup_complete", "lifecycle", "openclaw",
                  {"mode": "synthetic" if synthetic else "live"})


def _run_synthetic(model: FinancialModelManager, tracker: EventTracker) -> None:
    """Load synthetic data from all connectors."""
    start, end = get_date_range(90)
    total = 0

    for group in _ACCOUNT_GROUPS:
        for account in group["accounts"]:
            connector = account["cls"]()
            records = connector.get_synthetic_records(start, end)
            n = model.add_records(records, account["name"])
            total += n
            print(f"  {account['label']}: {n} synthetic records")

    # Categorise
    categorised = asyncio.run(categorise_records(model.records))
    model._state.records = categorised

    model.save()
    print(f"\nLoaded {total:,} records across all connectors.")
    print()

    # Show initial overview
    _print_overview(model)


def _collect_credentials() -> dict[str, dict]:
    """Walk user through credential collection."""
    credentials: dict[str, dict] = {}

    for group in _ACCOUNT_GROUPS:
        print(f"--- {group['group']} ---")
        for account in group["accounts"]:
            answer = input(f"  Connect {account['label']}? (y/n): ").strip().lower()
            if answer != "y":
                continue

            creds: dict[str, str] = {}
            for field_key, field_label in account["fields"]:
                value = input(f"    {field_label}: ").strip()
                if field_key == "wallet_addresses":
                    creds[field_key] = [a.strip() for a in value.split(",")]
                else:
                    creds[field_key] = value
            credentials[account["name"]] = creds
        print()

    return credentials


async def _connect_and_fetch(
    model: FinancialModelManager,
    credentials: dict[str, dict],
    tracker: EventTracker,
) -> None:
    """Connect to each account, fetch records, categorise, save."""
    start, end = get_date_range(90)
    total = 0

    for group in _ACCOUNT_GROUPS:
        for account in group["accounts"]:
            name = account["name"]
            if name not in credentials:
                continue

            connector = account["cls"]()
            print(f"  Connecting {account['label']}...", end=" ")

            try:
                connected = await connector.connect(credentials[name])
                if not connected:
                    print("FAILED (check credentials)")
                    continue

                records = await connector.fetch_records(start, end)
                n = model.add_records(records, name)
                total += n
                print(f"OK — {n} records")
                tracker.track("account_connected", "lifecycle", "openclaw",
                              {"provider": name})
            except Exception as exc:
                print(f"ERROR — {exc}")

    if total > 0:
        categorised = await categorise_records(model.records)
        model._state.records = categorised
        model.save()
        print(f"\nFetched {total:,} records. Model saved.")
        print()
        _print_overview(model)
    else:
        print("\nNo records fetched. Run setup again to connect accounts.")


def _print_overview(model: FinancialModelManager) -> None:
    """Print a concise first-run overview."""
    summary = model.get_summary()

    print("Your Token Economy at a Glance")
    print("-" * 40)
    print(f"Monthly spend:  {format_currency(summary.total_monthly_spend)}")

    if summary.spend_by_category:
        for cat, amount in sorted(summary.spend_by_category.items(), key=lambda x: x[1], reverse=True):
            print(f"  {cat:<28} {format_currency(amount)}")

    if summary.revenue_monthly and summary.revenue_monthly > 0:
        print(f"Monthly revenue: {format_currency(summary.revenue_monthly)}")

    if summary.crypto_holdings_usd and summary.crypto_holdings_usd > 0:
        print(f"Crypto holdings: {format_currency(summary.crypto_holdings_usd)}")
        print()
        print("Crypto balances shown for informational purposes only. "
              "This tool does not execute transactions, provide investment "
              "advice, or manage wallets.")

    print(f"\n{summary.record_count:,} records across {len(summary.connected_accounts)} accounts")


if __name__ == "__main__":
    main()
