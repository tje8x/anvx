from dataclasses import dataclass, field
from datetime import date


@dataclass
class ParsedTransaction:
    txn_date: date
    description: str
    amount_cents: int
    currency: str = "USD"
    counterparty: str | None = None
    reference: str | None = None
    raw: dict = field(default_factory=dict)
