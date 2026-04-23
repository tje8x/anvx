"""Notion v2 connector — seat-based cost tracking via API + manifest."""
import logging
from datetime import datetime, timedelta

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.notion.com/v1"

# Notion pricing per seat/month (cents)
_PLAN_SEAT_CENTS = {
    "plus": 1000,       # $10/seat
    "business": 1800,   # $18/seat
    "enterprise": 2500, # $25/seat (estimated)
}


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class NotionConnector:
    provider = "notion"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/users/me", headers={"Authorization": f"Bearer {api_key}", "Notion-Version": "2022-06-28"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Notion integration token")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Authorization": f"Bearer {api_key}", "Notion-Version": "2022-06-28"}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Count workspace members via users list
            resp = await self._fetch_users(client, headers)
            resp.raise_for_status()
            users = resp.json().get("results", [])
            member_count = sum(1 for u in users if u.get("type") == "person")

            if member_count == 0:
                return []

            # Default to "plus" plan — user can override via manifest
            seat_cost = _PLAN_SEAT_CENTS.get("plus", 1000)
            daily_cost = round(member_count * seat_cost / 30)

            current = since
            while current < until:
                records.append(UsageRecord(
                    provider="notion", model="plus_plan", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=daily_cost, currency="USD", ts=current,
                    raw={"members": member_count, "plan": "plus", "seat_cost_cents": seat_cost},
                ))
                current += timedelta(days=1)

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_users(client: httpx.AsyncClient, headers: dict) -> httpx.Response:
        return await client.get(f"{_API}/users", headers=headers)
