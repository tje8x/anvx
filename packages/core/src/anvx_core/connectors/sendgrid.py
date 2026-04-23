"""SendGrid v2 connector — fetches email usage and plan costs."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.sendgrid.com/v3"

_PLAN_PRICING_CENTS = {
    "free": 0,
    "essentials": 1995,
    "pro": 8995,
    "premier": 24995,
}


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class SendGridConnector:
    provider = "sendgrid"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/user/account", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid SendGrid API key")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Authorization": f"Bearer {api_key}"}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get plan type for cost
            acct_resp = await client.get(f"{_API}/user/account", headers=headers)
            acct_resp.raise_for_status()
            plan_type = acct_resp.json().get("type", "free").lower()
            plan_cost = _PLAN_PRICING_CENTS.get(plan_type, 0)

            # Get email stats
            resp = await self._fetch_stats(client, headers, since, until)
            resp.raise_for_status()
            stats = resp.json()

            total_requests = 0
            for entry in stats:
                for stat in entry.get("stats", []):
                    total_requests += stat.get("metrics", {}).get("requests", 0)

            if plan_cost > 0:
                records.append(UsageRecord(
                    provider="sendgrid", model=f"{plan_type}_plan", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=plan_cost, currency="USD", ts=since,
                    raw={"plan": plan_type, "total_requests": total_requests},
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_stats(client: httpx.AsyncClient, headers: dict, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(f"{_API}/stats", headers=headers, params={"start_date": since.strftime("%Y-%m-%d"), "end_date": until.strftime("%Y-%m-%d"), "aggregated_by": "month"})
