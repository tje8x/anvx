"""Token Economy Intelligence — CLI entry point.

Usage:
    uv run python -m anvx_core.main --synthetic --status
    uv run python -m anvx_core.main --synthetic --query "What are my biggest costs?"
    uv run python -m anvx_core.main --synthetic --recommend
    uv run python -m anvx_core.main --synthetic --anomalies
    uv run python -m anvx_core.main --synthetic --providers
"""
import argparse
import asyncio
import json
import logging
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal

from anvx_core.analytics import EventTracker
from anvx_core.connectors import REGISTRY
from anvx_core.connectors.base import UsageRecord
from anvx_core.credentials import CredentialStore
from anvx_core.intelligence import (
    FinancialModelManager,
    categorise_records,
    detect_anomalies,
    generate_recommendations,
)
from anvx_core.models import FinancialRecord, Provider, SpendCategory
from anvx_core.testing.synthetic_fixtures import PROFILES, generate_synthetic_records
from anvx_core.utils import format_currency, format_percent

logger = logging.getLogger(__name__)


# Group + default category by provider name. Used to label the --providers view
# and to convert live UsageRecords into FinancialRecords. The synthetic profile
# is the primary source; entries here cover the rest of the REGISTRY.
_PROVIDER_META: dict[str, tuple[str, SpendCategory]] = {
    p.provider.value: (p.group, p.category) for p in PROFILES
}
_PROVIDER_META.update({
    "cohere":          ("LLM",        SpendCategory.AI_INFERENCE),
    "replicate":       ("LLM",        SpendCategory.AI_INFERENCE),
    "together":        ("LLM",        SpendCategory.AI_INFERENCE),
    "fireworks":       ("LLM",        SpendCategory.AI_INFERENCE),
    "google":          ("LLM",        SpendCategory.AI_INFERENCE),
    "cursor":          ("AI Tooling", SpendCategory.AI_INFERENCE),
    "github_copilot":  ("AI Tooling", SpendCategory.AI_INFERENCE),
    "replit":          ("AI Tooling", SpendCategory.AI_INFERENCE),
    "lovable":         ("AI Tooling", SpendCategory.AI_INFERENCE),
    "v0":              ("AI Tooling", SpendCategory.AI_INFERENCE),
    "bolt":            ("AI Tooling", SpendCategory.AI_INFERENCE),
    "ethereum_wallet": ("Crypto",     SpendCategory.CRYPTO_HOLDINGS),
    "solana_wallet":   ("Crypto",     SpendCategory.CRYPTO_HOLDINGS),
    "base_wallet":     ("Crypto",     SpendCategory.CRYPTO_HOLDINGS),
    "mercury":         ("Banking",    SpendCategory.OTHER),
    "wise":            ("Banking",    SpendCategory.OTHER),
    "paypal":          ("Banking",    SpendCategory.PAYMENT_PROCESSING),
    "notion":          ("SaaS",       SpendCategory.SAAS_SUBSCRIPTION),
    "supabase":        ("SaaS",       SpendCategory.CLOUD_INFRASTRUCTURE),
})


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Token Economy Intelligence CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--synthetic", action="store_true", help="Use synthetic data (no real API keys)")
    parser.add_argument("--status", action="store_true", help="Show financial status overview")
    parser.add_argument("--query", type=str, help="Ask a question about your finances")
    parser.add_argument("--recommend", action="store_true", help="Get cost optimisation recommendations")
    parser.add_argument("--verbose", action="store_true", help="Show full methodology details (with --recommend)")
    parser.add_argument("--anomalies", action="store_true", help="Detect spending anomalies")
    parser.add_argument("--providers", action="store_true", help="List all connectors and their status")
    parser.add_argument("--days", type=int, default=90, help="Days of history (default: 90)")
    parser.add_argument("--state-file", type=str, default=None, help="Path to model state file")

    args = parser.parse_args()

    if not any([args.status, args.query, args.recommend, args.anomalies, args.providers]):
        parser.print_help()
        sys.exit(1)

    if args.synthetic:
        os.environ["SYNTHETIC_MODE"] = "true"

    asyncio.run(_run(args))


