"""Base chain (L2) wallet connector — reads on-chain tx gas costs via Basescan."""
import logging
from datetime import datetime, timezone

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_RPC = "https://mainnet.base.org"
_BASESCAN = "https://api.basescan.org/api"
_COINGECKO = "https://api.coingecko.com/api/v3/simple/price"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class BaseWalletConnector:
    provider = "base_wallet"
    kind = "address"

    async def validate(self, address: str) -> None:
        address = address.strip()
        if not address.startswith("0x") or len(address) != 42:
            raise PermissionError("Invalid Base address: must start with 0x and be 42 characters")
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(_RPC, json={"jsonrpc": "2.0", "method": "eth_getBalance", "params": [address, "latest"], "id": 1})
            resp.raise_for_status()
            data = resp.json()
            if "error" in data:
                raise PermissionError(f"Invalid Base address: {data['error'].get('message', 'unknown error')}")

    async def fetch_usage(self, address: str, since: datetime, until: datetime) -> list[UsageRecord]:
        address = address.strip()
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # ETH price (Base uses ETH for gas)
            price_resp = await client.get(_COINGECKO, params={"ids": "ethereum", "vs_currencies": "usd"})
            price_resp.raise_for_status()
            eth_usd = float(price_resp.json().get("ethereum", {}).get("usd", 0))
            if eth_usd == 0:
                return []

            tx_resp = await self._fetch_txs(client, address)
            tx_resp.raise_for_status()
            data = tx_resp.json()

            for tx in data.get("result", []):
                if not isinstance(tx, dict):
                    continue
                if tx.get("isError") == "1":
                    continue
                ts = datetime.fromtimestamp(int(tx.get("timeStamp", 0)), tz=timezone.utc)
                if ts < since or ts > until:
                    continue
                gas_used = int(tx.get("gasUsed", 0))
                gas_price = int(tx.get("gasPrice", 0))
                gas_cost_eth = gas_used * gas_price / 1e18
                cost_usd = gas_cost_eth * eth_usd
                cost_cents = round(cost_usd * 100)
                if cost_cents == 0:
                    continue
                records.append(UsageRecord(
                    provider="base_wallet", model="gas", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=cost_cents, currency="USD", ts=ts,
                    raw={"tx_hash": tx.get("hash", ""), "gas_used": gas_used, "gas_price_gwei": gas_price / 1e9},
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_txs(client: httpx.AsyncClient, address: str) -> httpx.Response:
        return await client.get(_BASESCAN, params={"module": "account", "action": "txlist", "address": address, "startblock": 0, "endblock": 99999999, "sort": "desc", "page": 1, "offset": 1000})
