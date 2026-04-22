"""Anthropic v2 connector — fetches usage via the messages usage report API."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import Connector, UsageRecord

logger = logging.getLogger(__name__)

_BASE = "https://api.anthropic.com/v1"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class AnthropicConnector:
    provider = "anthropic"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{_BASE}/models",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                },
            )
            if resp.status_code == 401:
                raise PermissionError("Invalid Anthropic API key")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await self._fetch_report(client, headers, since, until)
            resp.raise_for_status()
            data = resp.json()

            for entry in data.get("data", []):
                model = entry.get("model")
                input_tokens = entry.get("input_tokens")
                output_tokens = entry.get("output_tokens")
                amount = entry.get("amount", 0)
                cost_cents = round(amount * 100)
                ts_str = entry.get("timestamp", since.isoformat())
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    ts = since

                records.append(UsageRecord(
                    provider="anthropic",
                    model=model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_cost_cents_usd=cost_cents,
                    currency="USD",
                    ts=ts,
                    raw=entry,
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_report(client: httpx.AsyncClient, headers: dict, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(
            f"{_BASE}/organizations/usage_report/messages",
            headers=headers,
            params={
                "starting_at": since.isoformat(),
                "ending_at": until.isoformat(),
            },
        )
