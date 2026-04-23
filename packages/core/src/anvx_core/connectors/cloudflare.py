"""Cloudflare v2 connector — fetches Workers and R2 usage costs."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.cloudflare.com/client/v4"

# Published Cloudflare pricing
_WORKERS_BASE_CENTS = 500  # $5/month
_WORKERS_INCLUDED_REQUESTS = 10_000_000
_WORKERS_RATE_CENTS_PER_M = 30  # $0.30 per 1M requests
_R2_STORAGE_RATE_CENTS_PER_GB = 2  # $0.015 per GB-month (rounded up)


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class CloudflareConnector:
    provider = "cloudflare"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/user/tokens/verify", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Cloudflare API token")
            resp.raise_for_status()
            data = resp.json()
            if not data.get("success"):
                raise PermissionError("Cloudflare token verification failed")

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Authorization": f"Bearer {api_key}"}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get account ID
            acct_resp = await client.get(f"{_API}/accounts", headers=headers, params={"per_page": 1})
            acct_resp.raise_for_status()
            accounts = acct_resp.json().get("result", [])
            if not accounts:
                return []
            account_id = accounts[0]["id"]

            # Workers analytics
            workers_resp = await self._fetch_workers(client, headers, account_id, since, until)
            workers_resp.raise_for_status()
            workers_data = workers_resp.json()

            totals = workers_data.get("result", {}).get("totals", {})
            requests = totals.get("requests", 0)
            overage = max(0, requests - _WORKERS_INCLUDED_REQUESTS)
            workers_cost = _WORKERS_BASE_CENTS + round(overage / 1_000_000 * _WORKERS_RATE_CENTS_PER_M)

            records.append(UsageRecord(
                provider="cloudflare", model="Workers", input_tokens=None, output_tokens=None,
                total_cost_cents_usd=workers_cost, currency="USD", ts=until,
                raw={"requests": requests, "overage": overage},
            ))

            # R2 storage
            r2_resp = await self._fetch_r2(client, headers, account_id)
            r2_resp.raise_for_status()
            buckets = r2_resp.json().get("result", {}).get("buckets", [])

            total_bytes = sum(b.get("size", 0) for b in buckets)
            total_gb = total_bytes / (1024 ** 3)
            r2_cost = round(total_gb * _R2_STORAGE_RATE_CENTS_PER_GB)

            if r2_cost > 0:
                records.append(UsageRecord(
                    provider="cloudflare", model="R2 Storage", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=r2_cost, currency="USD", ts=until,
                    raw={"storage_gb": round(total_gb, 2), "buckets": len(buckets)},
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_workers(client: httpx.AsyncClient, headers: dict, account_id: str, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(
            f"{_API}/accounts/{account_id}/workers/analytics/aggregate",
            headers=headers,
            params={"since": since.isoformat(), "until": until.isoformat()},
        )

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_r2(client: httpx.AsyncClient, headers: dict, account_id: str) -> httpx.Response:
        return await client.get(f"{_API}/accounts/{account_id}/r2/buckets", headers=headers)
