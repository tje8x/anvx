"""Tests for app.attribution.attribution_for_period."""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any
from unittest.mock import patch
from uuid import uuid4

import pytest

from app.attribution import attribution_for_period


WS = "ws-attr-1"
PERIOD_START = date(2026, 4, 1)
PERIOD_END = date(2026, 5, 1)


# ── tiny in-memory supabase stub ───────────────────────────────


class FakeQuery:
    def __init__(self, table: str, db: "FakeDB"):
        self.table = table
        self.db = db
        self.filters: list[tuple[str, str, Any]] = []
        self.in_values: dict[str, list[Any]] = {}

    def select(self, *_a, **_kw): return self
    def eq(self, col, val): self.filters.append((col, "eq", val)); return self
    def gte(self, col, val): self.filters.append((col, "gte", val)); return self
    def lt(self, col, val): self.filters.append((col, "lt", val)); return self
    def in_(self, col, values): self.in_values[col] = list(values); return self
    def order(self, *_a, **_kw): return self
    def limit(self, _n): return self

    def _match(self, row: dict) -> bool:
        for col, cmp, val in self.filters:
            rv = row.get(col)
            if cmp == "eq" and rv != val: return False
            if cmp == "gte" and not (rv is not None and rv >= val): return False
            if cmp == "lt" and not (rv is not None and rv < val): return False
        for col, values in self.in_values.items():
            if row.get(col) not in values: return False
        return True

    def execute(self):
        class R:
            def __init__(self, data): self.data = data
        rows = self.db.tables.get(self.table, [])
        if rows is None:  # simulate missing table
            raise RuntimeError(f"relation '{self.table}' does not exist")
        return R([r for r in rows if self._match(r)])


class FakeDB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {
            "routing_usage_records": [],
            "usage_records": [],
            "document_transactions": [],
            "reconciliation_matches": [],
            "reconciliation_categorizations": [],
            "reconciliation_flags": [],
            "chart_of_accounts": [
                {"id": "coa-5010", "workspace_id": WS, "code": "5010", "name": "LLM inference", "kind": "cogs"},
                {"id": "coa-5020", "workspace_id": WS, "code": "5020", "name": "Cloud infrastructure", "kind": "cogs"},
                {"id": "coa-6040", "workspace_id": WS, "code": "6040", "name": "Other SaaS", "kind": "opex"},
                {"id": "coa-6050", "workspace_id": WS, "code": "6050", "name": "Payroll", "kind": "opex"},
            ],
        }

    def from_(self, table: str) -> FakeQuery:
        return FakeQuery(table, self)


class FakeSb:
    def __init__(self, db: FakeDB): self._db = db
    def from_(self, table: str): return self._db.from_(table)


def _seed_routing(db: FakeDB, *records: dict) -> None:
    db.tables["routing_usage_records"].extend(records)


def _seed_doc_txn(db: FakeDB, *, txn_date: date, amount_cents: int, description: str = "test") -> str:
    txn_id = str(uuid4())
    db.tables["document_transactions"].append({
        "id": txn_id, "workspace_id": WS, "txn_date": txn_date.isoformat(),
        "description": description, "amount_cents": amount_cents,
    })
    return txn_id


def _seed_categorization(db: FakeDB, txn_id: str, code: str) -> None:
    coa = next(c for c in db.tables["chart_of_accounts"] if c["code"] == code)
    db.tables["reconciliation_categorizations"].append({
        "id": str(uuid4()), "workspace_id": WS,
        "document_transaction_id": txn_id, "category_id": coa["id"],
    })


def _seed_match(db: FakeDB, txn_id: str, *, source_kind: str, auto: bool) -> None:
    db.tables["reconciliation_matches"].append({
        "id": str(uuid4()), "workspace_id": WS,
        "document_transaction_id": txn_id, "source_kind": source_kind, "auto": auto,
    })


def _seed_flag(db: FakeDB, txn_id: str) -> None:
    db.tables["reconciliation_flags"].append({
        "id": str(uuid4()), "workspace_id": WS, "document_transaction_id": txn_id,
    })


