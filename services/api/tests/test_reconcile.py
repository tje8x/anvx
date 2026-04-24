"""Tests for app.reconcile.match_document.

Uses a small in-memory FakeSupabase that mimics the subset of postgrest-py
method chaining the reconciler needs, so we can exercise the scoring and
idempotency logic without a real database.
"""
from __future__ import annotations

import csv
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import uuid4

import pytest

from app.parsing.templates import svb as svb_tpl
from app.reconcile import match_document


FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "test-fixtures" / "fixtures"

WS = "ws-test-1"
DOC = "doc-test-1"

DEFAULT_ALIASES = [
    {"provider": "openai", "alias": "OPENAI"},
    {"provider": "anthropic", "alias": "ANTHROPIC PBC"},
    {"provider": "anthropic", "alias": "ANTHROPIC"},
    {"provider": "aws", "alias": "AWS"},
    {"provider": "aws", "alias": "AMAZON WEB SERVICES"},
    {"provider": "google_cloud", "alias": "GOOGLE*GSUITE"},
    {"provider": "google_cloud", "alias": "GOOGLE*GEMINI"},
    {"provider": "vercel", "alias": "VERCEL INC"},
    {"provider": "stripe", "alias": "STRIPE"},
    {"provider": "notion", "alias": "NOTION LABS"},
    {"provider": "linear", "alias": "LINEAR.APP"},
    {"provider": "github", "alias": "GITHUB"},
    {"provider": "sentry", "alias": "FUNCTIONAL SOFTWARE"},
    {"provider": "resend", "alias": "RESEND.COM"},
]


class FakeQuery:
    def __init__(self, table: str, db: "FakeDB", op: str = "select"):
        self.table = table
        self.db = db
        self.op = op
        self.filters: list[tuple[str, str, Any]] = []
        self.in_values: dict[str, list[Any]] = {}
        self.select_cols: str | None = None
        self.payload: Any = None
        self._limit: int | None = None

    def select(self, cols: str = "*"):
        self.select_cols = cols
        self.op = "select"
        return self

    def eq(self, col: str, val: Any):
        self.filters.append((col, "eq", val)); return self

    def gte(self, col: str, val: Any):
        self.filters.append((col, "gte", val)); return self

    def lt(self, col: str, val: Any):
        self.filters.append((col, "lt", val)); return self

    def in_(self, col: str, values: list[Any]):
        self.in_values[col] = list(values); return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, n: int):
        self._limit = n; return self

    def single(self):
        self._limit = 1; return self

    def insert(self, payload):
        self.op = "insert"; self.payload = payload; return self

    def upsert(self, payload, on_conflict: str | None = None, ignore_duplicates: bool = False):
        self.op = "upsert"; self.payload = payload
        self._on_conflict = on_conflict
        self._ignore_dupes = ignore_duplicates
        return self

    def update(self, payload):
        self.op = "update"; self.payload = payload; return self

    def delete(self):
        self.op = "delete"; return self

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

        if self.op == "select":
            matched = [r for r in rows if self._match(r)]
            if self._limit is not None:
                matched = matched[: self._limit]
            return R(matched)

        if self.op == "insert":
            payload = self.payload if isinstance(self.payload, list) else [self.payload]
            inserted = []
            for p in payload:
                row = {**p}
                row.setdefault("id", str(uuid4()))
                # Simulate the reconciliation_matches unique constraint
                if self.table == "reconciliation_matches":
                    existing_ids = {r["document_transaction_id"] for r in rows}
                    if row["document_transaction_id"] in existing_ids:
                        raise RuntimeError("duplicate key value violates unique constraint (23505)")
                rows.append(row); inserted.append(row)
            self.db.tables[self.table] = rows
            return R(inserted)

        if self.op == "upsert":
            payload = self.payload if isinstance(self.payload, list) else [self.payload]
            inserted = []
            for p in payload:
                conflict_col = getattr(self, "_on_conflict", None)
                if conflict_col:
                    existing = next((r for r in rows if r.get(conflict_col) == p.get(conflict_col)), None)
                    if existing is not None:
                        if getattr(self, "_ignore_dupes", False):
                            continue
                        existing.update(p); inserted.append(existing); continue
                row = {**p, "id": str(uuid4())}
                rows.append(row); inserted.append(row)
            self.db.tables[self.table] = rows
            return R(inserted)

        if self.op == "delete":
            remaining = [r for r in rows if not self._match(r) or
                         any(r.get(c) not in v for c, v in self.in_values.items() or [])]
            if self.in_values:
                remaining = [r for r in rows if not (self._match(r) and all(r.get(c) in v for c, v in self.in_values.items()))]
            else:
                remaining = [r for r in rows if not self._match(r)]
            removed = [r for r in rows if r not in remaining]
            self.db.tables[self.table] = remaining
            return R(removed)

        if self.op == "update":
            matched = [r for r in rows if self._match(r)]
            for r in matched:
                r.update(self.payload)
            return R(matched)

        return R([])


