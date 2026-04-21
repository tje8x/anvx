"""Smoke tests for LangSmith, Pinecone, and Tavily connectors (synthetic mode)."""
from datetime import date, timedelta

from engine.connectors import (
    LangSmithCostsConnector,
    PineconeCostsConnector,
    TavilyCostsConnector,
)


def test_langsmith() -> None:
    c = LangSmithCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)
    by_sub: dict[str, float] = {}
    for r in records:
        sub = r.subcategory or "unknown"
        by_sub[sub] = by_sub.get(sub, 0) + float(r.amount)

    print(f"=== LangSmith ({len(records)} records) ===")
    for sub, total in sorted(by_sub.items(), key=lambda x: x[1]):
        print(f"  {sub}: ${abs(total):.2f}")
    total = abs(sum(float(r.amount) for r in records))
    print(f"  Total: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "langsmith" for r in records)
    assert all(r.category.value == "monitoring" for r in records)
    print()


def test_pinecone() -> None:
    c = PineconeCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)
    by_sub: dict[str, float] = {}
    for r in records:
        sub = r.subcategory or "unknown"
        by_sub[sub] = by_sub.get(sub, 0) + float(r.amount)

    print(f"=== Pinecone ({len(records)} records) ===")
    for sub, total in sorted(by_sub.items(), key=lambda x: x[1]):
        print(f"  {sub}: ${abs(total):.2f}")
    total = abs(sum(float(r.amount) for r in records))
    print(f"  Total: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "pinecone" for r in records)
    assert all(r.category.value == "search_data" for r in records)
    print()


def test_tavily() -> None:
    c = TavilyCostsConnector()
    end = date.today()
    start = end - timedelta(days=90)
    records = c.get_synthetic_records(start, end)

    print(f"=== Tavily ({len(records)} records) ===")
    total = abs(sum(float(r.amount) for r in records))
    print(f"  Total: ${total:.2f}")
    assert len(records) > 0
    assert all(r.provider.value == "tavily" for r in records)
    assert all(r.category.value == "search_data" for r in records)
    assert all(r.amount <= 0 for r in records)
    print()


if __name__ == "__main__":
    test_langsmith()
    test_pinecone()
    test_tavily()
    print("All AI tooling connector tests passed.")
