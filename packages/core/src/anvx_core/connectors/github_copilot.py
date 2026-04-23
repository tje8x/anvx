"""GitHub Copilot v2 connector — fetches Copilot billing via GitHub API."""
import logging
from datetime import datetime, timedelta, timezone
from typing import Literal

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.github.com"

# Copilot Business: $19/seat/month ≈ 63 cents/day
_SEAT_DAILY_CENTS = 63


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class GitHubCopilotConnector:
    provider = "github_copilot"
    kind: Literal["api_key"] = "api_key"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/user", headers={"Authorization": f"Bearer {api_key}", "Accept": "application/vnd.github+json"})
            if resp.status_code == 401:
                raise PermissionError("Invalid GitHub PAT")
            resp.raise_for_status()
            scopes = resp.headers.get("X-OAuth-Scopes", "")
            if "manage_billing:copilot" not in scopes:
                raise PermissionError("PAT missing manage_billing:copilot scope")

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/vnd.github+json"}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get orgs the user admins
            orgs_resp = await client.get(f"{_API}/user/orgs", headers=headers)
            orgs_resp.raise_for_status()
            orgs = orgs_resp.json()
            if not orgs:
                return []

            org = orgs[0].get("login", "")
            if not org:
                return []

            # Get copilot billing
            billing_resp = await self._fetch_billing(client, headers, org)
            billing_resp.raise_for_status()
            billing = billing_resp.json()

            seat_count = billing.get("total_seats", 0) or billing.get("seat_breakdown", {}).get("total", 0)
            if seat_count == 0:
                return []

            # Emit one record per day in window
            current = since
            while current < until:
                records.append(UsageRecord(
                    provider="github_copilot", model="copilot_business", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=seat_count * _SEAT_DAILY_CENTS, currency="USD", ts=current,
                    raw={"seat_count": seat_count, "org": org},
                ))
                current += timedelta(days=1)

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_billing(client: httpx.AsyncClient, headers: dict, org: str) -> httpx.Response:
        return await client.get(f"{_API}/orgs/{org}/copilot/billing", headers=headers)
