"""AWS v2 connector — fetches daily spend via Cost Explorer API."""
import json
import logging
from datetime import datetime, timedelta

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_CE_ENDPOINT = "https://ce.{region}.amazonaws.com"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class AWSConnector:
    provider = "aws"

    async def validate(self, api_key: str) -> None:
        """api_key is JSON: {"access_key_id": ..., "secret_access_key": ..., "region": ...}"""
        creds = json.loads(api_key)
        access_key_id = creds.get("access_key_id", "")
        secret_access_key = creds.get("secret_access_key", "")
        region = creds.get("region", "us-east-1")
        if not access_key_id or not secret_access_key:
            raise PermissionError("Missing AWS access_key_id or secret_access_key")

        endpoint = _CE_ENDPOINT.format(region=region)
        now = datetime.utcnow()
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        today = now.strftime("%Y-%m-%d")
        tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")

        headers = {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSInsightsIndexService.GetCostAndUsage",
            "X-Amz-Date": amz_date,
            "Host": f"ce.{region}.amazonaws.com",
        }
        payload = json.dumps({
            "TimePeriod": {"Start": today, "End": tomorrow},
            "Granularity": "DAILY",
            "Metrics": ["UnblendedCost"],
        })

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(endpoint, headers=headers, content=payload)
            if resp.status_code in (401, 403):
                raise PermissionError("Invalid AWS credentials or insufficient permissions")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        creds = json.loads(api_key)
        region = creds.get("region", "us-east-1")
        endpoint = _CE_ENDPOINT.format(region=region)
        records: list[UsageRecord] = []

        now = datetime.utcnow()
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")

        headers = {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSInsightsIndexService.GetCostAndUsage",
            "X-Amz-Date": amz_date,
            "Host": f"ce.{region}.amazonaws.com",
        }
        payload = json.dumps({
            "TimePeriod": {"Start": since.strftime("%Y-%m-%d"), "End": until.strftime("%Y-%m-%d")},
            "Granularity": "DAILY",
            "Metrics": ["UnblendedCost"],
            "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}],
        })

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await self._fetch_ce(client, endpoint, headers, payload)
            resp.raise_for_status()
            data = resp.json()

            for result in data.get("ResultsByTime", []):
                period_start = datetime.fromisoformat(result["TimePeriod"]["Start"])
                for group in result.get("Groups", []):
                    service = group["Keys"][0]
                    amount = float(group["Metrics"]["UnblendedCost"]["Amount"])
                    cost_cents = round(amount * 100)
                    if cost_cents == 0:
                        continue
                    records.append(UsageRecord(
                        provider="aws",
                        model=service,
                        input_tokens=None,
                        output_tokens=None,
                        total_cost_cents_usd=cost_cents,
                        currency="USD",
                        ts=period_start,
                        raw=group,
                    ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_ce(client: httpx.AsyncClient, endpoint: str, headers: dict, payload: str) -> httpx.Response:
        return await client.post(endpoint, headers=headers, content=payload)