class FakeDB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {
            "vendor_aliases": [dict(a) for a in DEFAULT_ALIASES],
            "document_transactions": [],
            "routing_usage_records": [],
            "reconciliation_matches": [],
            "reconciliation_candidates": [],
        }

    def from_(self, table: str) -> FakeQuery:
        return FakeQuery(table, self)


class FakeSb:
    def __init__(self, db: FakeDB):
        self._db = db

    def from_(self, table: str):
        return self._db.from_(table)


def _load_svb_january(db: FakeDB) -> list[dict]:
    path = FIXTURES / "bank" / "svb-2026-01.csv"
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        header = [h.strip() for h in next(reader)]
        rows = list(reader)

    parsed = list(svb_tpl.parse(iter(rows), header))

    db_rows: list[dict] = []
    for i, p in enumerate(parsed):
        row = {
            "id": str(uuid4()),
            "document_id": DOC,
            "workspace_id": WS,
            "row_index": i,
            "txn_date": p.txn_date.isoformat(),
            "description": p.description,
            "amount_cents": p.amount_cents,
        }
        db_rows.append(row)
    db.tables["document_transactions"] = db_rows
    return db_rows


# ─── tests ────────────────────────────────────────────────────


@patch("app.reconcile.sb_service")
def test_svb_statement_has_unmatched_payroll_rent_etc(mock_sb):
    db = FakeDB()
    _load_svb_january(db)
    # No routing_usage_records seeded
    mock_sb.return_value = FakeSb(db)

    summary = match_document(WS, DOC)

    # Payroll, rent, Amex payments, Stripe payouts, legal etc. have no aliases that match
    # OR have no routing history → unmatched
    assert summary["unmatched"] >= 10
    assert summary["auto_matched"] == 0
    # reconciliation_matches table should be empty
    assert db.tables["reconciliation_matches"] == []


@patch("app.reconcile.sb_service")
def test_aws_row_auto_matches_when_routing_usage_exists(mock_sb):
    db = FakeDB()
    txns = _load_svb_january(db)

    aws_row = next(t for t in txns if "AWS AUTOPAY" in t["description"])
    aws_cents_abs = abs(aws_row["amount_cents"])  # 208744 = $2087.44
    aws_date = date.fromisoformat(aws_row["txn_date"])

    # Seed routing_usage_records on the exact AWS date summing to the same cost
    created_at = datetime.combine(aws_date, datetime.min.time(), tzinfo=timezone.utc)
    half = aws_cents_abs // 2
    db.tables["routing_usage_records"] = [
        {"id": str(uuid4()), "workspace_id": WS, "provider": "aws",
         "provider_cost_cents": half, "markup_cents": 0,
         "created_at": created_at.isoformat()},
        {"id": str(uuid4()), "workspace_id": WS, "provider": "aws",
         "provider_cost_cents": aws_cents_abs - half, "markup_cents": 0,
         "created_at": (created_at + timedelta(hours=6)).isoformat()},
    ]

    mock_sb.return_value = FakeSb(db)

    summary = match_document(WS, DOC)

    assert summary["auto_matched"] >= 1
    matches = db.tables["reconciliation_matches"]
    aws_match = next((m for m in matches if m["document_transaction_id"] == aws_row["id"]), None)
    assert aws_match is not None
    assert aws_match["auto"] is True
    assert aws_match["source_kind"] == "routing"
    assert aws_match["confidence"] >= 85
    # source_id should point at one of the seeded routing rows
    seeded_ids = {r["id"] for r in db.tables["routing_usage_records"]}
    assert aws_match["source_id"] in seeded_ids


@patch("app.reconcile.sb_service")
def test_match_document_is_idempotent(mock_sb):
    db = FakeDB()
    txns = _load_svb_january(db)

    aws_row = next(t for t in txns if "AWS AUTOPAY" in t["description"])
    aws_cents_abs = abs(aws_row["amount_cents"])
    aws_date = date.fromisoformat(aws_row["txn_date"])
    created_at = datetime.combine(aws_date, datetime.min.time(), tzinfo=timezone.utc)
    db.tables["routing_usage_records"] = [
        {"id": str(uuid4()), "workspace_id": WS, "provider": "aws",
         "provider_cost_cents": aws_cents_abs, "markup_cents": 0,
         "created_at": created_at.isoformat()},
    ]

    mock_sb.return_value = FakeSb(db)

    first = match_document(WS, DOC)
    matches_after_first = list(db.tables["reconciliation_matches"])

    second = match_document(WS, DOC)
    matches_after_second = db.tables["reconciliation_matches"]

    # Same count — no duplicate rows created
    assert len(matches_after_second) == len(matches_after_first)
    # Same matched document_transaction_id set
    ids_first = {m["document_transaction_id"] for m in matches_after_first}
    ids_second = {m["document_transaction_id"] for m in matches_after_second}
    assert ids_first == ids_second
    # Summary from second run still counts previously-matched rows as auto_matched
    assert second["auto_matched"] >= first["auto_matched"]
