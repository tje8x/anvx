# v1-compat: filesystem state path, removed post-launch with v1 fallback code
"""Token Economy Intelligence — MCP Server.

Provides unified financial intelligence across LLM costs, cloud infrastructure,
payments, communication, monitoring, search/data, and crypto holdings.

Transport: stdio
State: ~/.token-economy-intel/model.json

Usage:
    uv run python mcp-server/server.py
"""
import asyncio
import json
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

# Add packages/core/src to path so anvx_core is importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages" / "core" / "src"))

from mcp.server import FastMCP

from anvx_core.analytics import EventTracker
from anvx_core.connectors import (
    AWSCostsConnector,
    AnthropicBillingConnector,
    BinanceExchangeConnector,
    CloudflareCostsConnector,
    CoinbaseExchangeConnector,
    CryptoWalletConnector,
    DatadogCostsConnector,
    GCPCostsConnector,
    GeminiBillingConnector,
    GoogleAdsConnector,
    LangSmithCostsConnector,
    MetaAdsConnector,
    OpenAIBillingConnector,
    PineconeCostsConnector,
    SendGridCostsConnector,
    StripeConnector,
    TavilyCostsConnector,
    TwilioCostsConnector,
    VercelCostsConnector,
)
from anvx_core.intelligence import (
    FinancialModelManager,
    categorise_records,
    detect_anomalies,
    generate_recommendations,
)
from anvx_core.credentials import CredentialStore
from anvx_core.models import Provider, SpendCategory
from anvx_core.utils import format_currency, format_percent, get_date_range, is_onboarding_test_mode, is_synthetic_mode

# ── Server setup ────────────────────────────────────────────────

server = FastMCP(
    name="anvx",
    instructions=(
        "Unified financial intelligence for AI-native businesses. "
        "Tracks spending across LLM APIs, cloud infrastructure, payments, "
        "communication, monitoring, search/data tools, and crypto holdings."
    ),
)

_tracker = EventTracker()

