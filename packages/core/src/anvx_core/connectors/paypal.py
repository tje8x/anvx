"""PayPal v2 connector — OAuth client_credentials flow, fetches transactions."""
import logging
from datetime import datetime, timezone

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import TransactionRecord

logger = logging.getLogger(__name__)

_AUTH_URL = "https://api-m.paypal.com/v1/oauth2/token"
_API = "https://api-m.paypal.com/v1"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


def _parse_creds(api_key: str) -> tuple[str, str]:
    """api_key format: 'client_id:client_secret'"""
    if ":" not in api_key:
        raise PermissionError("PayPal credentials must be in 'client_id:client_secret' format")
    client_id, client_secret = api_key.split(":", 1)
    return client_id.strip(), client_secret.strip()


class PayPalConnector:
    provider = "paypal"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        client_id, client_secret = _parse_creds(api_key)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(_AUTH_URL, auth=(client_id, client_secret), data={"grant_type": "client_credentials"})
            if resp.status_code == 401:
                raise PermissionError("Invalid PayPal client credentials")
            resp.raise_for_status()

    async def fetch_transactions(self, api_key: str, since: datetime, until: datetime) -> list[TransactionRecord]:
        client_id, client_secret = _parse_creds(api_key)
        records: list[TransactionRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get access token
            token_resp = await client.post(_AUTH_URL, auth=(client_id, client_secret), data={"grant_type": "client_credentials"})
            token_resp.raise_for_status()
            access_token = token_resp.json()["access_token"]
            headers = {"Authorization": f"Bearer {access_token}"}

            # Fetch transactions
            resp = await self._fetch_txs(client, headers, since, until)
            resp.raise_for_status()
            data = resp.json()

            for tx in data.get("transaction_details", []):
                info = tx.get("transaction_info", {})
                ts_str = info.get("transaction_updated_date", "")
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    continue
                if ts < since or ts > until:
                    continue
                amount_val = float(info.get("transaction_amount", {}).get("value", 0))
                currency = info.get("transaction_amount", {}).get("currency_code", "USD")
                amount_cents = round(abs(amount_val) * 100)
                direction = "in" if amount_val > 0 else "out"
                payer = tx.get("payer_info", {}).get("payer_name", {}).get("alternate_full_name")

                records.append(TransactionRecord(
                    provider="paypal", direction=direction, counterparty=payer,
                    amount_cents=amount_cents, currency=currency, ts=ts,
                    category_hint="payment", raw=tx,
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_txs(client: httpx.AsyncClient, headers: dict, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(f"{_API}/reporting/transactions", headers=headers, params={"start_date": since.strftime("%Y-%m-%dT%H:%M:%SZ"), "end_date": until.strftime("%Y-%m-%dT%H:%M:%SZ"), "fields": "all"})