async def _run(args: argparse.Namespace) -> None:
    tracker = EventTracker()
    model = FinancialModelManager(state_path=args.state_file)
    model.load()

    synthetic = args.synthetic

    # ── Acquire data ────────────────────────────────────────────
    connector_status: list[dict] = await _acquire(model, synthetic, args.days)

    # ── Categorise uncategorised records ────────────────────────
    categorised = await categorise_records(model.records)
    model._state.records = categorised
    model._state.connected_accounts = [
        s["name"] for s in connector_status
        if s["status"] in ("synthetic", "connected")
    ]
    model._state.last_updated = datetime.now()

    # ── Process command ─────────────────────────────────────────
    if args.providers:
        _print_providers(connector_status, synthetic)
        tracker.track("providers_listed", "ui", "cli", {"count": len(connector_status)})

    if args.status:
        _print_status(model)
        tracker.track("status_viewed", "ui", "cli")

    if args.anomalies:
        anomalies = detect_anomalies(model.records)
        _print_anomalies(anomalies)
        tracker.track("anomalies_viewed", "ui", "cli", {"count": len(anomalies)})

    if args.recommend:
        end_date = date.today()
        recs = generate_recommendations(model.records, as_of=end_date)
        _print_recommendations(recs, verbose=args.verbose)
        tracker.track("recommendations_viewed", "ui", "cli", {"count": len(recs)})

    if args.query:
        model.record_query(args.query)
        _print_query_response(model, args.query)
        tracker.track("query", "ui", "cli")

    # ── Save ────────────────────────────────────────────────────
    model.save()
    await tracker.close()


# ── Data acquisition ────────────────────────────────────────────


async def _acquire(
    model: FinancialModelManager, synthetic: bool, days_back: int
) -> list[dict]:
    """Populate `model` from synthetic fixtures or live connector fetches.

    Returns a per-connector status list for the --providers view.
    """
    if synthetic:
        return _acquire_synthetic(model, days_back)
    return await _acquire_live(model, days_back)


def _acquire_synthetic(model: FinancialModelManager, days_back: int) -> list[dict]:
    records = generate_synthetic_records(days_back=days_back)
    model.add_records(records, "synthetic")

    counts: dict[str, int] = defaultdict(int)
    for r in records:
        counts[r.provider.value] += 1

    status: list[dict] = []
    for name, connector in REGISTRY.items():
        group, _ = _PROVIDER_META.get(name, ("Other", SpendCategory.OTHER))
        status.append({
            "name": name,
            "group": group,
            "provider": getattr(connector, "provider", name),
            "status": "synthetic" if counts.get(name, 0) > 0 else "no_synthetic_profile",
            "records": counts.get(name, 0),
        })
    return status


async def _acquire_live(
    model: FinancialModelManager, days_back: int
) -> list[dict]:
    since = datetime.combine(
        date.today() - timedelta(days=days_back), datetime.min.time()
    )
    until = datetime.now()

    status: list[dict] = []
    for name, connector in REGISTRY.items():
        group, default_cat = _PROVIDER_META.get(name, ("Other", SpendCategory.OTHER))
        result = "disconnected"

        api_key = _resolve_credential(name)
        fetch_usage = getattr(connector, "fetch_usage", None)

        if api_key and callable(fetch_usage):
            try:
                usage_records = await fetch_usage(api_key, since, until)
                fin_records = [
                    _usage_to_financial(u, default_cat) for u in usage_records
                ]
                model.add_records(fin_records, name)
                result = "connected"
            except Exception as exc:
                logger.warning("Live fetch for %s failed: %s", name, exc)
                result = "error"

        status.append({
            "name": name,
            "group": group,
            "provider": getattr(connector, "provider", name),
            "status": result,
            "records": len(model.records),
        })
    return status


def _resolve_credential(provider: str) -> str | None:
    """Build the api_key string a connector expects.

    Single-field providers get the raw string. Multi-field providers
    (aws, twilio, etc.) get a JSON blob matching the connector's input shape.
    """
    creds = CredentialStore.get_all_credentials(provider)
    if not creds:
        return None
    if len(creds) == 1:
        return next(iter(creds.values()))
    return json.dumps(creds)


def _usage_to_financial(rec: UsageRecord, category: SpendCategory) -> FinancialRecord:
    """Convert a v2 UsageRecord (positive cents) into a FinancialRecord (negative USD)."""
    cost_usd = Decimal(rec.total_cost_cents_usd) / Decimal(100)
    try:
        provider = Provider(rec.provider)
    except ValueError:
        provider = Provider.OTHER
    return FinancialRecord(
        record_date=rec.ts.date(),
        amount=-cost_usd,
        currency=rec.currency,
        category=category,
        provider=provider,
        model=rec.model,
        tokens_input=rec.input_tokens,
        tokens_output=rec.output_tokens,
        source=f"{rec.provider}_fetch",
    )


# ── Output formatters ───────────────────────────────────────────


