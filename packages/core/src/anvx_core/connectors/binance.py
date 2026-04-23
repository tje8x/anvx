"""Binance v2 connector — read-only exchange trade history."""
import hashlib
import hmac
import logging
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
from tenacity import retry, retry_if_result, stop_after_attempt, wait_exponential

from .base import TransactionRecord

logger = logging.getLogger(__name__)

_API = "https://api.binance.com"


def _is_retryable(resp: httpx.Response) -> bool:
    return resp.status_code == 429 or resp.status_code >= 500


def _sign(query: str, secret: str) -> str:
    return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()


class BinanceConnector:
    provider = "binance"
    kind = "api_key"

    async def validate(self, api_key: str) -> None:
        """api_key is JSON: {"api_key": ..., "api_secret": ...}"""
        import json
        creds = json.loads(api_key)
        key = creds.get("api_key", "")
        secret = creds.get("api_secret", "")
        if not key or not secret:
            raise PermissionError("Missing api_key or api_secret")

        timestamp = int(time.time() * 1000)
        query = f"timestamp={timestamp}"
        signature = _sign(query, secret)

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{_API}/api/v3/account", params={"timestamp": timestamp, "signature": signature}, headers={"X-MBX-APIKEY": key})
            if resp.status_code == 401:
                raise PermissionError("Invalid Binance API key")
            resp.raise_for_status()
            data = resp.json()
            permissions = data.get("permissions", [])
            can_trade = data.get("canTrade", False)
            if can_trade:
                raise PermissionError("Binance keys must be READ-ONLY. Regenerate with Trading disabled.")

    async def fetch_transactions(self, api_key: str, since: datetime, until: datetime) -> list[TransactionRecord]:
        import json
        creds = json.loads(api_key)
        key = creds["api_key"]
        secret = creds["api_secret"]
        records: list[TransactionRecord] = []

        timestamp = int(time.time() * 1000)
        start_ms = int(since.timestamp() * 1000)
        end_ms = int(until.timestamp() * 1000)
        query = urlencode({"timestamp": timestamp, "startTime": start_ms, "endTime": end_ms, "limit": 1000})
        signature = _sign(query, secret)

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await self._fetch_trades(client, key, f"{query}&signature={signature}")
            resp.raise_for_status()
            trades = resp.json()

            for trade in trades:
                ts = datetime.fromtimestamp(trade.get("time", 0) / 1000, tz=timezone.utc)
                qty = float(trade.get("qty", 0))
                price = float(trade.get("price", 0))
                amount_usd = qty * price
                amount_cents = round(amount_usd * 100)
                is_buyer = trade.get("isBuyer", False)

                records.append(TransactionRecord(
                    provider="binance", direction="out" if is_buyer else "in",
                    counterparty=trade.get("symbol"), amount_cents=amount_cents,
                    currency="USD", ts=ts, category_hint="crypto_trade", raw=trade,
                ))

        return records

    @staticmethod
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10), retry=retry_if_result(_is_retryable))
    async def _fetch_trades(client: httpx.AsyncClient, key: str, signed_query: str) -> httpx.Response:
        return await client.get(f"{_API}/api/v3/myTrades?{signed_query}", headers={"X-MBX-APIKEY": key})
