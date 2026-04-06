"""Anthropic billing connector — fetches token usage and costs from Anthropic Admin API."""
import logging
import random
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import httpx

from engine.connectors.base_connector import BaseConnector
from engine.models import FinancialRecord, Provider, SpendCategory

logger = logging.getLogger(__name__)

# Model pricing (per 1M tokens, approximate as of early 2026)
_MODEL_PRICING: dict[str, dict[str, Decimal]] = {
    "claude-sonnet": {"input": Decimal("3.00"), "output": Decimal("15.00")},
    "claude-haiku": {"input": Decimal("0.25"), "output": Decimal("1.25")},
}

_ANTHROPIC_API_BASE = "https://api.anthropic.com"


class AnthropicBillingConnector(BaseConnector):
    """Connector for Anthropic billing / usage data."""

    provider = Provider.ANTHROPIC

    def __init__(self) -> None:
        self.is_connected: bool = False
        self._api_key: str = ""
        self._client: httpx.AsyncClient | None = None

    async def connect(self, credentials: dict[str, Any]) -> bool:
        # ── Onboarding test mode ───────────────────────────────
        from engine.utils import is_onboarding_test_mode
        if is_onboarding_test_mode():
            if self.validate_test_credentials(credentials):
                import asyncio
                print("Connecting to Anthropic...")
                await asyncio.sleep(1)
                print("Authenticated with Anthropic API (test mode)")
                self._client = httpx.AsyncClient()
                self.is_connected = True
                return True
            logger.error("Authentication failed")
            return False

        # ── Normal mode ────────────────────────────────────────
        api_key = credentials.get("api_key", "")
        if not api_key:
            logger.error("Missing Anthropic API key")
            return False

        self._api_key = api_key
        self._client = httpx.AsyncClient(
            base_url=_ANTHROPIC_API_BASE,
            headers={
                "x-api-key": self._api_key,
                "anthropic-version": "2023-06-01",
            },
            timeout=30.0,
        )

        try:
            # Lightweight validation — list models
            resp = await self._client.get("/v1/models", params={"limit": 1})
            resp.raise_for_status()
            self.is_connected = True
            return True
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 401:
                logger.error("Anthropic API key is invalid or expired")
            else:
                logger.error("Anthropic validation failed: HTTP %s", exc.response.status_code)
            return False
        except httpx.TimeoutException:
            logger.error("Anthropic connection timed out")
            return False
        except httpx.HTTPError as exc:
            logger.error("Anthropic connection error: %s", exc)
            return False

    async def fetch_records(
        self, start_date: date, end_date: date
    ) -> list[FinancialRecord]:
        if not self.is_connected or self._client is None:
            logger.error("Not connected — call connect() first")
            return []

        from engine.utils import is_onboarding_test_mode
        if is_onboarding_test_mode():
            return self.get_synthetic_records(start_date, end_date)

        records: list[FinancialRecord] = []

        try:
            # Anthropic Admin API usage endpoint
            resp = await self._client.get(
                "/v1/organization/usage",
                params={
                    "start_date": start_date.isoformat(),
                    "end_date": end_date.isoformat(),
                    "group_by": "model",
                },
            )
            resp.raise_for_status()
            data = resp.json()

            for bucket in data.get("data", []):
                bucket_date = date.fromisoformat(bucket["date"])
                for result in bucket.get("results", []):
                    model = result.get("model", "unknown")
                    input_tokens = result.get("input_tokens", 0)
                    output_tokens = result.get("output_tokens", 0)

                    cost_usd = Decimal(str(result.get("cost_in_usd", 0)))
                    if cost_usd == 0 and model in _MODEL_PRICING:
                        pricing = _MODEL_PRICING[model]
                        cost_usd = (
                            pricing["input"] * Decimal(input_tokens) / Decimal("1000000")
                            + pricing["output"] * Decimal(output_tokens) / Decimal("1000000")
                        )

                    records.append(
                        FinancialRecord(
                            record_date=bucket_date,
                            amount=-cost_usd.quantize(Decimal("0.01")),
                            category=SpendCategory.AI_INFERENCE,
                            provider=Provider.ANTHROPIC,
                            model=model,
                            tokens_input=input_tokens,
                            tokens_output=output_tokens,
                            source="anthropic_admin_api",
                            raw_description=f"Anthropic {model} usage",
                        )
                    )

        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429:
                logger.warning("Anthropic rate limit hit — returning partial results")
            else:
                logger.error("Anthropic usage fetch failed: HTTP %s", exc.response.status_code)
        except httpx.TimeoutException:
            logger.error("Anthropic usage fetch timed out — returning partial results")
        except httpx.HTTPError as exc:
            logger.error("Anthropic usage fetch error: %s", exc)

        return records

    async def get_summary(self) -> dict:
        today = date.today()
        month_start = today.replace(day=1)
        records = await self.fetch_records(month_start, today)
        total = sum(r.amount for r in records)
        by_model: dict[str, Decimal] = {}
        for r in records:
            by_model[r.model or "unknown"] = by_model.get(r.model or "unknown", Decimal("0")) + r.amount
        return {
            "provider": self.provider.value,
            "connected": self.is_connected,
            "current_month_spend": str(total),
            "spend_by_model": {k: str(v) for k, v in by_model.items()},
        }

    # ── Synthetic data ──────────────────────────────────────────

    def get_synthetic_records(
        self, start_date: date, end_date: date
    ) -> list[FinancialRecord]:
        """Generate realistic Anthropic billing data.

        Profile: ~$250/month total, growing ~6%/month
          - claude-sonnet: ~$180/month (low variance input tokens — triggers caching estimator)
          - claude-haiku: ~$70/month
        Per-request records with consistent input sizes (simulates system prompt reuse).
        """
        rng = random.Random(99)
        monthly_growth = 1.06  # 6% month-over-month growth

        records: list[FinancialRecord] = []
        current = start_date
        while current <= end_date:
            is_weekend = current.weekday() >= 5
            weekend_factor = 0.6 if is_weekend else 1.0
            months_elapsed = (current - start_date).days / 30.0
            growth = Decimal(str(round(monthly_growth ** months_elapsed, 4)))

            # ── claude-sonnet: per-request with LOW variance input ──
            # Simulates a system prompt (~1800 tokens) + small user query
            # CV target < 0.3 → input tokens very consistent
            sonnet_daily_budget = 180.0 / 30 * weekend_factor
            n_sonnet_requests = 3
            for _ in range(n_sonnet_requests):
                req_budget = sonnet_daily_budget / n_sonnet_requests * rng.uniform(0.85, 1.15)
                cost_dec = (Decimal(str(round(req_budget, 4))) * growth).quantize(Decimal("0.01"))

                # Low variance: base 1800 ±5% (CV ≈ 0.03)
                input_tokens = int(1800 * rng.uniform(0.95, 1.05))
                output_tokens = rng.randint(200, 600)

                records.append(
                    FinancialRecord(
                        record_date=current,
                        amount=-cost_dec,
                        category=SpendCategory.AI_INFERENCE,
                        provider=Provider.ANTHROPIC,
                        model="claude-sonnet",
                        tokens_input=input_tokens,
                        tokens_output=output_tokens,
                        source="synthetic",
                        raw_description="Synthetic Anthropic claude-sonnet request",
                    )
                )

            # ── claude-haiku: daily aggregate ──────────────────────
            haiku_cost = 70.0 / 30 * weekend_factor * rng.uniform(0.8, 1.2)
            haiku_dec = (Decimal(str(round(haiku_cost, 2))) * growth).quantize(Decimal("0.01"))
            pricing = _MODEL_PRICING["claude-haiku"]
            input_cost = haiku_dec * Decimal("0.4")
            output_cost = haiku_dec * Decimal("0.6")
            haiku_input = int(input_cost / pricing["input"] * 1_000_000) if pricing["input"] else 0
            haiku_output = int(output_cost / pricing["output"] * 1_000_000) if pricing["output"] else 0

            records.append(
                FinancialRecord(
                    record_date=current,
                    amount=-haiku_dec,
                    category=SpendCategory.AI_INFERENCE,
                    provider=Provider.ANTHROPIC,
                    model="claude-haiku",
                    tokens_input=haiku_input,
                    tokens_output=haiku_output,
                    source="synthetic",
                    raw_description="Synthetic Anthropic claude-haiku usage",
                )
            )

            current += timedelta(days=1)

        return records
