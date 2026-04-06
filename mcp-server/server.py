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

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp.server import FastMCP

from engine.analytics import EventTracker
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
from engine.intelligence import (
    FinancialModelManager,
    categorise_records,
    detect_anomalies,
    generate_recommendations,
)
from engine.models import Provider, SpendCategory
from engine.utils import format_currency, format_percent, get_date_range, is_onboarding_test_mode, is_synthetic_mode

# ── Server setup ────────────────────────────────────────────────

server = FastMCP(
    name="token-economy-intel",
    instructions=(
        "Unified financial intelligence for AI-native businesses. "
        "Tracks spending across LLM APIs, cloud infrastructure, payments, "
        "communication, monitoring, search/data tools, and crypto holdings."
    ),
)

_tracker = EventTracker()

_CONNECTOR_REGISTRY: list[dict] = [
    {"name": "openai",      "label": "OpenAI",      "group": "LLM",         "cls": OpenAIBillingConnector},
    {"name": "anthropic",   "label": "Anthropic",   "group": "LLM",         "cls": AnthropicBillingConnector},
    {"name": "stripe",      "label": "Stripe",      "group": "Payments",    "cls": StripeConnector},
    {"name": "crypto_wallet","label": "Crypto Wallet","group": "Crypto",      "cls": CryptoWalletConnector},
    {"name": "coinbase",    "label": "Coinbase",    "group": "Crypto",      "cls": CoinbaseExchangeConnector},
    {"name": "binance",     "label": "Binance",     "group": "Crypto",      "cls": BinanceExchangeConnector},
    {"name": "aws",         "label": "AWS",         "group": "Infra",       "cls": AWSCostsConnector},
    {"name": "gcp",         "label": "GCP",         "group": "Infra",       "cls": GCPCostsConnector},
    {"name": "vercel",      "label": "Vercel",      "group": "Infra",       "cls": VercelCostsConnector},
    {"name": "cloudflare",  "label": "Cloudflare",  "group": "Infra",       "cls": CloudflareCostsConnector},
    {"name": "twilio",      "label": "Twilio",      "group": "Comms",       "cls": TwilioCostsConnector},
    {"name": "sendgrid",    "label": "SendGrid",    "group": "Comms",       "cls": SendGridCostsConnector},
    {"name": "datadog",     "label": "Datadog",     "group": "Monitoring",  "cls": DatadogCostsConnector},
    {"name": "langsmith",   "label": "LangSmith",   "group": "Monitoring",  "cls": LangSmithCostsConnector},
    {"name": "pinecone",    "label": "Pinecone",    "group": "Search/Data", "cls": PineconeCostsConnector},
    {"name": "tavily",      "label": "Tavily",      "group": "Search/Data", "cls": TavilyCostsConnector},
]

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
) -> str:
    """Query spending data with natural language or filters.

    Args:
        question: Natural language question about spending.
        time_range: Time range — "7d", "30d", "90d", or "all". Default "30d".
        category: Filter by SpendCategory value (e.g. "ai_inference", "cloud_infrastructure").
        provider: Filter by Provider value (e.g. "openai", "aws", "stripe").
    """
    model = _load_model()
    _ensure_data(model)

    # Parse time range
    days = {"7d": 7, "30d": 30, "90d": 90, "all": 9999}.get(time_range, 30)
    cutoff = date.today() - timedelta(days=days)
    recent = [r for r in model.records if r.record_date >= cutoff]

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
async def connect_account(provider: str, credentials: dict) -> str:
    """Connect a new data source.

    Args:
        provider: Provider name — one of: openai, anthropic, stripe, crypto,
                  aws, gcp, vercel, cloudflare, twilio, sendgrid, datadog,
                  langsmith, pinecone, tavily.
        credentials: Provider-specific credentials dict. Examples:
                     OpenAI: {"api_key": "sk-..."}
                     AWS: {"access_key_id": "...", "secret_access_key": "...", "region": "us-east-1"}
                     Crypto: {"wallet_addresses": ["0x..."]}
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

    start, end = get_date_range(90)
    try:
        records = await connector.fetch_records(start, end)
    except Exception as exc:
        return json.dumps({"error": f"Fetch failed: {exc}", "provider": provider, "connected": True})

    model = _load_model()
    n = model.add_records(records, provider)
    model.save()

    _tracker.track("account_connected", "lifecycle", "mcp", {"provider": provider})

    # Build rich connection summary
    result: dict = {
        "provider": provider,
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
            f"Connected {entry['label']}. Found {days} days of data "
            f"across {len(services)} models/services."
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

    from engine.models import FinancialRecord, Provider as Prov, SpendCategory

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
    """List all 14 supported providers with their connection status."""
    model = _load_model()
    _ensure_data(model)

    connected_accounts = set(model.get_summary().connected_accounts)
    synthetic = is_synthetic_mode()

    providers = []
    for entry in _CONNECTOR_REGISTRY:
        name = entry["name"]
        if name in connected_accounts:
            status = "synthetic" if synthetic else "connected"
        else:
            status = "disconnected"

        providers.append({
            "name": name,
            "label": entry["label"],
            "group": entry["group"],
            "status": status,
        })

    result = {
        "total": len(providers),
        "connected": sum(1 for p in providers if p["status"] != "disconnected"),
        "providers": providers,
    }

    _tracker.track("providers_listed", "ui", "mcp")
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
