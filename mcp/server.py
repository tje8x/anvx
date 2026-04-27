"""anvx MCP server.

v2 mode (ANVX_TOKEN set): thin wrapper over the public API at
ANVX_API_BASE (default https://anvx.io). All tool bodies live in tools.py.

v1 legacy mode (ANVX_TOKEN unset): existing local-only behavior. The v1
imports (anvx_core connectors, intelligence, credentials, models) are
deferred inside _register_v1_tools() so v2 mode never loads them. If
v1 imports break, v2 mode is unaffected.

Transport: stdio
"""
import json
import os
import sys
from pathlib import Path

# Make sibling tools.py importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))
# anvx_core lives in packages/core/src — only used by v1 mode.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages" / "core" / "src"))

import httpx  # noqa: F401  (kept available for any inline v2 helpers)

from mcp.server import FastMCP

ANVX_API_BASE = os.getenv("ANVX_API_BASE", "https://anvx.io").rstrip("/")
ANVX_TOKEN = os.getenv("ANVX_TOKEN")
V2_MODE = bool(ANVX_TOKEN)


# ── v2 mode ─────────────────────────────────────────────────────


def _build_v2_server() -> FastMCP:
    """Build a FastMCP server with only v2 tools registered.

    Every tool is a single HTTP call to the public API (see tools.py).
    """
    s = FastMCP(
        name="anvx",
        instructions=(
            "Hosted v2 mode. Read spend, insights, policies, routing rules, "
            "and connectors via the anvx public API. Mutations go through "
            "propose-then-confirm tools that return a URL the user opens "
            "to approve."
        ),
    )
    from tools import register as register_v2_tools
    register_v2_tools(s)
    return s


# ── v1 legacy mode (lazy) ───────────────────────────────────────


def _register_v1_tools(server: FastMCP) -> None:
    """Register all v1 read-only tools on the given server.

    All anvx_core imports happen INSIDE this function so that v2 mode never
    triggers them. If anvx_core has stale or missing names, v2 mode is
    unaffected; v1 mode surfaces the error directly.
    """
    # ── deferred v1 imports ─────────────────────────────────────
    import asyncio
    from collections import defaultdict
    from datetime import date, datetime, timedelta
    from decimal import Decimal

    from anvx_core.analytics import EventTracker
    from anvx_core.connectors import (
        AWSConnector,
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
    from anvx_core.utils import (
        format_currency,
        format_percent,
        get_date_range,
        is_onboarding_test_mode,
        is_synthetic_mode,
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
            "cls": AWSConnector,
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
        "(~/.anvx/). Nothing is sent to external services except "
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

    # ── helpers ────────────────────────────────────────────────

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
                model.add_records(records, provider_name)
                newly_connected.append(provider_name)
            except Exception:
                continue

        if newly_connected:
            model.save()

        return newly_connected

    def _decimal_to_str(obj: object) -> object:
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

    # ── resource ───────────────────────────────────────────────

    @server.resource("resource://financial-model")
    def financial_model_resource() -> str:
        """Current state of the financial model."""
        model = _load_model()
        _ensure_data(model)
        return model.get_context_for_llm()

    # ── tools ──────────────────────────────────────────────────

    @server.tool()
    def get_financial_overview() -> str:
        """Get a complete financial overview across all connected providers."""
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
        """Query spending data with natural language or filters."""
        model = _load_model()
        _ensure_data(model)

        days = {"7d": 7, "30d": 30, "90d": 90, "all": 9999}.get(time_range, 30)
        cutoff = date.today() - timedelta(days=days)
        recent = [r for r in model.records if r.record_date >= cutoff]

        if label:
            q = question.lower()
            if not provider:
                for keyword, prov in _PROVIDER_KEYWORDS.items():
                    if keyword in q:
                        provider = prov
                        break
            if provider:
                recent = [r for r in recent if r.provider.value == provider]

        if category:
            try:
                cat = SpendCategory(category)
                return _category_breakdown(recent, cat, time_range)
            except ValueError:
                pass

        if provider:
            return _provider_breakdown(recent, provider, time_range)

        q = question.lower()
        for keywords, cat in _CATEGORY_KEYWORDS:
            if any(kw in q for kw in keywords):
                return _category_breakdown(recent, cat, time_range)

        for keyword, prov in _PROVIDER_KEYWORDS.items():
            if keyword in q:
                return _provider_breakdown(recent, prov, time_range)

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
        """Get cost optimisation recommendations."""
        model = _load_model()
        _ensure_data(model)
        recs = generate_recommendations(model.records)

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
    async def connect_account(provider: str, credentials: dict, label: str = "default") -> str:
        """Connect a new data source."""
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

        try:
            for field, value in credentials.items():
                if isinstance(value, str):
                    CredentialStore.store_credential(provider, label, field, value)
                elif isinstance(value, list):
                    CredentialStore.store_credential(provider, label, field, json.dumps(value))
            CredentialStore.update_manifest(provider, label)
        except Exception:
            pass

        start, end = get_date_range(90)
        try:
            records = await connector.fetch_records(start, end)
        except Exception as exc:
            return json.dumps({"error": f"Fetch failed: {exc}", "provider": provider, "connected": True})

        model = _load_model()
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
            days = (max(r.record_date for r in records) - min(r.record_date for r in records)).days + 1
            services = {r.model or r.subcategory or r.category.value for r in records}
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
        """Upload a bank statement CSV."""
        import csv as csv_mod
        from collections import Counter
        from pathlib import Path as P

        from anvx_core.models import FinancialRecord, Provider as Prov

        test_mode = is_onboarding_test_mode()

        if file_path.strip().lower() == "test":
            if test_mode:
                file_path = str(
                    P(__file__).resolve().parents[1]
                    / "engine" / "testing" / "data" / "bank_statement.csv"
                )
            else:
                return json.dumps({"error": "Invalid file path. Please provide a path to a .csv file."})

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
        """Detect spending anomalies across all connected providers."""
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

        _tracker.track("anomalies_viewed", "intelligence", "mcp", {"count": len(anomalies)})
        model.save()
        return json.dumps(result, indent=2)

    @server.tool()
    def list_providers() -> str:
        """List all supported providers grouped by category."""
        model = _load_model()
        connected = set(model.get_summary().connected_accounts)
        synthetic = is_synthetic_mode()

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

        group_order = ["AI", "Cloud", "Payments", "Advertising",
                       "Communication", "Monitoring", "Search/Data", "Crypto"]
        categories = {g: by_group[g] for g in group_order if g in by_group}

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
        have data in the financial model."""
        model = _load_model()
        summary = model.get_summary()
        model_accounts = set(summary.connected_accounts)
        synthetic = is_synthetic_mode()

        manifest = CredentialStore.get_manifest()

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

        _tracker.track("setup_status_checked", "ui", "mcp", {"connected": len(connected)})
        return json.dumps(result, indent=2)


# ── Entry point ─────────────────────────────────────────────────


if __name__ == "__main__":
    if V2_MODE:
        _build_v2_server().run(transport="stdio")
    else:
        print(
            "v1 legacy mode — no policy, routing, or pack features. "
            "Set ANVX_TOKEN to enable v2.",
            file=sys.stderr,
        )
        v1 = FastMCP(
            name="anvx",
            instructions=(
                "Local-only legacy mode. Reads provider billing data via "
                "keychain credentials and computes a local financial model."
            ),
        )
        _register_v1_tools(v1)
        v1.run(transport="stdio")
