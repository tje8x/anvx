"""Coinbase v2 connector — read-only exchange transaction history."""
import logging
from datetime import datetime, timezone

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import TransactionRecord

logger = logging.getLogger(__name__)

_API = "https://api.coinbase.com/v2"

_WRITE_SCOPES = {"wallet:transactions:write", "wallet:transactions:send", "wallet:buys:create", "wallet:sells:create", "wallet:trades:create"}


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class CoinbaseConnector:
    provider = "coinbase"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/user", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Coinbase API key")
            if resp.status_code == 403:
                raise PermissionError("Coinbase API key has insufficient scope")
            resp.raise_for_status()
            scopes = set(resp.headers.get("X-CoinbaseApiScopes", "").replace(" ", "").split(","))
            dangerous = scopes & _WRITE_SCOPES
            if dangerous:
                raise PermissionError("Coinbase keys must be READ-ONLY. Create a new key under API Settings with only the 'wallet:transactions:read' scope.")

    async def fetch_transactions(self, api_key: str, since: datetime, until: datetime) -> list[TransactionRecord]:
        headers = {"Authorization": f"Bearer {api_key}"}
        records: list[TransactionRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # List accounts
            acct_resp = await client.get(f"{_API}/accounts", headers=headers)
            acct_resp.raise_for_status()
            accounts = acct_resp.json().get("data", [])

            for acct in accounts:
                acct_id = acct.get("id", "")
                if not acct_id:
                    continue
                tx_resp = await self._fetch_txs(client, headers, acct_id)
                tx_resp.raise_for_status()
                txs = tx_resp.json().get("data", [])

                for tx in txs:
                    created = tx.get("created_at", "")
                    try:
                        ts = datetime.fromisoformat(created.replace("Z", "+00:00"))
                    except (ValueError, AttributeError):
                        continue
                    if ts < since or ts > until:
                        continue
                    tx_type = tx.get("type", "")
                    amount = abs(float(tx.get("native_amount", {}).get("amount", 0)))
                    amount_cents = round(amount * 100)
                    currency = tx.get("native_amount", {}).get("currency", "USD")

                    if tx_type in ("buy", "fiat_deposit"):
                        direction = "out"
                        category = "crypto_purchase"
                    elif tx_type in ("sell", "fiat_withdrawal"):
                        direction = "in"
                        category = "crypto_sale"
                    elif tx_type == "send":
                        direction = "out"
                        category = "crypto_transfer"
                    elif tx_type == "receive":
                        direction = "in"
                        category = "crypto_transfer"
                    else:
                        direction = "out"
                        category = tx_type

                    records.append(TransactionRecord(
                        provider="coinbase", direction=direction, counterparty=tx.get("description"),
                        amount_cents=amount_cents, currency=currency, ts=ts, category_hint=category, raw=tx,
                    ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_txs(client: httpx.AsyncClient, headers: dict, acct_id: str) -> httpx.Response:
        return await client.get(f"{_API}/accounts/{acct_id}/transactions", headers=headers)