_CONNECTOR_REGISTRY: list[dict] = [
    {
        "name": "openai", "label": "OpenAI", "group": "AI",
        "cls": OpenAIBillingConnector,
        "credentials": [{"key": "api_key", "label": "OpenAI API key (sk-...)"}],
        "where_to_find": "https://platform.openai.com/api-keys → 'Create new secret key'. Needs read access to usage data.",
    },
    {
        "name": "anthropic", "label": "Anthropic", "group": "AI",
        "cls": AnthropicBillingConnector,
        "credentials": [{"key": "api_key", "label": "Anthropic Admin API key"}],
        "where_to_find": "https://console.anthropic.com/settings/admin-keys → 'Create Admin Key' (separate from regular API keys).",
    },
    {
        "name": "gemini", "label": "Gemini (Google AI)", "group": "AI",
        "cls": GeminiBillingConnector,
        "credentials": [{"key": "api_key", "label": "Gemini API key"}],
        "where_to_find": "https://aistudio.google.com/apikey → 'Create API Key'. Works for Gemini Pro, Flash, and other models.",
    },
    {
        "name": "stripe", "label": "Stripe", "group": "Payments",
        "cls": StripeConnector,
        "credentials": [{"key": "api_key", "label": "Stripe restricted key (rk_...) or secret key (sk_...)"}],
        "where_to_find": "https://dashboard.stripe.com/apikeys → 'Create restricted key' with read permissions on Charges, Balance, Payouts.",
    },
    {
        "name": "meta", "label": "Meta Ads (Facebook/Instagram)", "group": "Advertising",
        "cls": MetaAdsConnector,
        "credentials": [
            {"key": "access_token", "label": "Meta access token"},
            {"key": "ad_account_id", "label": "Ad account ID (act_...)"},
        ],
        "where_to_find": "developers.facebook.com → Your App → Marketing API → Generate long-lived access token. Ad account ID from Business Manager.",
    },
    {
        "name": "google_ads", "label": "Google Ads", "group": "Advertising",
        "cls": GoogleAdsConnector,
        "credentials": [
            {"key": "developer_token", "label": "Google Ads developer token"},
            {"key": "customer_id", "label": "Customer ID (123-456-7890)"},
        ],
        "where_to_find": "Google Ads → Tools → API Center → Developer token. Customer ID from the top-right of the Google Ads dashboard.",
    },
    {
        "name": "crypto_wallet", "label": "Crypto Wallet (on-chain)", "group": "Crypto",
        "cls": CryptoWalletConnector,
        "credentials": [{"key": "wallets", "label": "List of {chain, address} pairs (Ethereum, Solana, Base, Arbitrum, Polygon)"}],
        "where_to_find": "Public wallet addresses only. NEVER share private keys or seed phrases. Read-only via block explorer APIs.",
    },
    {
        "name": "coinbase", "label": "Coinbase", "group": "Crypto",
        "cls": CoinbaseExchangeConnector,
        "credentials": [
            {"key": "api_key", "label": "Coinbase API key"},
            {"key": "api_secret", "label": "Coinbase API secret"},
        ],
        "where_to_find": "https://www.coinbase.com/settings/api → 'New API Key'. Grant ONLY 'wallet:accounts:read' — read-only, no other permissions.",
    },
    {
        "name": "binance", "label": "Binance", "group": "Crypto",
        "cls": BinanceExchangeConnector,
        "credentials": [
            {"key": "api_key", "label": "Binance API key"},
            {"key": "api_secret", "label": "Binance API secret"},
        ],
        "where_to_find": "https://www.binance.com/en/my/settings/api-management → 'Create API'. Enable ONLY 'Read Info' — all other permissions disabled.",
    },
    {
        "name": "aws", "label": "AWS", "group": "Cloud",
        "cls": AWSCostsConnector,
        "credentials": [
            {"key": "access_key_id", "label": "AWS Access Key ID"},
            {"key": "secret_access_key", "label": "AWS Secret Access Key"},
            {"key": "region", "label": "AWS region (default: us-east-1)"},
        ],
        "where_to_find": "AWS Console → IAM → Users → Create user with 'ce:GetCostAndUsage' policy → Security credentials → Create access key.",
    },
    {
        "name": "gcp", "label": "Google Cloud", "group": "Cloud",
        "cls": GCPCostsConnector,
        "credentials": [{"key": "service_account_json", "label": "Service account JSON (full file contents)"}],
        "where_to_find": "GCP Console → IAM & Admin → Service Accounts → Create with 'Billing Account Viewer' role → Keys → Add JSON key.",
    },
    {
        "name": "vercel", "label": "Vercel", "group": "Cloud",
        "cls": VercelCostsConnector,
        "credentials": [{"key": "api_token", "label": "Vercel API token"}],
        "where_to_find": "https://vercel.com/account/tokens → 'Create Token' with read scope on your team.",
    },
    {
        "name": "cloudflare", "label": "Cloudflare", "group": "Cloud",
        "cls": CloudflareCostsConnector,
        "credentials": [{"key": "api_token", "label": "Cloudflare API token"}],
        "where_to_find": "https://dash.cloudflare.com/profile/api-tokens → 'Create Token' with 'Account Analytics Read' and 'Workers R2 Storage Read' permissions.",
    },
    {
        "name": "twilio", "label": "Twilio", "group": "Communication",
        "cls": TwilioCostsConnector,
        "credentials": [
            {"key": "account_sid", "label": "Twilio Account SID"},
            {"key": "auth_token", "label": "Twilio Auth Token"},
        ],
        "where_to_find": "https://console.twilio.com → Account → API keys & tokens. The Account SID and Auth Token are on the dashboard.",
    },
    {
        "name": "sendgrid", "label": "SendGrid", "group": "Communication",
        "cls": SendGridCostsConnector,
        "credentials": [{"key": "api_key", "label": "SendGrid API key"}],
        "where_to_find": "https://app.sendgrid.com/settings/api_keys → 'Create API Key' with 'Read Access' on Stats and Account.",
    },
    {
        "name": "datadog", "label": "Datadog", "group": "Monitoring",
        "cls": DatadogCostsConnector,
        "credentials": [
            {"key": "api_key", "label": "Datadog API key"},
            {"key": "app_key", "label": "Datadog Application key"},
        ],
        "where_to_find": "https://app.datadoghq.com/organization-settings/api-keys for the API key, /application-keys for the App key. Requires Pro or Enterprise plan.",
    },
    {
        "name": "langsmith", "label": "LangSmith", "group": "Monitoring",
        "cls": LangSmithCostsConnector,
        "credentials": [{"key": "api_key", "label": "LangSmith API key"}],
        "where_to_find": "https://smith.langchain.com/settings → API keys → 'Create API Key'.",
    },
    {
        "name": "pinecone", "label": "Pinecone", "group": "Search/Data",
        "cls": PineconeCostsConnector,
        "credentials": [{"key": "api_key", "label": "Pinecone API key"}],
        "where_to_find": "https://app.pinecone.io → API Keys → 'Create API Key'.",
    },
    {
        "name": "tavily", "label": "Tavily", "group": "Search/Data",
        "cls": TavilyCostsConnector,
        "credentials": [{"key": "api_key", "label": "Tavily API key (tvly-...)"}],
        "where_to_find": "https://app.tavily.com → API Keys.",
    },
]

