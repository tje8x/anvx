"""Supabase v2 connector — fetches org-level billing via Management API."""
import logging
from datetime import datetime, timedelta

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.supabase.com/v1"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class SupabaseBillingConnector:
    provider = "supabase"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/organizations", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Supabase access token")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Authorization": f"Bearer {api_key}"}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get org
            org_resp = await client.get(f"{_API}/organizations", headers=headers)
            org_resp.raise_for_status()
            orgs = org_resp.json()
            if not orgs:
                return []
            org_slug = orgs[0].get("slug", "")
            if not org_slug:
                return []

            # Get billing
            billing_resp = await self._fetch_billing(client, headers, org_slug)
            billing_resp.raise_for_status()
            billing = billing_resp.json()

            # Extract current period cost
            total_cost = float(billing.get("total_cost", 0) or billing.get("amount", 0))
            if total_cost <= 0:
                return []

            cost_cents = round(total_cost * 100)
            total_days = max(1, (until - since).days)
            daily_cents = cost_cents // total_days

            current = since
            while current < until:
                records.append(UsageRecord(
                    provider="supabase", model=billing.get("plan", "pro"), input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=daily_cents, currency="USD", ts=current,
                    raw={"org": org_slug, "total_cost": total_cost},
                ))
                current += timedelta(days=1)

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_billing(client: httpx.AsyncClient, headers: dict, org_slug: str) -> httpx.Response:
        return await client.get(f"{_API}/organizations/{org_slug}/billing", headers=headers)
