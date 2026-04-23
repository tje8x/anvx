"""LangSmith v2 connector — fetches trace usage and seat costs."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.smith.langchain.com"

_BASE_TRACE_RATE_CENTS_PER_K = 250  # $2.50 per 1K
_EXTENDED_TRACE_RATE_CENTS_PER_K = 500  # $5.00 per 1K
_SEAT_COST_CENTS = 3900  # $39/seat/month
_INCLUDED_TRACES = 5000


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class LangSmithConnector:
    provider = "langsmith"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/api/v1/info", headers={"x-api-key": api_key})
            if resp.status_code in (401, 403):
                raise PermissionError("Invalid LangSmith API key")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"x-api-key": api_key}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await self._fetch(client, headers, since, until)
            resp.raise_for_status()
            data = resp.json()

            total_base = 0
            total_extended = 0
            total_seats = 0
            for entry in data.get("usage", []):
                total_base += entry.get("base_traces", 0)
                total_extended += entry.get("extended_traces", 0)
                total_seats = max(total_seats, entry.get("seats", 0))

            # Trace costs (overage beyond included)
            billable_base = max(0, total_base - _INCLUDED_TRACES)
            trace_cost = round(billable_base / 1000 * _BASE_TRACE_RATE_CENTS_PER_K + total_extended / 1000 * _EXTENDED_TRACE_RATE_CENTS_PER_K)
            if trace_cost > 0:
                records.append(UsageRecord(
                    provider="langsmith", model=None, input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=trace_cost, currency="USD", ts=since,
                    raw={"base_traces": total_base, "extended_traces": total_extended},
                ))

            # Seat costs
            if total_seats > 0:
                records.append(UsageRecord(
                    provider="langsmith", model=None, input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=total_seats * _SEAT_COST_CENTS, currency="USD", ts=since,
                    raw={"seats": total_seats},
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch(client: httpx.AsyncClient, headers: dict, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(f"{_API}/api/v1/usage", headers=headers, params={"start_date": since.strftime("%Y-%m-%d"), "end_date": until.strftime("%Y-%m-%d")})
