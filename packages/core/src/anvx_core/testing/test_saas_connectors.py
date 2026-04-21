"""Smoke tests for Twilio, SendGrid, and Datadog connectors (synthetic mode)."""
from datetime import date, timedelta

from engine.connectors import (
    DatadogCostsConnector,
    SendGridCostsConnector,
    TwilioCostsConnector,
)


def test_twilio() -> None:
    c = TwilioCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)
    by_cat: dict[str, float] = {}
    for r in records:
        cat = r.subcategory or "unknown"
        by_cat[cat] = by_cat.get(cat, 0) + float(r.amount)

    print(f"=== Twilio ({len(records)} records) ===")
    for cat, total in sorted(by_cat.items(), key=lambda x: x[1]):
        print(f"  {cat}: ${abs(total):.2f}")
    total = abs(sum(float(r.amount) for r in records))
    print(f"  Total: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "twilio" for r in records)
    assert all(r.category.value == "communication" for r in records)
    assert all(r.amount < 0 for r in records)
    print()


def test_sendgrid() -> None:
    c = SendGridCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)

    print(f"=== SendGrid ({len(records)} records) ===")
    for r in records:
        print(f"  {r.record_date}: ${abs(r.amount)} — {r.raw_description}")
    total = abs(sum(float(r.amount) for r in records))
    print(f"  Total: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "sendgrid" for r in records)
    assert all(r.category.value == "communication" for r in records)
    print()


def test_datadog() -> None:
    c = DatadogCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)
    by_product: dict[str, float] = {}
    for r in records:
        product = r.subcategory or "unknown"
        by_product[product] = by_product.get(product, 0) + float(r.amount)

    print(f"=== Datadog ({len(records)} records) ===")
    for product, total in sorted(by_product.items(), key=lambda x: x[1]):
        print(f"  {product}: ${abs(total):.2f}")
    total = abs(sum(float(r.amount) for r in records))
    print(f"  Total: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "datadog" for r in records)
    assert all(r.category.value == "monitoring" for r in records)
    assert all(r.amount < 0 for r in records)
    print()


if __name__ == "__main__":
    test_twilio()
    test_sendgrid()
    test_datadog()
    print("All SaaS connector tests passed.")
