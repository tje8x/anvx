"""OpenAI v2 connector — fetches usage via the completions usage API."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import Connector, UsageRecord

logger = logging.getLogger(__name__)

_BASE = "https://api.openai.com/v1"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class OpenAIConnector:
    provider = "openai"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{_BASE}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if resp.status_code == 401:
                raise PermissionError("Invalid OpenAI API key")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Authorization": f"Bearer {api_key}"}
        records: list[UsageRecord] = []
        page: str | None = None

        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                params: dict = {
                    "start_time": int(since.timestamp()),
                    "end_time": int(until.timestamp()),
                    "bucket_width": "1d",
                    "group_by": ["model"],
                }
                if page:
                    params["next_page"] = page

                resp = await self._fetch_page(client, headers, params)
                resp.raise_for_status()
                data = resp.json()

                for bucket in data.get("data", []):
                    bucket_ts = datetime.fromtimestamp(bucket["start_time"]) if "start_time" in bucket else since
                    for result in bucket.get("results", []):
                        model = result.get("model")
                        input_tokens = result.get("input_tokens")
                        output_tokens = result.get("output_tokens")
                        amount = result.get("amount", 0)
                        cost_cents = round(amount * 100)

                        records.append(UsageRecord(
                            provider="openai",
                            model=model,
                            input_tokens=input_tokens,
                            output_tokens=output_tokens,
                            total_cost_cents_usd=cost_cents,
                            currency="USD",
                            ts=bucket_ts,
                            raw=result,
                        ))

                page = data.get("next_page")
                if not page:
                    break

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_page(client: httpx.AsyncClient, headers: dict, params: dict) -> httpx.Response:
        return await client.get(f"{_BASE}/organization/usage/completions", headers=headers, params=params)
