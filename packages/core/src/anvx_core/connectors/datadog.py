"""Datadog v2 connector — fetches infrastructure, logs, and APM usage costs."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.datadoghq.com"

# Per-unit monthly pricing (cents)
_INFRA_HOST_CENTS = 1500  # $15/host
_LOGS_GB_CENTS = 300  # $3/GB
_APM_HOST_CENTS = 800  # $8/host


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class DatadogConnector:
    provider = "datadog"

    async def validate(self, api_key: str) -> None:
        """api_key is JSON: {"api_key": ..., "app_key": ...}"""
        import json
        creds = json.loads(api_key)
        headers = {"DD-API-KEY": creds.get("api_key", ""), "DD-APPLICATION-KEY": creds.get("app_key", "")}
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/api/v1/validate", headers=headers)
            if resp.status_code == 403:
                raise PermissionError("Invalid Datadog credentials")
            resp.raise_for_status()
            if not resp.json().get("valid", False):
                raise PermissionError("Datadog API key validation failed")

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        import json
        creds = json.loads(api_key)
        headers = {"DD-API-KEY": creds["api_key"], "DD-APPLICATION-KEY": creds["app_key"]}
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Infrastructure hosts
            resp = await self._fetch_endpoint(client, headers, "/api/v2/usage/hosts", since, until)
            resp.raise_for_status()
            host_count = self._extract_max(resp.json())
            if host_count > 0:
                records.append(UsageRecord(
                    provider="datadog", model="Infrastructure Hosts", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=round(host_count * _INFRA_HOST_CENTS), currency="USD", ts=since,
                    raw={"host_count": host_count},
                ))

            # Logs
            resp = await self._fetch_endpoint(client, headers, "/api/v2/usage/logs", since, until)
            resp.raise_for_status()
            logs_gb = self._extract_sum(resp.json(), "ingested_bytes") / (1024 ** 3)
            if logs_gb > 0:
                records.append(UsageRecord(
                    provider="datadog", model="Log Management", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=round(logs_gb * _LOGS_GB_CENTS), currency="USD", ts=since,
                    raw={"logs_gb": round(logs_gb, 2)},
                ))

            # APM
            resp = await self._fetch_endpoint(client, headers, "/api/v2/usage/apm", since, until)
            resp.raise_for_status()
            apm_count = self._extract_max(resp.json())
            if apm_count > 0:
                records.append(UsageRecord(
                    provider="datadog", model="APM Hosts", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=round(apm_count * _APM_HOST_CENTS), currency="USD", ts=since,
                    raw={"apm_host_count": apm_count},
                ))

        return records

    @staticmethod
    def _extract_max(data: dict) -> float:
        vals = [entry.get("attributes", {}).get("host_count", 0) or entry.get("attributes", {}).get("apm_host_count", 0) for entry in data.get("data", [])]
        return max(vals) if vals else 0

    @staticmethod
    def _extract_sum(data: dict, field: str) -> float:
        return sum(entry.get("attributes", {}).get(field, 0) for entry in data.get("data", []))

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_endpoint(client: httpx.AsyncClient, headers: dict, path: str, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(f"{_API}{path}", headers=headers, params={"start_hr": since.strftime("%Y-%m-%dT00"), "end_hr": until.strftime("%Y-%m-%dT23")})
