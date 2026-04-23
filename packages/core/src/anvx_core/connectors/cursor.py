"""Cursor v2 connector — parses exported CSV usage data."""
import csv
import io
import logging
from datetime import datetime
from typing import Literal

from .base import UsageRecord

logger = logging.getLogger(__name__)


class CursorConnector:
    provider = "cursor"
    kind: Literal["csv_source"] = "csv_source"

    async def parse_input(self, raw: str) -> list[UsageRecord]:
        return parse_csv(raw)


def parse_csv(csv_content: str) -> list[UsageRecord]:
    """Tolerant CSV parser for Cursor usage exports."""
    reader = csv.reader(io.StringIO(csv_content))
    records: list[UsageRecord] = []

    # Find header row
    header: list[str] | None = None
    header_row_idx = 0
    for i, row in enumerate(reader):
        lower = [c.strip().lower() for c in row]
        if "cost" in lower and "date" in lower:
            header = lower
            header_row_idx = i
            break

    if header is None:
        raise ValueError("CSV missing required 'Date' and 'Cost' columns")

    date_idx = header.index("date")
    cost_idx = header.index("cost")
    model_idx = header.index("model") if "model" in header else None

    unexpected = [c for c in header if c not in ("date", "cost", "model", "tokens", "requests", "")]
    if unexpected:
        logger.warning("Cursor CSV has unexpected columns: %s", unexpected)

    for row in reader:
        if len(row) <= max(date_idx, cost_idx):
            continue
        try:
            date_str = row[date_idx].strip()
            cost_str = row[cost_idx].strip().lstrip("$")
            cost = float(cost_str)
            ts = datetime.fromisoformat(date_str)
        except (ValueError, IndexError):
            continue

        model = row[model_idx].strip() if model_idx is not None and model_idx < len(row) else None
        records.append(UsageRecord(
            provider="cursor", model=model, input_tokens=None, output_tokens=None,
            total_cost_cents_usd=round(cost * 100), currency="USD", ts=ts, raw={"source": "csv"},
        ))

    return records
