"""Quick smoke tests for the intelligence modules."""
import asyncio
import os
from datetime import date, timedelta
from decimal import Decimal

from engine.connectors import (
    AnthropicBillingConnector,
    OpenAIBillingConnector,
    StripeConnector,
)
from engine.intelligence.anomaly_detector import detect_anomalies
from engine.intelligence.categoriser import categorise_records
from engine.intelligence.recommender import generate_recommendations
from engine.models import FinancialRecord, Provider, SpendCategory


def test_categoriser() -> None:
    os.environ["SYNTHETIC_MODE"] = "true"
    records = [
        FinancialRecord(
            record_date=date.today(), amount=Decimal("-12.50"),
            category=SpendCategory.OTHER, provider=Provider.OTHER,
            source="test", raw_description="OpenAI GPT-4o inference", confidenc=0.2,
        ),
        FinancialRecord(
            record_date=date.today(), amount=Decimal("-45.00"),
            category=SpendCategory.OTHER, provider=Provider.OTHER,
            source="test", raw_description="AWS EC2 hosting", confidenc=0.1,
        ),
        FinancialRecord(
            record_date=date.today(), amount=Decimal("-15.00"),
            category=SpendCategory.OTHER, provider=Provider.OTHER,
            source="test", raw_description="Slack Team subscription", confidenc=0.3,
        ),
        FinancialRecord(
            record_date=date.today(), amount=Decimal("500.00"),
            category=SpendCategory.OTHER, provider=Provider.STRIPE,
            source="test", raw_description="Payment received - invoice paid", confidenc=0.1,
        ),
        FinancialRecord(
            record_date=date.today(), amount=Decimal("-3.50"),
            category=SpendCategory.OTHER, provider=Provider.OTHER,
            source="test", raw_description="Stripe processing fee", confidenc=0.2,
        ),
    ]
    result = asyncio.run(categorise_records(records))
    print("=== Categoriser (synthetic mode) ===")
    for r in result:
        print(f"  {r.raw_description} -> {r.category.value} ({r.confidenc})")
    print()


def test_anomaly_detector() -> None:
    end = date.today()
    start = end - timedelta(days=90)
    records = OpenAIBillingConnector().get_synthetic_records(start, end)
    records += AnthropicBillingConnector().get_synthetic_records(start, end)

    anomalies = detect_anomalies(records)
    print(f"=== Anomaly Detector ({len(records)} records) ===")
    if anomalies:
        for a in anomalies:
            print(f"  [{a.severity.upper()}] {a.description}")
    else:
        print("  No anomalies detected")
    print()


def test_recommender() -> None:
    end = date.today()
    start = end - timedelta(days=90)
    records = OpenAIBillingConnector().get_synthetic_records(start, end)
    records += AnthropicBillingConnector().get_synthetic_records(start, end)
    records += StripeConnector().get_synthetic_records(start, end)

    recs = generate_recommendations(records, as_of=end)
    print(f"=== Recommender ({len(records)} records) ===")
    if recs:
        for r in recs:
            savings = f"${r.estimated_monthly_savings}" if r.estimated_monthly_savings else "N/A"
            print(f"  [{r.rec_type}] savings: {savings}")
            print(f"    {r.description}")
            print(f"    Action: {r.action_required}")
    else:
        print("  No recommendations")
    print()


if __name__ == "__main__":
    test_categoriser()
    test_anomaly_detector()
    test_recommender()
    print("All tests passed.")
