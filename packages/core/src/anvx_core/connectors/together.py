"""Together AI v2 connector — fetches per-day token usage."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.together.xyz/v1"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class TogetherConnector:
    provider = "together"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/models", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Together AI API key")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Authorization": f"Bearer {api_key}"}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await self._fetch_usage(client, headers, since, until)
            resp.raise_for_status()
            data = resp.json()

            for entry in data.get("data", []):
                ts_str = entry.get("date", since.isoformat())
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    ts = since
                model = entry.get("model")
                input_tokens = entry.get("input_tokens")
                output_tokens = entry.get("output_tokens")
                cost = float(entry.get("cost", 0))
                cost_cents = round(cost * 100)

                records.append(UsageRecord(
                    provider="together", model=model, input_tokens=input_tokens, output_tokens=output_tokens,
                    total_cost_cents_usd=cost_cents, currency="USD", ts=ts, raw=entry,
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_usage(client: httpx.AsyncClient, headers: dict, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(f"{_API}/usage", headers=headers, params={"start": since.isoformat(), "end": until.isoformat()})