_PRIVACY_NOTE = (
    "All credentials and financial data are stored locally on your machine "
    "(~/.token-economy-intel/). Nothing is sent to external services except "
    "the provider APIs you connect. This tool is strictly read-only — it "
    "cannot move funds, exchange assets, or modify any account state."
)

_CATEGORY_KEYWORDS: list[tuple[list[str], SpendCategory]] = [
    (["ai inference", "ai spend", "llm", "model cost", "gpt", "claude"], SpendCategory.AI_INFERENCE),
    (["ai training", "fine-tun", "training"], SpendCategory.AI_TRAINING),
    (["cloud", "infrastructure", "aws", "gcp", "vercel", "cloudflare", "hosting"], SpendCategory.CLOUD_INFRASTRUCTURE),
    (["saas", "subscription"], SpendCategory.SAAS_SUBSCRIPTION),
    (["payment process", "stripe fee"], SpendCategory.PAYMENT_PROCESSING),
    (["communication", "twilio", "sendgrid", "sms", "email"], SpendCategory.COMMUNICATION),
    (["monitoring", "datadog", "langsmith", "observability"], SpendCategory.MONITORING),
    (["search", "pinecone", "tavily", "vector"], SpendCategory.SEARCH_DATA),
    (["crypto", "wallet", "bitcoin", "ethereum"], SpendCategory.CRYPTO_HOLDINGS),
    (["revenue", "income", "sales"], SpendCategory.REVENUE),
]

_PROVIDER_KEYWORDS: dict[str, str] = {
    "openai": "openai", "anthropic": "anthropic", "stripe": "stripe",
    "aws": "aws", "gcp": "gcp", "vercel": "vercel", "cloudflare": "cloudflare",
    "twilio": "twilio", "sendgrid": "sendgrid", "datadog": "datadog",
    "langsmith": "langsmith", "pinecone": "pinecone", "tavily": "tavily",
}


# ── Helpers ─────────────────────────────────────────────────────


def _load_model() -> FinancialModelManager:
    model = FinancialModelManager()
    model.load()
    return model


def _ensure_data(model: FinancialModelManager) -> None:
    """Load synthetic data if model is empty and in synthetic mode."""
    if model.get_summary().record_count > 0:
        return
    if not is_synthetic_mode():
        return
    start, end = get_date_range(90)
    for entry in _CONNECTOR_REGISTRY:
        records = entry["cls"]().get_synthetic_records(start, end)
        model.add_records(records, entry["name"])
    categorised = asyncio.get_event_loop().run_until_complete(
        categorise_records(model.records)
    )
    model._state.records = categorised
    model._state.last_updated = datetime.now()
    model.save()


async def _auto_connect_from_keyring(model: FinancialModelManager) -> list[str]:
    """Auto-connect providers that have stored credentials in the keyring.

    Returns list of provider names that were successfully connected.
    """
    manifest = CredentialStore.get_manifest()
    if not manifest:
        return []

    already_connected = set(model.get_summary().connected_accounts)
    newly_connected: list[str] = []
    start, end = get_date_range(90)
    registry_map = {e["name"]: e for e in _CONNECTOR_REGISTRY}

    for provider_name, labels in manifest.items():
        if provider_name in already_connected:
            continue
        entry = registry_map.get(provider_name)
        if entry is None:
            continue

        # Use the first label's credentials
        label = labels[0] if labels else "default"
        creds = CredentialStore.get_all_credentials(provider_name, label)
        if not creds:
            continue

        connector = entry["cls"]()
        try:
            ok = await connector.connect(creds)
            if not ok:
                continue
            records = await connector.fetch_records(start, end)
            n = model.add_records(records, provider_name)
            newly_connected.append(provider_name)
        except Exception:
            continue

    if newly_connected:
        model.save()

    return newly_connected