def _print_providers(statuses: list[dict], synthetic: bool) -> None:
    print()
    print("=" * 60)
    print("  CONNECTORS")
    print("=" * 60)
    mode = "SYNTHETIC" if synthetic else "LIVE"
    print(f"  Mode: {mode}")
    print()

    by_group: dict[str, list[dict]] = defaultdict(list)
    for s in statuses:
        by_group[s["group"]].append(s)

    for group in sorted(by_group.keys()):
        print(f"  {group}:")
        for s in by_group[group]:
            icon = (
                "+" if s["status"] == "synthetic"
                else "*" if s["status"] == "connected"
                else "!" if s["status"] == "error"
                else " "
            )
            print(f"    [{icon}] {s['name']:<18} ({s['provider']}) — {s['status']}")
        print()


def _print_status(model: FinancialModelManager) -> None:
    summary = model.get_summary()

    print()
    print("=" * 60)
    print("  TOKEN ECONOMY — FINANCIAL STATUS")
    print("=" * 60)
    print(f"  Last updated:  {summary.last_updated:%Y-%m-%d %H:%M}")
    print(f"  Data coverage: {summary.data_coverage_days} days, {summary.record_count:,} records")
    print(f"  Connected:     {', '.join(summary.connected_accounts)}")
    print()

    # ── Spend by category ───────────────────────────────────────
    print("  MONTHLY SPEND BY CATEGORY")
    print("  " + "-" * 45)

    category_labels = {
        "ai_inference": "AI Inference",
        "ai_training": "AI Training",
        "cloud_infrastructure": "Cloud Infrastructure",
        "saas_subscription": "SaaS Subscriptions",
        "payment_processing": "Payment Processing",
        "communication": "Communication",
        "monitoring": "Monitoring",
        "search_data": "Search & Data",
        "advertising": "Advertising",
        "crypto_holdings": "Crypto Holdings",
        "revenue": "Revenue",
        "other": "Other",
    }

    if summary.spend_by_category:
        sorted_cats = sorted(
            summary.spend_by_category.items(), key=lambda x: x[1], reverse=True
        )
        for cat, amount in sorted_cats:
            label = category_labels.get(cat, cat)
            bar_len = (
                min(30, int(float(amount) / float(summary.total_monthly_spend) * 30))
                if summary.total_monthly_spend > 0 else 0
            )
            bar = "#" * bar_len
            print(f"    {label:<25} {format_currency(amount):>10}  {bar}")
    print(f"    {'TOTAL':<25} {format_currency(summary.total_monthly_spend):>10}")
    print()

    # ── Spend by provider ───────────────────────────────────────
    print("  MONTHLY SPEND BY PROVIDER")
    print("  " + "-" * 45)
    if summary.spend_by_provider:
        sorted_provs = sorted(
            summary.spend_by_provider.items(), key=lambda x: x[1], reverse=True
        )
        for prov, amount in sorted_provs:
            print(f"    {prov:<25} {format_currency(amount):>10}")
    print()

    # ── Revenue & margin ────────────────────────────────────────
    if summary.revenue_monthly is not None:
        print(f"  Monthly revenue:  {format_currency(summary.revenue_monthly)}")
        if summary.total_monthly_spend > 0:
            margin = float(
                (summary.revenue_monthly - summary.total_monthly_spend)
                / summary.revenue_monthly * 100
            )
            print(f"  Gross margin:     {format_percent(margin)}")
        print()

    if summary.crypto_holdings_usd is not None and summary.crypto_holdings_usd > 0:
        print(f"  Crypto holdings:  {format_currency(summary.crypto_holdings_usd)}")
        print()


def _print_anomalies(anomalies: list) -> None:
    print()
    print("=" * 60)
    print("  SPENDING ANOMALIES")
    print("=" * 60)

    if not anomalies:
        print("  No anomalies detected.")
        print()
        return

    for a in anomalies:
        severity_icon = {"critical": "!!", "high": "!", "medium": "~"}
        icon = severity_icon.get(a.severity, " ")
        print(f"  [{icon}] {a.severity.upper()}: {a.description}")
        print(f"      Current: {format_currency(a.current_amount)}  |  "
              f"Baseline: {format_currency(a.baseline_amount)}  |  "
              f"Deviation: {format_percent(a.deviation_percent)}")
        print()


def _print_recommendations(recs: list, verbose: bool = False) -> None:
    print()

    if not recs:
        print("  No recommendations at this time.")
        print()
        return

    if verbose:
        _print_recommendations_verbose(recs)
    else:
        _print_recommendations_concise(recs)