# ─── tests ─────────────────────────────────────────────────────


@patch("app.attribution.sb_service")
def test_routing_only_no_documents(mock_sb):
    db = FakeDB()
    _seed_routing(
        db,
        {"id": str(uuid4()), "workspace_id": WS, "provider": "openai",
         "provider_cost_cents": 1500, "created_at": "2026-04-10T12:00:00+00:00"},
        {"id": str(uuid4()), "workspace_id": WS, "provider": "anthropic",
         "provider_cost_cents": 800, "created_at": "2026-04-15T09:00:00+00:00"},
        # outside the period — must be excluded
        {"id": str(uuid4()), "workspace_id": WS, "provider": "openai",
         "provider_cost_cents": 9999, "created_at": "2026-05-01T00:00:00+00:00"},
    )
    mock_sb.return_value = FakeSb(db)

    out = attribution_for_period(WS, PERIOD_START, PERIOD_END)

    assert out["by_source"] == {"routing": 2300, "connectors": 0, "documents": 0}
    assert out["by_category"] == {"5010": 2300}
    assert out["total_cents"] == 2300
    assert out["flagged_count"] == 0
    assert out["flagged_amount_cents"] == 0


@patch("app.attribution.sb_service")
def test_categorized_document_appears_in_documents_source(mock_sb):
    db = FakeDB()
    # Categorized as Cloud infra (5020) — represents an AWS bank-statement charge
    txn_id = _seed_doc_txn(db, txn_date=date(2026, 4, 11), amount_cents=-208744)
    _seed_categorization(db, txn_id, "5020")

    # Another transaction: user-confirmed match without categorization → 6040
    txn2 = _seed_doc_txn(db, txn_date=date(2026, 4, 14), amount_cents=-15000)
    _seed_match(db, txn2, source_kind="connector", auto=False)

    mock_sb.return_value = FakeSb(db)

    out = attribution_for_period(WS, PERIOD_START, PERIOD_END)

    assert out["by_source"]["documents"] == 208744 + 15000
    assert out["by_source"]["routing"] == 0
    assert out["by_category"]["5020"] == 208744
    assert out["by_category"]["6040"] == 15000
    assert out["total_cents"] == 208744 + 15000


@patch("app.attribution.sb_service")
def test_routing_matched_document_is_not_double_counted(mock_sb):
    """A document_transaction matched to routing must not contribute to documents source."""
    db = FakeDB()
    # Routing-side spend (ground truth, $20 in cents)
    _seed_routing(
        db,
        {"id": str(uuid4()), "workspace_id": WS, "provider": "openai",
         "provider_cost_cents": 2000, "created_at": "2026-04-12T10:00:00+00:00"},
    )
    # Document row for the same charge — auto-matched to routing
    txn_id = _seed_doc_txn(db, txn_date=date(2026, 4, 12), amount_cents=-2000, description="OPENAI")
    _seed_match(db, txn_id, source_kind="routing", auto=True)
    # Even if a user later categorized it, the routing-source rule still excludes it
    _seed_categorization(db, txn_id, "5010")

    mock_sb.return_value = FakeSb(db)

    out = attribution_for_period(WS, PERIOD_START, PERIOD_END)

    assert out["by_source"]["routing"] == 2000
    assert out["by_source"]["documents"] == 0
    assert out["total_cents"] == 2000  # not 4000
    assert out["by_category"]["5010"] == 2000


