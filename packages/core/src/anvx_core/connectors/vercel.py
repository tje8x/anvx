"""Vercel v2 connector — fetches usage data and converts to costs."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.vercel.com"

# Published Vercel pricing (Pro plan)
_PRO_BASE_CENTS = 2000  # $20/month
_FUNCTION_RATE_CENTS_PER_M = 60  # $0.60 per 1M invocations
_BANDWIDTH_RATE_CENTS_PER_GB = 15  # $0.15 per GB
_BUILD_RATE_CENTS_PER_MIN = 1  # $0.01 per minute
_INCLUDED_INVOCATIONS = 1_000_000
_INCLUDED_BANDWIDTH_GB = 1000
_INCLUDED_BUILD_MINUTES = 6000


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class VercelConnector:
    provider = "vercel"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/v2/user", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Vercel API token")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        headers = {"Authorization": f"Bearer {api_key}"}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get team ID
            user_resp = await client.get(f"{_API}/v2/user", headers=headers)
            user_resp.raise_for_status()
            team_id = user_resp.json().get("user", {}).get("defaultTeamId", "")

            params: dict = {}
            if team_id:
                params["teamId"] = team_id

            resp = await self._fetch_usage(client, headers, params)
            resp.raise_for_status()
            usage = resp.json()

            ts = until

            # Base plan cost
            records.append(UsageRecord(
                provider="vercel", model="Pro Plan", input_tokens=None, output_tokens=None,
                total_cost_cents_usd=_PRO_BASE_CENTS, currency="USD", ts=ts, raw={"type": "base_plan"},
            ))

            # Function invocations overage
            invocations = usage.get("functionInvocations", 0)
            overage = max(0, invocations - _INCLUDED_INVOCATIONS)
            if overage > 0:
                cost = round(overage / 1_000_000 * _FUNCTION_RATE_CENTS_PER_M)
                records.append(UsageRecord(
                    provider="vercel", model="Functions", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=cost, currency="USD", ts=ts, raw={"invocations": invocations, "overage": overage},
                ))

            # Bandwidth overage
            bandwidth_gb = usage.get("bandwidthGB", 0)
            bw_overage = max(0, bandwidth_gb - _INCLUDED_BANDWIDTH_GB)
            if bw_overage > 0:
                cost = round(bw_overage * _BANDWIDTH_RATE_CENTS_PER_GB)
                records.append(UsageRecord(
                    provider="vercel", model="Bandwidth", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=cost, currency="USD", ts=ts, raw={"bandwidth_gb": bandwidth_gb},
                ))

            # Build minutes overage
            build_minutes = usage.get("buildMinutes", 0)
            build_overage = max(0, build_minutes - _INCLUDED_BUILD_MINUTES)
            if build_overage > 0:
                cost = round(build_overage * _BUILD_RATE_CENTS_PER_MIN)
                records.append(UsageRecord(
                    provider="vercel", model="Build", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=cost, currency="USD", ts=ts, raw={"build_minutes": build_minutes},
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_usage(client: httpx.AsyncClient, headers: dict, params: dict) -> httpx.Response:
        return await client.get(f"{_API}/v1/usage", headers=headers, params=params)
