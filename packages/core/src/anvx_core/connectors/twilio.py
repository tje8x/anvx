"""Twilio v2 connector — fetches daily SMS/voice usage costs."""
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_API = "https://api.twilio.com/2010-04-01"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class TwilioConnector:
    provider = "twilio"

    async def validate(self, api_key: str) -> None:
        """api_key is JSON: {"account_sid": ..., "auth_token": ...}"""
        import json
        creds = json.loads(api_key)
        sid = creds.get("account_sid", "")
        token = creds.get("auth_token", "")
        if not sid or not token:
            raise PermissionError("Missing account_sid or auth_token")
        async with httpx.AsyncClient(timeout=15.0, auth=(sid, token)) as client:
            resp = await client.get(f"{_API}/Accounts/{sid}.json")
            if resp.status_code == 401:
                raise PermissionError("Invalid Twilio credentials")
            resp.raise_for_status()

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        import json
        creds = json.loads(api_key)
        sid = creds["account_sid"]
        token = creds["auth_token"]
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0, auth=(sid, token)) as client:
            resp = await self._fetch(client, sid, since, until)
            resp.raise_for_status()
            data = resp.json()

            for rec in data.get("usage_records", []):
                price = float(rec.get("price", "0"))
                cost_cents = round(abs(price) * 100)
                if cost_cents == 0:
                    continue
                records.append(UsageRecord(
                    provider="twilio", model=rec.get("category", "unknown"), input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=cost_cents, currency="USD",
                    ts=datetime.fromisoformat(rec["start_date"]), raw=rec,
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch(client: httpx.AsyncClient, sid: str, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(f"{_API}/Accounts/{sid}/Usage/Records/Daily.json", params={"StartDate": since.strftime("%Y-%m-%d"), "EndDate": until.strftime("%Y-%m-%d")})
