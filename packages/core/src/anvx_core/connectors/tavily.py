"""Tavily v2 connector — fetches search credit usage costs."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.tavily.com"

_CREDIT_COST_CENTS = 1  # $0.008 per credit ≈ 1 cent rounded


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class TavilyConnector:
    provider = "tavily"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(f"{_API}/search", json={"api_key": api_key, "query": "test", "max_results": 1, "search_depth": "basic"})
            if resp.status_code in (401, 403):
                raise PermissionError("Invalid Tavily API key")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await self._fetch(client, api_key)
            resp.raise_for_status()

            credits_total = int(resp.headers.get("x-credits-total", "0"))
            credits_remaining = int(resp.headers.get("x-credits-remaining", "0"))
            credits_used = credits_total - credits_remaining

            if credits_used > 0:
                cost_cents = round(credits_used * _CREDIT_COST_CENTS)
                records.append(UsageRecord(
                    provider="tavily", model="search", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=cost_cents, currency="USD", ts=since,
                    raw={"credits_used": credits_used, "credits_total": credits_total, "credits_remaining": credits_remaining},
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch(client: httpx.AsyncClient, api_key: str) -> httpx.Response:
        return await client.post(f"{_API}/search", json={"api_key": api_key, "query": "test", "max_results": 1, "search_depth": "basic"})