def _print_recommendations_concise(recs: list) -> None:
    """Top 5 recommendations, one line each + total savings."""
    top = recs[:5]
    total_savings = sum(
        r.estimated_monthly_savings for r in recs
        if r.estimated_monthly_savings
    )

    print("=" * 60)
    print("  TOP 5 COST OPTIMISATIONS")
    print("=" * 60)
    print()

    for i, r in enumerate(top, 1):
        savings = format_currency(r.estimated_monthly_savings) if r.estimated_monthly_savings else "N/A"
        label = r.rec_type.replace("_", " ").title()
        short_desc = r.description.split(". ")[0]
        if len(short_desc) > 70:
            short_desc = short_desc[:67] + "..."
        action = r.action_required.split(". ")[0]
        if len(action) > 50:
            action = action[:47] + "..."

        print(f"  {i}. {label}: {short_desc}")
        print(f"     -> {savings}/mo | Action: {action}")
        print()

    print(f"  Total potential savings: {format_currency(total_savings)}/mo")
    if len(recs) > 5:
        print(f"  ({len(recs) - 5} more recommendations available)")
    print("  Run with --verbose for full methodology.")
    print()


def _print_recommendations_verbose(recs: list) -> None:
    """Full details for all recommendations."""
    print("=" * 60)
    print("  COST OPTIMISATION RECOMMENDATIONS (VERBOSE)")
    print("=" * 60)
    print()

    for i, r in enumerate(recs, 1):
        savings = format_currency(r.estimated_monthly_savings) + "/mo" if r.estimated_monthly_savings else "N/A"
        source = f" via {r.source_module}" if r.source_module else ""
        print(f"  {i}. [{r.rec_type}]{source} (confidence: {r.confidence})")
        print(f"     {r.description}")
        print(f"     Estimated savings: {savings}")
        if r.methodology:
            print(f"     Methodology: {r.methodology}")
        print(f"     Action: {r.action_required}")
        print()


_CATEGORY_KEYWORDS: list[tuple[list[str], SpendCategory, str]] = [
    (["ai inference", "ai spend", "llm", "model cost", "openai", "anthropic", "gpt", "claude"],
     SpendCategory.AI_INFERENCE, "AI Inference"),
    (["ai training", "fine-tun", "finetun", "training"],
     SpendCategory.AI_TRAINING, "AI Training"),
    (["cloud", "infrastructure", "aws", "gcp", "vercel", "cloudflare", "hosting", "compute"],
     SpendCategory.CLOUD_INFRASTRUCTURE, "Cloud Infrastructure"),
    (["saas", "subscription", "software"],
     SpendCategory.SAAS_SUBSCRIPTION, "SaaS Subscriptions"),
    (["payment process", "stripe fee", "processing fee"],
     SpendCategory.PAYMENT_PROCESSING, "Payment Processing"),
    (["communication", "twilio", "sendgrid", "sms", "email", "messaging"],
     SpendCategory.COMMUNICATION, "Communication"),
    (["monitoring", "datadog", "langsmith", "observability", "tracing", "apm"],
     SpendCategory.MONITORING, "Monitoring"),
    (["search", "data", "pinecone", "tavily", "vector", "retrieval"],
     SpendCategory.SEARCH_DATA, "Search & Data"),
    (["crypto", "wallet", "bitcoin", "ethereum", "holdings"],
     SpendCategory.CRYPTO_HOLDINGS, "Crypto Holdings"),
    (["revenue", "income", "sales", "earnings"],
     SpendCategory.REVENUE, "Revenue"),
]

_PROVIDER_KEYWORDS: dict[str, str] = {
    "openai": "openai", "anthropic": "anthropic", "stripe": "stripe",
    "aws": "aws", "gcp": "gcp", "vercel": "vercel", "cloudflare": "cloudflare",
    "twilio": "twilio", "sendgrid": "sendgrid", "datadog": "datadog",
    "langsmith": "langsmith", "pinecone": "pinecone", "tavily": "tavily",
}


def _match_category(query_lower: str) -> tuple[SpendCategory | None, str]:
    """Match a query string to a SpendCategory via keywords."""
    for keywords, category, label in _CATEGORY_KEYWORDS:
        if any(kw in query_lower for kw in keywords):
            return category, label
    return None, ""


def _match_provider(query_lower: str) -> str | None:
    """Match a query string to a provider name."""
    for keyword, provider_value in _PROVIDER_KEYWORDS.items():
        if keyword in query_lower:
            return provider_value
    return None