def _decimal_to_str(obj: object) -> object:
    """Recursively convert Decimals to strings for JSON serialization."""
    if isinstance(obj, Decimal):
        return str(obj)
    if isinstance(obj, dict):
        return {k: _decimal_to_str(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_decimal_to_str(item) for item in obj]
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


# ── Resource ────────────────────────────────────────────────────


@server.resource("resource://financial-model")
def financial_model_resource() -> str:
    """Current state of the financial model."""
    model = _load_model()
    _ensure_data(model)
    return model.get_context_for_llm()


# ── Tools ───────────────────────────────────────────────────────


@server.tool()
def get_financial_overview() -> str:
    """Get a complete financial overview across all connected providers.

    Returns monthly spend by category and provider, revenue, margin,
    crypto holdings, and anomaly count.
    """
    model = _load_model()
    _ensure_data(model)
    summary = model.get_summary()

    result = {
        "last_updated": summary.last_updated.isoformat(),
        "record_count": summary.record_count,
        "data_coverage_days": summary.data_coverage_days,
        "connected_accounts": summary.connected_accounts,
        "total_monthly_spend": format_currency(summary.total_monthly_spend),
        "spend_by_category": {
            cat: format_currency(amt)
            for cat, amt in sorted(
                summary.spend_by_category.items(), key=lambda x: x[1], reverse=True
            )
        },
        "spend_by_provider": {
            prov: format_currency(amt)
            for prov, amt in sorted(
                summary.spend_by_provider.items(), key=lambda x: x[1], reverse=True
            )
        },
    }

    if summary.revenue_monthly and summary.revenue_monthly > 0:
        result["monthly_revenue"] = format_currency(summary.revenue_monthly)
        if summary.total_monthly_spend > 0:
            margin = float(
                (summary.revenue_monthly - summary.total_monthly_spend)
                / summary.revenue_monthly * 100
            )
            result["gross_margin"] = format_percent(margin)

    if summary.crypto_holdings_usd and summary.crypto_holdings_usd > 0:
        result["crypto_holdings"] = format_currency(summary.crypto_holdings_usd)
        result["crypto_disclaimer"] = (
            "Crypto balances shown for informational purposes only. "
            "This tool does not execute transactions, provide investment "
            "advice, or manage wallets."
        )

    _tracker.track("overview_viewed", "intelligence", "mcp")
    model.save()
    return json.dumps(result, indent=2)


@server.tool()
def query_spending(
    question: str,
    time_range: str = "30d",
    category: str = "",
    provider: str = "",
    label: str = "",
) -> str:
    """Query spending data with natural language or filters.

    Args:
        question: Natural language question about spending.
        time_range: Time range — "7d", "30d", "90d", or "all". Default "30d".
        category: Filter by SpendCategory value (e.g. "ai_inference", "cloud_infrastructure").
        provider: Filter by Provider value (e.g. "openai", "aws", "stripe").
        label: Filter by credential label (e.g. "production", "personal").
               Useful for multi-key providers: "How much is my production OpenAI costing?"
    """
    model = _load_model()
    _ensure_data(model)

    # Parse time range
    days = {"7d": 7, "30d": 30, "90d": 90, "all": 9999}.get(time_range, 30)
    cutoff = date.today() - timedelta(days=days)
    recent = [r for r in model.records if r.record_date >= cutoff]

    # Label filter: records from a specific credential label are stored
    # with source containing the label (e.g. account_name "openai:production")
    if label:
        q = question.lower()
        # Detect provider from question if not explicit
        if not provider:
            for keyword, prov in _PROVIDER_KEYWORDS.items():
                if keyword in q:
                    provider = prov
                    break
        if provider:
            # Filter to records matching provider:label account name
            label_account = f"{provider}:{label}"
            recent = [
                r for r in recent
                if r.provider.value == provider
            ]
            # Note: records stored with label in connected_accounts
            # can be further filtered if we track source account names

    # Explicit category filter
    if category:
        try:
            cat = SpendCategory(category)
            return _category_breakdown(recent, cat, time_range)
        except ValueError:
            pass

    # Explicit provider filter
    if provider:
        return _provider_breakdown(recent, provider, time_range)

    # Parse question for category
    q = question.lower()
    for keywords, cat in _CATEGORY_KEYWORDS:
        if any(kw in q for kw in keywords):
            return _category_breakdown(recent, cat, time_range)

    # Parse question for provider
    for keyword, prov in _PROVIDER_KEYWORDS.items():
        if keyword in q:
            return _provider_breakdown(recent, prov, time_range)

    # Top/biggest
    if any(w in q for w in ["biggest", "largest", "top", "most"]):
        summary = model.get_summary()
        result = {"question": question, "time_range": time_range}
        result["top_categories"] = {
            cat: format_currency(amt)
            for cat, amt in sorted(
                summary.spend_by_category.items(), key=lambda x: x[1], reverse=True
            )
        }
        _tracker.track("query", "intelligence", "mcp", {"intent": "top"})
        model.save()
        return json.dumps(result, indent=2)

    # Fallback: total
    model.record_query(question)
    summary = model.get_summary()
    result = {
        "question": question,
        "total_monthly_spend": format_currency(summary.total_monthly_spend),
    }
    if summary.revenue_monthly and summary.revenue_monthly > 0:
        result["monthly_revenue"] = format_currency(summary.revenue_monthly)
    result["context"] = model.get_context_for_llm()
    _tracker.track("query", "intelligence", "mcp", {"intent": "fallback"})
    model.save()
    return json.dumps(result, indent=2)


@server.tool()
def get_recommendations(focus: str = "all") -> str:
    """Get cost optimisation recommendations.

    Args:
        focus: Area to focus on — "model_routing", "api_costs", "subscriptions",
               "infrastructure", "cross_bucket", or "all" (default).
    """
    model = _load_model()
    _ensure_data(model)
    recs = generate_recommendations(model.records)

    # Filter by focus area
    focus_map = {
        "model_routing": ["model_routing"],
        "api_costs": ["model_routing", "ai_revenue_ratio"],
        "subscriptions": ["unused_subscription"],
        "infrastructure": ["unused_subscription"],
        "cross_bucket": ["ai_revenue_ratio"],
        "all": None,
    }
    allowed = focus_map.get(focus)
    if allowed is not None:
        recs = [r for r in recs if r.rec_type in allowed]

    result = {
        "focus": focus,
        "count": len(recs),
        "recommendations": [
            {
                "type": r.rec_type,
                "description": r.description,
                "estimated_monthly_savings": format_currency(r.estimated_monthly_savings) if r.estimated_monthly_savings else None,
                "confidence": r.confidence,
                "action_required": r.action_required,
                "category": r.category.value,
            }
            for r in recs
        ],
    }

    _tracker.track("recommendations_viewed", "intelligence", "mcp",
                   {"focus": focus, "count": len(recs)})
    model.save()
    return json.dumps(result, indent=2)


@server.tool()
async def connect_account(
    provider: str, credentials: dict, label: str = "default"
) -> str:
    """Connect a new data source. Validates credentials, fetches data,
    and stores credentials securely in the system keychain for auto-reconnect.

    Args:
        provider: Provider name — one of: openai, anthropic, stripe,
                  crypto_wallet, coinbase, binance, aws, gcp, vercel,
                  cloudflare, twilio, sendgrid, datadog, langsmith,
                  pinecone, tavily.
        credentials: Provider-specific credentials dict. Examples:
                     OpenAI: {"api_key": "sk-..."}
                     AWS: {"access_key_id": "...", "secret_access_key": "..."}
                     Crypto: {"wallets": [{"chain": "ethereum", "address": "0x..."}]}
        label: Key label for multi-key support (default: "default").
               Use descriptive labels like "production", "staging", "personal"
               when connecting the same provider with multiple API keys.
    """
    entry = next((e for e in _CONNECTOR_REGISTRY if e["name"] == provider), None)
    if entry is None:
        available = ", ".join(e["name"] for e in _CONNECTOR_REGISTRY)
        return json.dumps({"error": f"Unknown provider: {provider}", "available": available})

    connector = entry["cls"]()

    try:
        connected = await connector.connect(credentials)
    except Exception as exc:
        return json.dumps({"error": f"Connection failed: {exc}", "provider": provider})

    if not connected:
        return json.dumps({"error": "Connection failed — check credentials", "provider": provider})

    # Store credentials in keyring for auto-reconnect
    try:
        for field, value in credentials.items():
            if isinstance(value, str):
                CredentialStore.store_credential(provider, label, field, value)
            elif isinstance(value, list):
                CredentialStore.store_credential(
                    provider, label, field, json.dumps(value)
                )
        CredentialStore.update_manifest(provider, label)
    except Exception:
        pass  # Keyring unavailable — credentials still work for this session

    start, end = get_date_range(90)
    try:
        records = await connector.fetch_records(start, end)
    except Exception as exc:
        return json.dumps({"error": f"Fetch failed: {exc}", "provider": provider, "connected": True})

    model = _load_model()
    # Use provider:label as the account name for multi-key tracking
    account_name = f"{provider}:{label}" if label != "default" else provider
    n = model.add_records(records, account_name)
    model.save()

    _tracker.track("account_connected", "lifecycle", "mcp",
                   {"provider": provider, "label": label})

    result: dict = {
        "provider": provider,
        "label": label,
        "connected": True,
        "records_added": n,
        "total_records": model.get_summary().record_count,
    }
    if records:
        days = (max(r.record_date for r in records)
                - min(r.record_date for r in records)).days + 1
        services = {
            r.model or r.subcategory or r.category.value
            for r in records
        }
        result["days_of_data"] = days
        result["models_or_services"] = sorted(services)
        result["message"] = (
            f"Connected {entry['label']}"
            f"{' (' + label + ')' if label != 'default' else ''}. "
            f"Found {days} days of data across {len(services)} models/services."
        )
    else:
        result["message"] = f"Connected {entry['label']}. No records in range."

    return json.dumps(result, indent=2)


@server.tool()
def upload_bank_csv(file_path: str) -> str:
    """Upload a bank statement CSV for a fuller picture of spending.

    Accepts a CSV with columns: date, description, amount, balance.
    Parses transactions, auto-categorises them, and adds to the financial model.

    In onboarding test mode, pass "test" as file_path to load the synthetic
    bank statement. In production, "test" is rejected as an invalid path.

    Args:
        file_path: Path to a .csv bank statement, or "test" in test mode.
    """
    import csv as csv_mod
    from collections import Counter
    from decimal import Decimal
    from pathlib import Path as P

    from anvx_core.models import FinancialRecord, Provider as Prov, SpendCategory

    test_mode = is_onboarding_test_mode()

    # Handle "test" keyword
    if file_path.strip().lower() == "test":
        if test_mode:
            file_path = str(
                P(__file__).resolve().parents[1]
                / "engine" / "testing" / "data" / "bank_statement.csv"
            )
        else:
            return json.dumps({
                "error": "Invalid file path. Please provide a path to a .csv file.",
            })

    if not file_path.endswith(".csv"):
        return json.dumps({"error": "File must be a .csv file."})

    try:
        records: list[FinancialRecord] = []
        vendor_counter: Counter[str] = Counter()
        skipped = 0

        with open(file_path, newline="") as f:
            reader = csv_mod.DictReader(f)
            for row_num, row in enumerate(reader, start=2):
                try:
                    description = row.get("description", "")
                    amount = Decimal(row.get("amount", "0"))
                    record_date = date.fromisoformat(row.get("date", "").strip())
                except (ValueError, ArithmeticError):
                    skipped += 1
                    continue

                vendor = description.split("*")[0].strip().split(" ")[0]
                vendor_counter[vendor] += 1

                category = SpendCategory.OTHER
                desc_upper = description.upper()
                if amount > 0:
                    category = SpendCategory.REVENUE
                elif any(kw in desc_upper for kw in ("OPENAI", "ANTHROPIC")):
                    category = SpendCategory.AI_INFERENCE
                elif any(kw in desc_upper for kw in ("AWS", "GOOGLE CLOUD", "VERCEL", "CLOUDFLARE", "DIGITALOCEAN")):
                    category = SpendCategory.CLOUD_INFRASTRUCTURE
                elif "STRIPE" in desc_upper and "FEE" in desc_upper:
                    category = SpendCategory.PAYMENT_PROCESSING
                elif any(kw in desc_upper for kw in ("TWILIO", "SENDGRID", "SLACK")):
                    category = SpendCategory.COMMUNICATION
                elif any(kw in desc_upper for kw in ("DATADOG", "LANGSMITH")):
                    category = SpendCategory.MONITORING
                elif any(kw in desc_upper for kw in ("PINECONE", "TAVILY")):
                    category = SpendCategory.SEARCH_DATA

                records.append(
                    FinancialRecord(
                        record_date=record_date,
                        amount=amount,
                        category=category,
                        provider=Prov.OTHER,
                        source="bank_csv",
                        raw_description=description,
                    )
                )

        if not records:
            return json.dumps({"error": "No valid transactions found in CSV."})

        model = _load_model()
        n = model.add_records(records, "bank_csv")
        model.save()

        categorised_count = sum(1 for r in records if r.category != SpendCategory.OTHER)
        pct = round(categorised_count / len(records) * 100)
        top_vendors = [v for v, _ in vendor_counter.most_common(5)]

        _tracker.track("bank_csv_uploaded", "lifecycle", "mcp",
                       {"transactions": len(records)})

        result: dict = {
            "parsed_transactions": len(records),
            "categorised_percent": pct,
            "top_vendors": top_vendors,
            "records_added": n,
            "total_records": model.get_summary().record_count,
            "message": (
                f"Parsed {len(records)} transactions. Categorised {pct}%. "
                f"Top vendors: {', '.join(top_vendors)}."
            ),
        }
        if skipped:
            result["skipped_rows"] = skipped

        return json.dumps(result, indent=2)

    except FileNotFoundError:
        return json.dumps({"error": f"File not found: {file_path}"})
    except Exception as exc:
        return json.dumps({"error": f"Error parsing CSV: {exc}"})


@server.tool()
def detect_spending_anomalies() -> str:
    """Detect spending anomalies across all connected providers.

    Compares current week against a 4-week rolling baseline per category.
    Flags categories with >30% deviation.
    """
    model = _load_model()
    _ensure_data(model)
    anomalies = detect_anomalies(model.records)

    result = {
        "count": len(anomalies),
        "anomalies": [
            {
                "category": a.category,
                "severity": a.severity,
                "description": a.description,
                "current_amount": format_currency(a.current_amount),
                "baseline_amount": format_currency(a.baseline_amount),
                "deviation_percent": format_percent(a.deviation_percent),
            }
            for a in anomalies
        ],
    }

    _tracker.track("anomalies_viewed", "intelligence", "mcp",
                   {"count": len(anomalies)})
    model.save()
    return json.dumps(result, indent=2)


@server.tool()
def list_providers() -> str:
    """List all 16 supported providers grouped by category, with credential
    instructions for each. Use this when a user first asks about tracking
    spending — present the categories so they can choose which to connect.

    Returns providers grouped by category (AI, Cloud, Payments, Communication,
    Monitoring, Search/Data, Crypto), each with the credentials needed and
    where to find them. Includes a privacy note about local-only storage.
    """
    model = _load_model()
    connected = set(model.get_summary().connected_accounts)
    synthetic = is_synthetic_mode()

    # Group providers by category
    by_group: dict[str, list[dict]] = {}
    for entry in _CONNECTOR_REGISTRY:
        name = entry["name"]
        if name in connected:
            status = "synthetic" if synthetic else "connected"
        else:
            status = "disconnected"

        provider_info = {
            "name": name,
            "label": entry["label"],
            "status": status,
            "credentials": entry["credentials"],
            "where_to_find": entry["where_to_find"],
        }
        by_group.setdefault(entry["group"], []).append(provider_info)

    # Preserve a sensible group order
    group_order = ["AI", "Cloud", "Payments", "Advertising",
                   "Communication", "Monitoring", "Search/Data", "Crypto"]
    categories = {
        g: by_group[g] for g in group_order if g in by_group
    }

    result = {
        "total_providers": len(_CONNECTOR_REGISTRY),
        "connected_count": sum(
            1 for entries in by_group.values()
            for p in entries if p["status"] != "disconnected"
        ),
        "categories": categories,
        "privacy_note": _PRIVACY_NOTE,
        "next_step": (
            "Ask the user which categories/providers they use. For each one "
            "they select, use the `where_to_find` text to explain how to get "
            "the credential, then call `connect_account` with the provider "
            "name and credentials dict."
        ),
    }

    _tracker.track("providers_listed", "ui", "mcp")
    return json.dumps(result, indent=2)


@server.tool()
def get_setup_status() -> str:
    """Check which providers are connected via keyring credentials and/or
    have data in the financial model. Use on every interaction to skip
    providers the user has already set up.

    Returns:
    - Providers with stored credentials (from keyring manifest) and their labels
    - Providers with data in the model (from previous fetches)
    - Missing providers that can still be connected
    - No credentials are included in the response — only names and status
    """
    model = _load_model()
    summary = model.get_summary()
    model_accounts = set(summary.connected_accounts)
    synthetic = is_synthetic_mode()

    # Keyring manifest: {provider: [labels]}
    manifest = CredentialStore.get_manifest()

    # Per-provider record counts from model
    record_counts: dict[str, int] = {}
    last_dates: dict[str, str] = {}
    for r in model.records:
        prov = r.provider.value
        record_counts[prov] = record_counts.get(prov, 0) + 1
        d = r.record_date.isoformat()
        if prov not in last_dates or d > last_dates[prov]:
            last_dates[prov] = d

    connected = []
    has_credentials = []
    missing = []
    for entry in _CONNECTOR_REGISTRY:
        name = entry["name"]
        labels = manifest.get(name, [])
        in_model = name in model_accounts

        info: dict = {
            "name": name,
            "label": entry["label"],
            "group": entry["group"],
        }

        if in_model:
            info["status"] = "synthetic" if synthetic else "connected"
            info["labels"] = labels if labels else ["default"]
            info["records"] = record_counts.get(name, 0)
            info["last_record_date"] = last_dates.get(name)
            connected.append(info)
        elif labels:
            # Has keyring credentials but no data yet — can auto-connect
            info["status"] = "credentials_stored"
            info["labels"] = labels
            has_credentials.append(info)
        else:
            missing.append(info)

    is_first_use = len(connected) == 0 and len(has_credentials) == 0
    result: dict = {
        "is_first_use": is_first_use,
        "total_providers": len(_CONNECTOR_REGISTRY),
        "connected_count": len(connected),
        "connected": connected,
    }

    if has_credentials:
        result["credentials_stored_count"] = len(has_credentials)
        result["credentials_stored"] = has_credentials
        result["auto_connect_hint"] = (
            "These providers have stored credentials but no data yet. "
            "They will auto-connect on the next data refresh."
        )

    result["missing_count"] = len(missing)
    result["missing"] = missing
    result["last_updated"] = (
        summary.last_updated.isoformat()
        if summary.last_updated.year > 2000 else None
    )

    if is_first_use:
        result["next_step"] = "Call list_providers to show available categories."
    elif has_credentials:
        result["next_step"] = (
            "Auto-connect providers with stored credentials, "
            "then ask if the user wants to add more."
        )
    else:
        result["next_step"] = (
            "Skip already-connected providers. Ask the user if they want "
            "to add any from the 'missing' list, or proceed with current data."
        )

    _tracker.track("setup_status_checked", "ui", "mcp",
                   {"connected": len(connected)})
    return json.dumps(result, indent=2)


# ── Private breakdown helpers ───────────────────────────────────


def _category_breakdown(records: list, category: SpendCategory, time_range: str) -> str:
    filtered = [r for r in records if r.category == category]

    if not filtered:
        return json.dumps({"category": category.value, "total": "$0.00", "message": "No records found"})

    total = sum(abs(r.amount) for r in filtered)

    by_sub: dict[str, Decimal] = defaultdict(Decimal)
    for r in filtered:
        key = r.model or r.subcategory or r.provider.value
        by_sub[key] += abs(r.amount)

    by_prov: dict[str, Decimal] = defaultdict(Decimal)
    for r in filtered:
        by_prov[r.provider.value] += abs(r.amount)

    result = {
        "category": category.value,
        "time_range": time_range,
        "total": format_currency(total),
        "breakdown": {
            sub: {"amount": format_currency(amt), "percent": f"{float(amt / total * 100):.1f}%"}
            for sub, amt in sorted(by_sub.items(), key=lambda x: x[1], reverse=True)
        },
    }

    if len(by_prov) > 1:
        result["by_provider"] = {
            prov: format_currency(amt)
            for prov, amt in sorted(by_prov.items(), key=lambda x: x[1], reverse=True)
        }

    if category == SpendCategory.CRYPTO_HOLDINGS:
        result["disclaimer"] = (
            "Crypto balances shown for informational purposes only. "
            "This tool does not execute transactions, provide investment "
            "advice, or manage wallets."
        )

    _tracker.track("query", "intelligence", "mcp",
                   {"intent": "category", "category": category.value})
    return json.dumps(result, indent=2)


def _provider_breakdown(records: list, provider_value: str, time_range: str) -> str:
    filtered = [r for r in records if r.provider.value == provider_value]

    if not filtered:
        return json.dumps({"provider": provider_value, "total": "$0.00", "message": "No records found"})

    costs = sum(abs(r.amount) for r in filtered if r.amount < 0)
    revenue = sum(r.amount for r in filtered if r.amount > 0)

    by_sub: dict[str, Decimal] = defaultdict(Decimal)
    for r in filtered:
        key = r.model or r.subcategory or r.category.value
        by_sub[key] += abs(r.amount)

    result: dict = {
        "provider": provider_value,
        "time_range": time_range,
    }
    if costs > 0:
        result["costs"] = format_currency(costs)
    if revenue > 0:
        result["revenue"] = format_currency(revenue)

    result["breakdown"] = {
        sub: format_currency(amt)
        for sub, amt in sorted(by_sub.items(), key=lambda x: x[1], reverse=True)
    }

    _tracker.track("query", "intelligence", "mcp",
                   {"intent": "provider", "provider": provider_value})
    return json.dumps(result, indent=2)


# ── Entry point ─────────────────────────────────────────────────


if __name__ == "__main__":
    server.run(transport="stdio")
