"""Stripe v2 connector — fetches balance transactions as revenue data."""
import logging
from datetime import datetime, timezone

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import TransactionRecord

logger = logging.getLogger(__name__)

_API = "https://api.stripe.com/v1"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class StripeConnector:
    provider = "stripe"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/account", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Stripe API key")
            resp.raise_for_status()

    async def fetch_transactions(self, api_key: str, since: datetime, until: datetime) -> list[TransactionRecord]:
        headers = {"Authorization": f"Bearer {api_key}"}
        records: list[TransactionRecord] = []
        starting_after: str | None = None

        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                params: dict = {
                    "created[gte]": int(since.timestamp()),
                    "created[lte]": int(until.timestamp()),
                    "limit": 100,
                }
                if starting_after:
                    params["starting_after"] = starting_after

                resp = await self._fetch_page(client, headers, params)
                resp.raise_for_status()
                data = resp.json()

                for txn in data.get("data", []):
                    record = self._classify(txn)
                    if record:
                        records.append(record)

                if not data.get("has_more", False):
                    break
                items = data.get("data", [])
                if not items:
                    break
                starting_after = items[-1]["id"]

        return records

    def _classify(self, txn: dict) -> TransactionRecord | None:
        txn_type = txn.get("type", "")
        amount = txn.get("amount", 0)
        currency = txn.get("currency", "usd").upper()
        ts = datetime.fromtimestamp(txn.get("created", 0), tz=timezone.utc)
        description = txn.get("description") or ""

        if txn_type == "charge" and amount > 0:
            return TransactionRecord(provider="stripe", direction="in", counterparty=description or None, amount_cents=amount, currency=currency, ts=ts, category_hint="revenue", raw=txn)

        if txn_type == "refund":
            return TransactionRecord(provider="stripe", direction="out", counterparty=description or None, amount_cents=abs(amount), currency=currency, ts=ts, category_hint="refund", raw=txn)

        if txn_type == "payout":
            return TransactionRecord(provider="stripe", direction="out", counterparty="payout", amount_cents=abs(amount), currency=currency, ts=ts, category_hint="payout", raw=txn)

        if txn_type in ("stripe_fee", "application_fee"):
            return TransactionRecord(provider="stripe", direction="out", counterparty="stripe_fees", amount_cents=abs(amount), currency=currency, ts=ts, category_hint="fees", raw=txn)

        # Unknown type — skip
        return None

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_page(client: httpx.AsyncClient, headers: dict, params: dict) -> httpx.Response:
        return await client.get(f"{_API}/balance_transactions", headers=headers, params=params)
