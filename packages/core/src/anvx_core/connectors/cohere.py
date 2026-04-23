"""Cohere v2 connector — validates key, billing API pending."""
import logging
from datetime import datetime, timedelta

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.cohere.com/v1"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class CohereConnector:
    provider = "cohere"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/models", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Cohere API key")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        logger.warning("Cohere doesn't expose a usage API. For v2, usage tracking is not yet automated.")
        records: list[UsageRecord] = []
        # Emit one "awaiting billing" record per month in the window
        current = since.replace(day=1)
        while current < until:
            records.append(UsageRecord(
                provider="cohere", model=None, input_tokens=None, output_tokens=None,
                total_cost_cents_usd=0, currency="USD", ts=current,
                raw={"status": "pending_billing_api"},
            ))
            # Advance to next month
            if current.month == 12:
                current = current.replace(year=current.year + 1, month=1)
            else:
                current = current.replace(month=current.month + 1)
        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch(client: httpx.AsyncClient, url: str, headers: dict) -> httpx.Response:
        return await client.get(url, headers=headers)
