"""Replicate v2 connector — fetches billing usage."""
import logging
from datetime import datetime, timedelta

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.replicate.com/v1"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class ReplicateConnector:
    provider = "replicate"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/account", headers={"Authorization": f"Token {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Replicate API token")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Authorization": f"Token {api_key}"}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await self._fetch_billing(client, headers)
            resp.raise_for_status()
            data = resp.json()

            period_used = float(data.get("current_period_used", 0))
            # Distribute evenly across days in window
            total_days = max(1, (until - since).days)
            daily_cost_cents = round(period_used * 100 / total_days)

            current = since
            while current < until:
                records.append(UsageRecord(
                    provider="replicate", model=None, input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=daily_cost_cents, currency="USD", ts=current,
                    raw={"period_used": period_used, "daily_share": daily_cost_cents},
                ))
                current += timedelta(days=1)

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_billing(client: httpx.AsyncClient, headers: dict) -> httpx.Response:
        return await client.get(f"{_API}/account/billing", headers=headers)
