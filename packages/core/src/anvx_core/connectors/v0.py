"""v0 connector — manifest-based subscription cost tracking.

Special: if the workspace also has a connected Vercel provider, emit
zero-cost records with a subsumed_by note (Vercel reports the combined bill).
"""
import calendar
import json
import logging
from datetime import datetime, timedelta
from typing import Literal

from .base import UsageRecord

logger = logging.getLogger(__name__)


class V0Connector:
    provider = "v0"
    kind: Literal["manifest"] = "manifest"

    async def parse_input(self, raw: str, vercel_connected: bool = False) -> list[UsageRecord]:
        return _parse_manifest(raw, vercel_connected=vercel_connected)


def _parse_manifest(manifest_json: str, since: datetime | None = None, until: datetime | None = None, vercel_connected: bool = False) -> list[UsageRecord]:
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

    renew_date = datetime.fromisoformat(renews_on)
    days_in_month = calendar.monthrange(renew_date.year, renew_date.month)[1]
    daily_cents = 0 if vercel_connected else (monthly_cents // days_in_month)

    now = until or datetime.now()
    start = since or (now - timedelta(days=30))

    records: list[UsageRecord] = []
    current = start
    while current < now:
        raw: dict = {"plan": plan, "monthly_cents": monthly_cents}
        if vercel_connected:
            raw["subsumed_by"] = "vercel"
        records.append(UsageRecord(
            provider="v0", model=plan, input_tokens=None, output_tokens=None,
            total_cost_cents_usd=daily_cents, currency="USD", ts=current, raw=raw,
        ))
        current += timedelta(days=1)

    return records
