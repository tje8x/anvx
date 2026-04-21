"""Smoke tests for AWS, GCP, Vercel, and Cloudflare connectors (synthetic mode)."""
from datetime import date, timedelta
from decimal import Decimal

from anvx_core.connectors import (
    AWSCostsConnector,
    CloudflareCostsConnector,
    GCPCostsConnector,
    VercelCostsConnector,
)


def test_aws() -> None:
    c = AWSCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)
    by_service: dict[str, float] = {}
    for r in records:
        svc = r.subcategory or "unknown"
        by_service[svc] = by_service.get(svc, 0) + float(r.amount)

    print(f"=== AWS ({len(records)} records) ===")
    for svc, total in sorted(by_service.items(), key=lambda x: x[1]):
        print(f"  {svc}: ${abs(total):.2f}")
    total = abs(sum(float(r.amount) for r in records))
    print(f"  Total: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "aws" for r in records)
    assert all(r.amount < 0 for r in records)
    print()


def test_gcp() -> None:
    c = GCPCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)
    by_service: dict[str, float] = {}
    for r in records:
        svc = r.subcategory or "unknown"
        by_service[svc] = by_service.get(svc, 0) + float(r.amount)

    print(f"=== GCP ({len(records)} records) ===")
    for svc, total in sorted(by_service.items(), key=lambda x: x[1]):
        print(f"  {svc}: ${abs(total):.2f}")
    total = abs(sum(float(r.amount) for r in records))
    print(f"  Total: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "gcp" for r in records)
    print()


def test_vercel() -> None:
    c = VercelCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)

    print(f"=== Vercel ({len(records)} records) ===")
    for r in records:
        if r.amount != 0:
            print(f"  {r.subcategory}: ${abs(r.amount)}")
        else:
            print(f"  {r.subcategory}: included ({r.raw_description})")
    cost_records = [r for r in records if r.amount < 0]
    total = abs(sum(float(r.amount) for r in cost_records))
    print(f"  Total cost: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "vercel" for r in records)
    print()


def test_cloudflare() -> None:
    c = CloudflareCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)

    print(f"=== Cloudflare ({len(records)} records) ===")
    by_service: dict[str, float] = {}
    for r in records:
        svc = r.subcategory or "unknown"
        by_service[svc] = by_service.get(svc, 0) + float(r.amount)
    for svc, total in sorted(by_service.items(), key=lambda x: x[1]):
        print(f"  {svc}: ${abs(total):.2f}")
    total = abs(sum(float(r.amount) for r in records))
    print(f"  Total: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "cloudflare" for r in records)
    print()


if __name__ == "__main__":
    test_aws()
    test_gcp()
    test_vercel()
    test_cloudflare()
    print("All cloud connector tests passed.")
