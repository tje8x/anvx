import csv
import io
from datetime import date
from pathlib import Path

import pytest

from app.parsing.auto_detect import NoTemplateMatch, detect
from app.parsing.templates import ramp as ramp_tpl
from app.parsing.templates import svb as svb_tpl


FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "test-fixtures" / "fixtures"


def _read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        rows = list(reader)
    return [h.strip() for h in header], rows


def test_svb_template_parses_january_statement():
    header, rows = _read_csv(FIXTURES / "bank" / "svb-2026-01.csv")

    assert svb_tpl.match(header)

    parsed = list(svb_tpl.parse(iter(rows), header))

    # Original CSV has ~27 rows including OPENING BALANCE which the template skips.
    assert 20 <= len(parsed) <= 35, f"expected ~25-30 parsed rows, got {len(parsed)}"

    # All parsed dates are in January 2026
    assert all(p.txn_date.year == 2026 and p.txn_date.month == 1 for p in parsed)
    # No "opening balance" row leaked through
    assert not any(p.description.upper() == "OPENING BALANCE" for p in parsed)

    # Find a known debit: Gusto payroll ($18,142.55) — must be negative
    payroll = [p for p in parsed if "GUSTO PAYROLL" in p.description]
    assert payroll, "expected GUSTO PAYROLL rows"
    assert all(p.amount_cents == -1814255 for p in payroll)

    # Find a known credit: Stripe payout — must be positive
    stripe = [p for p in parsed if "STRIPE TRANSFER" in p.description]
    assert stripe, "expected STRIPE TRANSFER credit rows"
    assert all(p.amount_cents > 0 for p in stripe)

    # Rent debit -$4,500.00
    rent = [p for p in parsed if p.description.startswith("RENT")]
    assert rent and rent[0].amount_cents == -450000


def test_ramp_template_parses_january_card_statement():
    header, rows = _read_csv(FIXTURES / "cc" / "ramp-2026-01.csv")

    assert ramp_tpl.match(header)

    parsed = list(ramp_tpl.parse(iter(rows), header))

    assert 50 <= len(parsed) <= 70, f"expected ~60 parsed rows, got {len(parsed)}"

    # All card spend — every amount must be negative
    assert all(p.amount_cents < 0 for p in parsed), "all Ramp rows should be negative spend"

    # Every row should have a counterparty (merchant)
    assert all(p.counterparty for p in parsed)

    # Spot-check: at least one OPENAI row
    openai_rows = [p for p in parsed if p.counterparty == "OPENAI"]
    assert len(openai_rows) >= 10
    assert all(p.txn_date.year == 2026 and p.txn_date.month == 1 for p in openai_rows)


def test_auto_detect_raises_on_unknown_header():
    bogus_header = ["foo", "bar", "baz"]
    with pytest.raises(NoTemplateMatch) as excinfo:
        detect(bogus_header)

    msg = str(excinfo.value)
    assert "svb" in msg and "ramp" in msg
    assert "foo" in msg