def _print_query_response(model: FinancialModelManager, query: str) -> None:
    """Answer a query using the financial model context."""
    print()
    print("=" * 60)
    print(f"  QUERY: {query}")
    print("=" * 60)

    summary = model.get_summary()
    records = model.records
    query_lower = query.lower()
    thirty_days_ago = (date.today() - timedelta(days=30))
    recent = [r for r in records if r.record_date >= thirty_days_ago]

    matched_cat, cat_label = _match_category(query_lower)
    matched_provider = _match_provider(query_lower)

    if matched_cat is not None:
        _print_category_breakdown(recent, matched_cat, cat_label)
        return

    if matched_provider is not None:
        _print_provider_breakdown(recent, matched_provider)
        return

    if any(w in query_lower for w in ["biggest", "largest", "top", "most"]):
        print("  Top spend categories (last 30 days):")
        if summary.spend_by_category:
            sorted_cats = sorted(
                summary.spend_by_category.items(), key=lambda x: x[1], reverse=True
            )
            for cat, amount in sorted_cats[:5]:
                print(f"    {cat:<30} {format_currency(amount)}")
        print()
        return

    if any(w in query_lower for w in ["total", "how much", "overview"]):
        print(f"  Total monthly spend: {format_currency(summary.total_monthly_spend)}")
        if summary.revenue_monthly:
            print(f"  Monthly revenue:     {format_currency(summary.revenue_monthly)}")
            if summary.total_monthly_spend > 0:
                margin = float(
                    (summary.revenue_monthly - summary.total_monthly_spend)
                    / summary.revenue_monthly * 100
                )
                print(f"  Gross margin:        {format_percent(margin)}")
        print()
        return

    print()
    print(model.get_context_for_llm())
    print()
    print("  (In live mode, this context would be sent to Claude for a detailed answer.)")
    print()


def _print_category_breakdown(
    records: list, category: SpendCategory, label: str
) -> None:
    """Show a detailed breakdown for a specific category."""
    filtered = [r for r in records if r.category == category]

    if not filtered:
        print(f"  No {label} records in the last 30 days.")
        print()
        return

    total = sum(abs(r.amount) for r in filtered)
    print(f"  {label} — Last 30 Days")
    print(f"  Total: {format_currency(total)}")
    print()

    by_sub: dict[str, Decimal] = defaultdict(Decimal)
    for r in filtered:
        key = r.model or r.subcategory or r.provider.value
        by_sub[key] += abs(r.amount)

    if by_sub:
        print("  Breakdown:")
        sorted_subs = sorted(by_sub.items(), key=lambda x: x[1], reverse=True)
        for sub, amount in sorted_subs:
            pct = float(amount / total * 100) if total > 0 else 0
            print(f"    {sub:<35} {format_currency(amount):>10}  ({pct:.1f}%)")
        print()

    by_prov: dict[str, Decimal] = defaultdict(Decimal)
    for r in filtered:
        by_prov[r.provider.value] += abs(r.amount)
    if len(by_prov) > 1:
        print("  By provider:")
        for prov, amount in sorted(by_prov.items(), key=lambda x: x[1], reverse=True):
            print(f"    {prov:<35} {format_currency(amount):>10}")
        print()

    earliest = min(r.record_date for r in filtered)
    latest = max(r.record_date for r in filtered)
    print(f"  {len(filtered)} records from {earliest} to {latest}")
    print()


def _print_provider_breakdown(records: list, provider_value: str) -> None:
    """Show a detailed breakdown for a specific provider."""
    filtered = [r for r in records if r.provider.value == provider_value]

    if not filtered:
        print(f"  No {provider_value} records in the last 30 days.")
        print()
        return

    costs = [r for r in filtered if r.amount < 0]
    revenue = [r for r in filtered if r.amount > 0]
    total_cost = sum(abs(r.amount) for r in costs)
    total_rev = sum(r.amount for r in revenue)

    print(f"  {provider_value.upper()} — Last 30 Days")
    if total_cost > 0:
        print(f"  Costs: {format_currency(total_cost)}")
    if total_rev > 0:
        print(f"  Revenue: {format_currency(total_rev)}")
    print()

    by_sub: dict[str, Decimal] = defaultdict(Decimal)
    for r in filtered:
        key = r.model or r.subcategory or r.category.value
        by_sub[key] += abs(r.amount)

    if by_sub:
        print("  Breakdown:")
        for sub, amount in sorted(by_sub.items(), key=lambda x: x[1], reverse=True):
            print(f"    {sub:<35} {format_currency(amount):>10}")
        print()

    print(f"  {len(filtered)} records")
    print()


if __name__ == "__main__":
    main()
