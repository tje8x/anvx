from collections.abc import Iterable, Iterator
from datetime import datetime
from decimal import Decimal, InvalidOperation

from ..parsed_transaction import ParsedTransaction

NAME = "svb"


def _index_of(header: list[str], *candidates: str) -> int | None:
    norm = [h.strip().lower() for h in header]
    for c in candidates:
        try:
            return norm.index(c.lower())
        except ValueError:
            continue
    return None


def match(header: list[str]) -> bool:
    norm = {h.strip().lower() for h in header}
    has_date = "date" in norm
    has_desc = "description" in norm
    has_amount = "debit" in norm or "credit" in norm
    return has_date and has_desc and has_amount


def _to_cents(value: str) -> int:
    value = (value or "").strip().replace("$", "").replace(",", "")
    if not value:
        return 0
    try:
        return int((Decimal(value) * 100).to_integral_value())
    except InvalidOperation:
        return 0


def parse(rows: Iterable[list[str]], header: list[str]) -> Iterator[ParsedTransaction]:
    i_date = _index_of(header, "Date")
    i_desc = _index_of(header, "Description")
    i_debit = _index_of(header, "Debit")
    i_credit = _index_of(header, "Credit")
    i_balance = _index_of(header, "Balance")

    if i_date is None or i_desc is None:
        raise ValueError("SVB template requires Date and Description columns")

    for row in rows:
        if not row or all(not (c or "").strip() for c in row):
            continue

        def get(idx: int | None) -> str:
            if idx is None or idx >= len(row):
                return ""
            return (row[idx] or "").strip()

        desc = get(i_desc)
        # Skip opening-balance marker rows — they aren't transactions
        if desc.upper() == "OPENING BALANCE":
            continue

        raw_date = get(i_date)
        try:
            txn_date = datetime.strptime(raw_date, "%m/%d/%Y").date()
        except ValueError:
            continue

        debit_cents = _to_cents(get(i_debit))
        credit_cents = _to_cents(get(i_credit))

        if debit_cents and not credit_cents:
            amount_cents = -debit_cents
        elif credit_cents and not debit_cents:
            amount_cents = credit_cents
        else:
            amount_cents = credit_cents - debit_cents

        raw = {h: (row[i].strip() if i < len(row) else "") for i, h in enumerate(header)}

        yield ParsedTransaction(
            txn_date=txn_date,
            description=desc,
            amount_cents=amount_cents,
            currency="USD",
            counterparty=desc or None,
            reference=get(i_balance) or None,
            raw=raw,
        )
