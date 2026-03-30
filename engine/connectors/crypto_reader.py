"""READ-ONLY crypto balance reader.

Fetches token balances from public blockchain APIs and exchange read-only
endpoints. This connector has ZERO execution capability — no transfers,
no swaps, no approvals, no signing.
"""
import logging
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import httpx

from engine.connectors.base_connector import BaseConnector
from engine.models import FinancialRecord, Provider, SpendCategory

logger = logging.getLogger(__name__)

_DISCLAIMER = (
    "Crypto balances shown for informational purposes only. This tool does "
    "not execute transactions, provide investment advice, or manage wallets."
)

# Public API endpoints for READ-ONLY balance lookups
_ETHERSCAN_API = "https://api.etherscan.io/api"
_SOLSCAN_API = "https://api.solscan.io"
_COINGECKO_PRICE_API = "https://api.coingecko.com/api/v3/simple/price"

# Coinbase read-only endpoints
_COINBASE_API = "https://api.coinbase.com/v2"

# Approximate USD prices for synthetic mode
_SYNTHETIC_PRICES: dict[str, Decimal] = {
    "ETH": Decimal("2000"),
    "BTC": Decimal("60000"),
    "USDC": Decimal("1.00"),
    "SOL": Decimal("150"),
}


class CryptoReader(BaseConnector):
    """READ-ONLY connector for crypto wallet and exchange balances.

    SECURITY: This class intentionally provides ZERO methods to write,
    transfer, swap, sign, approve, or modify any on-chain or exchange state.
    All API calls are GET requests to public or read-only endpoints.
    """

    provider = Provider.CRYPTO_WALLET

    def __init__(self) -> None:
        self.is_connected: bool = False
        self._wallet_addresses: list[str] = []
        self._exchange: str | None = None
        self._client: httpx.AsyncClient | None = None

    async def connect(self, credentials: dict[str, Any]) -> bool:
        """Connect using wallet addresses or exchange read-only API key.

        Accepts either:
          {"wallet_addresses": ["0x...", "0x..."]}
        or:
          {"exchange": "coinbase", "api_key": "...", "api_secret": "..."}
        """
        wallet_addresses = credentials.get("wallet_addresses", [])
        exchange = credentials.get("exchange")

        if not wallet_addresses and not exchange:
            logger.error("Provide wallet_addresses or exchange credentials")
            return False

        self._client = httpx.AsyncClient(timeout=30.0)

        # ── Wallet mode ─────────────────────────────────────────
        if wallet_addresses:
            if not all(isinstance(a, str) and len(a) > 0 for a in wallet_addresses):
                logger.error("Invalid wallet address format")
                return False
            self._wallet_addresses = list(wallet_addresses)
            self.provider = Provider.CRYPTO_WALLET

            # Validate by checking the first address on Etherscan
            try:
                resp = await self._client.get(
                    _ETHERSCAN_API,
                    params={
                        "module": "account",
                        "action": "balance",
                        "address": self._wallet_addresses[0],
                        "tag": "latest",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                if data.get("status") != "1" and data.get("message") != "OK":
                    logger.error("Etherscan returned error: %s", data.get("message", "unknown"))
                    return False
            except httpx.TimeoutException:
                logger.error("Etherscan connection timed out")
                return False
            except httpx.HTTPError as exc:
                logger.error("Etherscan connection error: %s", exc)
                return False

            self.is_connected = True
            return True

        # ── Exchange mode ───────────────────────────────────────
        if exchange:
            api_key = credentials.get("api_key", "")
            if not api_key:
                logger.error("Missing exchange API key")
                return False

            self._exchange = exchange.lower()
            self.provider = Provider.CRYPTO_EXCHANGE

            if self._exchange == "coinbase":
                try:
                    resp = await self._client.get(
                        f"{_COINBASE_API}/user",
                        headers={"Authorization": f"Bearer {api_key}"},
                    )
                    resp.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 401:
                        logger.error("Coinbase API key is invalid or expired")
                    else:
                        logger.error("Coinbase validation failed: HTTP %s", exc.response.status_code)
                    return False
                except httpx.TimeoutException:
                    logger.error("Coinbase connection timed out")
                    return False
                except httpx.HTTPError as exc:
                    logger.error("Coinbase connection error: %s", exc)
                    return False
            else:
                logger.error("Unsupported exchange: %s", exchange)
                return False

            self.is_connected = True
            return True

        return False

    async def fetch_records(
        self, start_date: date, end_date: date
    ) -> list[FinancialRecord]:
        """Fetch current balances as holdings records (READ-ONLY).

        Note: Crypto balances are point-in-time snapshots, not historical.
        Records are dated as of end_date.
        """
        if not self.is_connected or self._client is None:
            logger.error("Not connected — call connect() first")
            return []

        records: list[FinancialRecord] = []

        # ── Wallet mode: public blockchain APIs ─────────────────
        if self._wallet_addresses:
            records.extend(await self._fetch_wallet_balances(end_date))

        # ── Exchange mode: read-only account balances ───────────
        if self._exchange:
            records.extend(await self._fetch_exchange_balances(end_date))

        return records

    async def get_summary(self) -> dict:
        today = date.today()
        records = await self.fetch_records(today, today)
        total_usd = sum(r.amount for r in records)
        by_asset: dict[str, str] = {}
        for r in records:
            label = r.subcategory or "unknown"
            by_asset[label] = str(r.amount)
        return {
            "provider": self.provider.value,
            "connected": self.is_connected,
            "total_holdings_usd": str(total_usd),
            "by_asset": by_asset,
            "disclaimer": _DISCLAIMER,
        }

    # ── Synthetic data ──────────────────────────────────────────

    def get_synthetic_records(
        self, start_date: date, end_date: date
    ) -> list[FinancialRecord]:
        """Generate synthetic crypto holdings.

        Portfolio: 2.5 ETH (~$5,000), 1,500 USDC ($1,500), 0.1 BTC (~$6,000)
        Holdings are point-in-time snapshots dated at end_date.

        Disclaimer: {disclaimer}
        """.format(disclaimer=_DISCLAIMER)
        holdings = [
            ("ETH", Decimal("2.5"), _SYNTHETIC_PRICES["ETH"]),
            ("USDC", Decimal("1500"), _SYNTHETIC_PRICES["USDC"]),
            ("BTC", Decimal("0.1"), _SYNTHETIC_PRICES["BTC"]),
        ]

        records: list[FinancialRecord] = []
        for token, quantity, price_usd in holdings:
            value_usd = (quantity * price_usd).quantize(Decimal("0.01"))
            records.append(
                FinancialRecord(
                    record_date=end_date,
                    amount=value_usd,
                    category=SpendCategory.CRYPTO_HOLDINGS,
                    subcategory=token,
                    provider=Provider.CRYPTO_WALLET,
                    source="synthetic",
                    raw_description=(
                        f"Synthetic holding: {quantity} {token} @ ${price_usd}/unit. "
                        f"{_DISCLAIMER}"
                    ),
                )
            )

        return records

    # ── Private helpers (all READ-ONLY) ─────────────────────────

    async def _fetch_wallet_balances(self, as_of: date) -> list[FinancialRecord]:
        """Fetch ETH balance from Etherscan for each wallet address."""
        records: list[FinancialRecord] = []
        assert self._client is not None

        # Fetch current ETH/USD price
        eth_price = await self._get_token_price("ethereum")

        for address in self._wallet_addresses:
            try:
                resp = await self._client.get(
                    _ETHERSCAN_API,
                    params={
                        "module": "account",
                        "action": "balance",
                        "address": address,
                        "tag": "latest",
                    },
                )
                resp.raise_for_status()
                data = resp.json()

                if data.get("status") == "1":
                    # Balance is in wei (1 ETH = 10^18 wei)
                    wei = Decimal(data["result"])
                    eth_balance = wei / Decimal("1000000000000000000")
                    usd_value = (eth_balance * eth_price).quantize(Decimal("0.01"))

                    records.append(
                        FinancialRecord(
                            record_date=as_of,
                            amount=usd_value,
                            category=SpendCategory.CRYPTO_HOLDINGS,
                            subcategory="ETH",
                            provider=Provider.CRYPTO_WALLET,
                            source="etherscan",
                            raw_description=(
                                f"{eth_balance} ETH in {address[:10]}... "
                                f"{_DISCLAIMER}"
                            ),
                        )
                    )

            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 429:
                    logger.warning("Etherscan rate limit — skipping %s", address[:10])
                else:
                    logger.error("Etherscan fetch failed for %s: HTTP %s", address[:10], exc.response.status_code)
            except httpx.TimeoutException:
                logger.error("Etherscan fetch timed out for %s", address[:10])
            except httpx.HTTPError as exc:
                logger.error("Etherscan fetch error for %s: %s", address[:10], exc)

        return records

    async def _fetch_exchange_balances(self, as_of: date) -> list[FinancialRecord]:
        """Fetch account balances from exchange (READ-ONLY)."""
        records: list[FinancialRecord] = []
        assert self._client is not None

        if self._exchange != "coinbase":
            return records

        try:
            resp = await self._client.get(f"{_COINBASE_API}/accounts")
            resp.raise_for_status()
            data = resp.json()

            for account in data.get("data", []):
                balance = Decimal(account.get("balance", {}).get("amount", "0"))
                currency = account.get("balance", {}).get("currency", "")
                if balance <= 0 or not currency:
                    continue

                native_amount = Decimal(
                    account.get("native_balance", {}).get("amount", "0")
                )
                usd_value = native_amount.quantize(Decimal("0.01"))

                records.append(
                    FinancialRecord(
                        record_date=as_of,
                        amount=usd_value,
                        category=SpendCategory.CRYPTO_HOLDINGS,
                        subcategory=currency,
                        provider=Provider.CRYPTO_EXCHANGE,
                        source="coinbase",
                        raw_description=(
                            f"{balance} {currency} on Coinbase. "
                            f"{_DISCLAIMER}"
                        ),
                    )
                )

        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429:
                logger.warning("Coinbase rate limit hit")
            else:
                logger.error("Coinbase fetch failed: HTTP %s", exc.response.status_code)
        except httpx.TimeoutException:
            logger.error("Coinbase fetch timed out")
        except httpx.HTTPError as exc:
            logger.error("Coinbase fetch error: %s", exc)

        return records

    async def _get_token_price(self, coingecko_id: str) -> Decimal:
        """Fetch current USD price from CoinGecko (public, no key needed)."""
        assert self._client is not None
        try:
            resp = await self._client.get(
                _COINGECKO_PRICE_API,
                params={"ids": coingecko_id, "vs_currencies": "usd"},
            )
            resp.raise_for_status()
            data = resp.json()
            return Decimal(str(data.get(coingecko_id, {}).get("usd", 0)))
        except (httpx.HTTPError, KeyError, ValueError):
            logger.warning("Price fetch failed for %s — using fallback", coingecko_id)
            # Fallback to synthetic prices
            fallback_map = {"ethereum": "ETH", "bitcoin": "BTC", "solana": "SOL"}
            token = fallback_map.get(coingecko_id, "")
            return _SYNTHETIC_PRICES.get(token, Decimal("0"))
