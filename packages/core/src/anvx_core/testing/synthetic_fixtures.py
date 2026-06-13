"""Synthetic FinancialRecord fixtures for the v2 connector ecosystem.

The new-gen async connectors require real API keys and do not expose a
`get_synthetic_records` method, so the CLI's `--synthetic` path cannot
ask them for fake data. This module emits `FinancialRecord` objects
directly per provider, giving callers a uniform synthetic dataset
without touching any connector implementation.
"""
from datetime import date, timedelta
from decimal import Decimal
from typing import NamedTuple

from anvx_core.models import FinancialRecord, Provider, SpendCategory


class Profile(NamedTuple):
    provider: Provider
    category: SpendCategory
    group: str
    monthly_usd: int  # negative = cost, positive = revenue / holding
    model: str | None


# Realistic per-provider monthly amounts for an AI-native business. The
# `group` value is reused by the CLI's `--providers` view.
PROFILES: list[Profile] = [
    Profile(Provider.OPENAI,     SpendCategory.AI_INFERENCE,         "LLM",         -400, "gpt-4o"),
    Profile(Provider.ANTHROPIC,  SpendCategory.AI_INFERENCE,         "LLM",         -250, "claude-sonnet-4-5"),
    Profile(Provider.GEMINI,     SpendCategory.AI_INFERENCE,         "LLM",          -75, "gemini-2.0-flash"),
    Profile(Provider.AWS,        SpendCategory.CLOUD_INFRASTRUCTURE, "Infra",       -200, "ec2"),
    Profile(Provider.GCP,        SpendCategory.CLOUD_INFRASTRUCTURE, "Infra",       -150, "compute"),
    Profile(Provider.VERCEL,     SpendCategory.CLOUD_INFRASTRUCTURE, "Infra",        -20, "pro"),
    Profile(Provider.CLOUDFLARE, SpendCategory.CLOUD_INFRASTRUCTURE, "Infra",         -8, "workers"),
    Profile(Provider.STRIPE,     SpendCategory.REVENUE,              "Payments",    1800, None),
    Profile(Provider.TWILIO,     SpendCategory.COMMUNICATION,        "Comms",        -45, "sms"),
    Profile(Provider.SENDGRID,   SpendCategory.COMMUNICATION,        "Comms",        -90, "email"),
    Profile(Provider.DATADOG,    SpendCategory.MONITORING,           "Monitoring",   -75, "apm"),
    Profile(Provider.LANGSMITH,  SpendCategory.MONITORING,           "Monitoring",   -52, "traces"),
    Profile(Provider.PINECONE,   SpendCategory.SEARCH_DATA,          "Search/Data",   -8, "index"),
    Profile(Provider.TAVILY,     SpendCategory.SEARCH_DATA,          "Search/Data",  -24, "search"),
    Profile(Provider.COINBASE,   SpendCategory.CRYPTO_HOLDINGS,      "Crypto",      1200, "BTC"),
    Profile(Provider.BINANCE,    SpendCategory.CRYPTO_HOLDINGS,      "Crypto",       800, "ETH"),
]


def generate_synthetic_records(days_back: int = 90) -> list[FinancialRecord]:
    """One FinancialRecord per profile per day across `days_back` days.

    The monthly USD estimate is spread evenly as a per-day amount, so the
    30-day total matches `monthly_usd` regardless of `days_back`.
    """
    end = date.today()
    records: list[FinancialRecord] = []

    for prof in PROFILES:
        per_day = Decimal(prof.monthly_usd) / Decimal(30)
        for offset in range(days_back):
            d = end - timedelta(days=offset)
            records.append(FinancialRecord(
                record_date=d,
                amount=per_day,
                currency="USD",
                category=prof.category,
                provider=prof.provider,
                model=prof.model,
                source=f"synthetic_{prof.provider.value}",
            ))

    return records
