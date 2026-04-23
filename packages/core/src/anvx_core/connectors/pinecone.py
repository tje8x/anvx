"""Pinecone v2 connector — fetches index storage costs."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.pinecone.io"

_STORAGE_RATE_CENTS_PER_GB = 33  # $0.33/GB-month


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class PineconeConnector:
    provider = "pinecone"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/indexes", headers={"Api-Key": api_key})
            if resp.status_code in (401, 403):
                raise PermissionError("Invalid Pinecone API key")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Api-Key": api_key}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # List indexes
            resp = await self._fetch_indexes(client, headers)
            resp.raise_for_status()
            indexes = resp.json().get("indexes", [])

            total_storage_gb = 0.0
            for idx in indexes:
                host = idx.get("host", "")
                if not host:
                    continue
                stats_resp = await client.get(f"https://{host}/describe_index_stats", headers=headers)
                if stats_resp.status_code != 200:
                    continue
                stats = stats_resp.json()
                vector_count = stats.get("totalVectorCount", 0)
                dimension = stats.get("dimension", 0)
                storage_bytes = vector_count * dimension * 4 * 1.2
                total_storage_gb += storage_bytes / (1024 ** 3)

            if total_storage_gb > 0:
                cost_cents = round(total_storage_gb * _STORAGE_RATE_CENTS_PER_GB)
                records.append(UsageRecord(
                    provider="pinecone", model="storage", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=cost_cents, currency="USD", ts=since,
                    raw={"storage_gb": round(total_storage_gb, 3), "index_count": len(indexes)},
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_indexes(client: httpx.AsyncClient, headers: dict) -> httpx.Response:
        return await client.get(f"{_API}/indexes", headers=headers)
