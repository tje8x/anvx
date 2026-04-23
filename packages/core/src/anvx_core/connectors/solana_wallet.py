"""Solana wallet connector — reads on-chain tx fees via public RPC."""
import logging
from datetime import datetime, timezone

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import UsageRecord

logger = logging.getLogger(__name__)

_RPC = "https://api.mainnet-beta.solana.com"
_COINGECKO = "https://api.coingecko.com/api/v3/simple/price"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


class SolanaWalletConnector:
    provider = "solana_wallet"
    kind = "address"

    async def validate(self, address: str) -> None:
        address = address.strip()
        if len(address) < 32 or len(address) > 44:
            raise PermissionError("Invalid Solana address: must be 32-44 characters (base58)")
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(_RPC, json={"jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [address]})
            resp.raise_for_status()
            data = resp.json()
            if "error" in data:
                raise PermissionError(f"Invalid Solana address: {data['error'].get('message', 'unknown error')}")

    async def fetch_usage(self, address: str, since: datetime, until: datetime) -> list[UsageRecord]:
        address = address.strip()
        records: list[UsageRecord] = []

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get SOL/USD price
            price_resp = await client.get(_COINGECKO, params={"ids": "solana", "vs_currencies": "usd"})
            price_resp.raise_for_status()
            sol_usd = float(price_resp.json().get("solana", {}).get("usd", 0))
            if sol_usd == 0:
                return []

            # Get recent signatures
            sig_resp = await self._fetch_signatures(client, address)
            sig_resp.raise_for_status()
            sigs = sig_resp.json().get("result", [])

            for sig in sigs:
                if sig.get("err") is not None:
                    continue
                block_time = sig.get("blockTime")
                if block_time is None:
                    continue
                ts = datetime.fromtimestamp(block_time, tz=timezone.utc)
                if ts < since or ts > until:
                    continue
                # Solana base fee is 5000 lamports per signature
                fee_lamports = 5000
                fee_sol = fee_lamports / 1e9
                cost_usd = fee_sol * sol_usd
                cost_cents = round(cost_usd * 100)
                if cost_cents == 0:
                    cost_cents = 1  # minimum 1 cent for tracking
                records.append(UsageRecord(
                    provider="solana_wallet", model="tx_fee", input_tokens=None, output_tokens=None,
                    total_cost_cents_usd=cost_cents, currency="USD", ts=ts,
                    raw={"signature": sig.get("signature", ""), "fee_lamports": fee_lamports},
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_signatures(client: httpx.AsyncClient, address: str) -> httpx.Response:
        return await client.post(_RPC, json={"jsonrpc": "2.0", "id": 1, "method": "getSignaturesForAddress", "params": [address, {"limit": 1000}]})
