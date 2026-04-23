"""Wise v2 connector — fetches transfer history as transactions."""
import logging
from datetime import datetime, timezone

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import TransactionRecord

logger = logging.getLogger(__name__)

_API = "https://api.wise.com"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class WiseConnector:
    provider = "wise"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/v1/profiles", headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 401:
                raise PermissionError("Invalid Wise API token")
            resp.raise_for_status()

    async def fetch_transactions(self, api_key: str, since: datetime, until: datetime) -> list[TransactionRecord]:
        headers = {"Authorization": f"Bearer {api_key}"}
        records: list[TransactionRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get profile ID
            prof_resp = await client.get(f"{_API}/v1/profiles", headers=headers)
            prof_resp.raise_for_status()
            profiles = prof_resp.json()
            if not profiles:
                return []
            profile_id = profiles[0].get("id", "")

            # Get transfers
            resp = await self._fetch_transfers(client, headers, profile_id, since, until)
            resp.raise_for_status()
            transfers = resp.json()

            for tx in transfers:
                created = tx.get("created", "")
                try:
                    ts = datetime.fromisoformat(created.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    continue
                if ts < since or ts > until:
                    continue
                source_amount = float(tx.get("sourceValue", 0) or tx.get("source_value", 0))
                amount_cents = round(abs(source_amount) * 100)
                source_currency = tx.get("sourceCurrency", "USD") or tx.get("source_currency", "USD")
                target_name = tx.get("targetAccount", {}).get("name") or tx.get("target_account", {}).get("name")

                records.append(TransactionRecord(
                    provider="wise", direction="out", counterparty=target_name,
                    amount_cents=amount_cents, currency=source_currency, ts=ts,
                    category_hint="transfer", raw=tx,
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_transfers(client: httpx.AsyncClient, headers: dict, profile_id: str, since: datetime, until: datetime) -> httpx.Response:
        return await client.get(f"{_API}/v1/transfers", headers=headers, params={"profile": profile_id, "createdDateStart": since.isoformat(), "createdDateEnd": until.isoformat(), "limit": 100})
