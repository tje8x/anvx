"""GCP v2 connector — fetches daily costs via Cloud Billing API."""
import json
import logging
from datetime import datetime

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_BILLING_API = "https://cloudbilling.googleapis.com/v1"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class GCPConnector:
    provider = "gcp"

    async def validate(self, api_key: str) -> None:
        """api_key is service account JSON string. Exchange for access token and list billing accounts."""
        try:
            sa = json.loads(api_key)
        except (json.JSONDecodeError, TypeError):
            raise PermissionError("Invalid GCP service account JSON")

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Exchange for access token
            token_resp = await client.post(
                "https://accounts.google.com/o/token",
                data={"grant_type": "urn:ietf:params:grant-type:jwt-bearer", "assertion": _build_jwt_assertion(sa)},
            )
            if token_resp.status_code in (401, 403):
                raise PermissionError("Invalid GCP service account credentials")
            token_resp.raise_for_status()
            access_token = token_resp.json()["access_token"]

            # Validate by listing billing accounts
            resp = await client.get(f"{_BILLING_API}/billingAccounts", headers={"Authorization": f"Bearer {access_token}"})
            if resp.status_code in (401, 403):
                raise PermissionError("GCP billing access denied")
            resp.raise_for_status()
            accounts = resp.json().get("billingAccounts", [])
            if not accounts:
                raise PermissionError("No GCP billing accounts found")

    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]:
        sa = json.loads(api_key)
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get access token
            token_resp = await client.post(
                "https://accounts.google.com/o/token",
                data={"grant_type": "urn:ietf:params:grant-type:jwt-bearer", "assertion": _build_jwt_assertion(sa)},
            )
            token_resp.raise_for_status()
            access_token = token_resp.json()["access_token"]

            # Get billing account
            acct_resp = await client.get(f"{_BILLING_API}/billingAccounts", headers={"Authorization": f"Bearer {access_token}"})
            acct_resp.raise_for_status()
            accounts = acct_resp.json().get("billingAccounts", [])
            if not accounts:
                return []
            billing_account = accounts[0]["name"]

            # Fetch costs
            resp = await self._fetch_costs(client, access_token, billing_account, since, until)
            resp.raise_for_status()
            data = resp.json()

            for entry in data.get("costs", []):
                entry_date = datetime.fromisoformat(entry["date"])
                service = entry.get("service", "Unknown")
                amount = float(entry.get("amount", 0))
                cost_cents = round(amount * 100)
                if cost_cents == 0:
                    continue
                records.append(UsageRecord(
                    provider="gcp",
                    model=service,
                    input_tokens=None,
                    output_tokens=None,
                    total_cost_cents_usd=cost_cents,
                    currency="USD",
                    ts=entry_date,
                    raw=entry,
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_costs(client: httpx.AsyncClient, access_token: str, billing_account: str, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(
            f"{_BILLING_API}/{billing_account}/costs",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"startDate": since.strftime("%Y-%m-%d"), "endDate": until.strftime("%Y-%m-%d"), "groupBy": "service"},
        )


def _build_jwt_assertion(sa: dict) -> str:
    """Build a minimal JWT assertion for GCP service account auth. Ported from v1."""
    import time
    import base64
    import hashlib
    import hmac

    header = base64.urlsafe_b64encode(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()).rstrip(b"=").decode()
    now = int(time.time())
    claims = {
        "iss": sa.get("client_email", ""),
        "scope": "https://www.googleapis.com/auth/cloud-billing.readonly",
        "aud": "https://accounts.google.com/o/token",
        "iat": now,
        "exp": now + 3600,
    }
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"{header}.{payload}.placeholder"