@patch("app.attribution.sb_service")
def test_flagged_rows_are_separate_from_total(mock_sb):
    db = FakeDB()
    # A normal categorized expense
    cat_txn = _seed_doc_txn(db, txn_date=date(2026, 4, 5), amount_cents=-50000)
    _seed_categorization(db, cat_txn, "6040")

    # A flagged row — should NOT contribute to total or by_category
    flagged_txn = _seed_doc_txn(db, txn_date=date(2026, 4, 6), amount_cents=-12345)
    _seed_flag(db, flagged_txn)

    # Another flagged row inside period
    flagged_txn2 = _seed_doc_txn(db, txn_date=date(2026, 4, 7), amount_cents=-999)
    _seed_flag(db, flagged_txn2)

    mock_sb.return_value = FakeSb(db)

    out = attribution_for_period(WS, PERIOD_START, PERIOD_END)

    assert out["by_source"]["documents"] == 50000
    assert out["total_cents"] == 50000
    assert out["by_category"].get("6040") == 50000
    # Flagged stays separate
    assert out["flagged_count"] == 2
    assert out["flagged_amount_cents"] == 12345 + 999


@patch("app.attribution.sb_service")
def test_invariant_total_matches_source_and_category_sums(mock_sb):
    db = FakeDB()

    # Routing
    _seed_routing(
        db,
        {"id": str(uuid4()), "workspace_id": WS, "provider": "openai",
         "provider_cost_cents": 1234, "created_at": "2026-04-02T10:00:00+00:00"},
        {"id": str(uuid4()), "workspace_id": WS, "provider": "anthropic",
         "provider_cost_cents": 5678, "created_at": "2026-04-03T10:00:00+00:00"},
    )
    # Connector — AWS, no overlapping routing on that day
    db.tables["usage_records"].append({
        "id": str(uuid4()), "workspace_id": WS, "provider": "aws",
        "total_cost_cents_usd": 9000, "ts": "2026-04-04T00:00:00+00:00",
    })
    # Connector — Notion (not a cloud provider) → 6040
    db.tables["usage_records"].append({
        "id": str(uuid4()), "workspace_id": WS, "provider": "notion",
        "total_cost_cents_usd": 1500, "ts": "2026-04-04T00:00:00+00:00",
    })
    # Categorized doc as 5020
    txn1 = _seed_doc_txn(db, txn_date=date(2026, 4, 10), amount_cents=-20000)
    _seed_categorization(db, txn1, "5020")
    # User-confirmed connector match without categorization → 6040
    txn2 = _seed_doc_txn(db, txn_date=date(2026, 4, 11), amount_cents=-7000)
    _seed_match(db, txn2, source_kind="connector", auto=False)
    # Flagged — must be excluded
    fl = _seed_doc_txn(db, txn_date=date(2026, 4, 12), amount_cents=-99999)
    _seed_flag(db, fl)

    mock_sb.return_value = FakeSb(db)

    out = attribution_for_period(WS, PERIOD_START, PERIOD_END)

    assert sum(out["by_source"].values()) == out["total_cents"]
    assert sum(out["by_category"].values()) == out["total_cents"]
    # explicit numbers for safety
    expected = 1234 + 5678 + 9000 + 1500 + 20000 + 7000
    assert out["total_cents"] == expected


@patch("app.attribution.sb_service")
def test_connector_provider_day_overlap_is_skipped(mock_sb):
    db = FakeDB()
    # Routing for openai on April 4
    _seed_routing(
        db,
        {"id": str(uuid4()), "workspace_id": WS, "provider": "openai",
         "provider_cost_cents": 500, "created_at": "2026-04-04T10:00:00+00:00"},
    )
    # Connector record for openai on the SAME day → must be excluded
    db.tables["usage_records"].append({
        "id": str(uuid4()), "workspace_id": WS, "provider": "openai",
        "total_cost_cents_usd": 444444, "ts": "2026-04-04T15:00:00+00:00",
    })
    # Connector record for openai on a different day → kept
    db.tables["usage_records"].append({
        "id": str(uuid4()), "workspace_id": WS, "provider": "openai",
        "total_cost_cents_usd": 100, "ts": "2026-04-05T00:00:00+00:00",
    })

    mock_sb.return_value = FakeSb(db)

    out = attribution_for_period(WS, PERIOD_START, PERIOD_END)

    assert out["by_source"]["routing"] == 500
    # Only the non-overlapping connector row counts (100); the 444444 was excluded
    assert out["by_source"]["connectors"] == 100
    assert out["total_cents"] == 600
