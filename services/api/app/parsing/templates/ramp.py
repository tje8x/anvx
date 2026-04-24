from collections.abc import Iterable, Iterator
from datetime import datetime
from decimal import Decimal, InvalidOperation

from ..parsed_transaction import ParsedTransaction

NAME = "ramp"


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
    return "date" in norm and "merchant" in norm and "amount" in norm


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
    i_merchant = _index_of(header, "Merchant")
    i_amount = _index_of(header, "Amount")
    i_category = _index_of(header, "Category")
    i_receipt = _index_of(header, "Receipt URL", "Receipt")

    if i_date is None or i_merchant is None or i_amount is None:
        raise ValueError("Ramp template requires Date, Merchant, and Amount columns")

    for row in rows:
        if not row or all(not (c or "").strip() for c in row):
            continue

        def get(idx: int | None) -> str:
            if idx is None or idx >= len(row):
                return ""
            return (row[idx] or "").strip()

        raw_date = get(i_date)
        try:
            txn_date = datetime.strptime(raw_date, "%m/%d/%Y").date()
        except ValueError:
            continue

        merchant = get(i_merchant)
        cents = _to_cents(get(i_amount))
        # Ramp amounts are positive magnitudes of spend — store as negative.
        amount_cents = -abs(cents)

        raw = {h: (row[i].strip() if i < len(row) else "") for i, h in enumerate(header)}

        yield ParsedTransaction(
            txn_date=txn_date,
            description=merchant or (get(i_category) if i_category is not None else ""),
            amount_cents=amount_cents,
            currency="USD",
            counterparty=merchant or None,
            reference=get(i_receipt) or None,
            raw=raw,
        )
