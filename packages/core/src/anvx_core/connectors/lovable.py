"""Lovable v2 connector — manifest-based subscription cost tracking."""
import calendar
import json
import logging
from datetime import datetime, timedelta
from typing import Literal

from .base import UsageRecord

logger = logging.getLogger(__name__)


class LovableConnector:
    provider = "lovable"
    kind: Literal["manifest"] = "manifest"

    async def parse_input(self, raw: str) -> list[UsageRecord]:
        return _parse_manifest(raw)


def _parse_manifest(manifest_json: str, since: datetime | None = None, until: datetime | None = None) -> list[UsageRecord]:
    try:
        data = json.loads(manifest_json)
    except json.JSONDecodeError:
        raise ValueError("Invalid manifest JSON")

    plan = data.get("plan")
    if plan not in ("pro", "team", "enterprise"):
        raise ValueError(f"Invalid plan: {plan}")

    monthly_cents = data.get("monthly_cents")
    if not isinstance(monthly_cents, int) or monthly_cents < 0:
        raise ValueError("monthly_cents must be a non-negative integer")

    renews_on = data.get("renews_on")
    if not renews_on:
        raise ValueError("renews_on is required")

    # Use renews_on to determine the billing month
    renew_date = datetime.fromisoformat(renews_on)
    days_in_month = calendar.monthrange(renew_date.year, renew_date.month)[1]
    daily_cents = monthly_cents // days_in_month

    now = until or datetime.now()
    start = since or (now - timedelta(days=30))

    records: list[UsageRecord] = []
    current = start
    while current < now:
        records.append(UsageRecord(
            provider="lovable", model=plan, input_tokens=None, output_tokens=None,
            total_cost_cents_usd=daily_cents, currency="USD", ts=current,
            raw={"plan": plan, "monthly_cents": monthly_cents},
        ))
        current += timedelta(days=1)

    return records
