"""OpenAI billing connector — fetches token usage and costs from OpenAI API."""
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
    "gpt-4o": {"input": Decimal("2.50"), "output": Decimal("10.00")},
    "gpt-4o-mini": {"input": Decimal("0.15"), "output": Decimal("0.60")},
    "text-embedding-3-small": {"input": Decimal("0.02"), "output": Decimal("0")},
}

_OPENAI_API_BASE = "https://api.openai.com/v1"


class OpenAIBillingConnector(BaseConnector):
    """Connector for OpenAI billing / usage data."""

    provider = Provider.OPENAI

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
                print("Connecting to OpenAI...")
                await asyncio.sleep(1)
                print("Authenticated with OpenAI API (test mode)")
                self._client = httpx.AsyncClient()
                self.is_connected = True
                return True
            logger.error("Invalid API key format")
            return False

        # ── Normal mode ────────────────────────────────────────
        api_key = credentials.get("api_key", "")
        if not api_key or not api_key.startswith("sk-"):
            logger.error("Invalid OpenAI API key format")
            return False

        self._api_key = api_key
        self._client = httpx.AsyncClient(
            base_url=_OPENAI_API_BASE,
            headers={"Authorization": f"Bearer {self._api_key}"},
            timeout=30.0,
        )

        try:
            resp = await self._client.get("/models", params={"limit": 1})
            resp.raise_for_status()
            self.is_connected = True
            return True
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 401:
                logger.error("OpenAI API key is invalid or expired")
            else:
                logger.error("OpenAI validation failed: HTTP %s", exc.response.status_code)
            return False
        except httpx.TimeoutException:
            logger.error("OpenAI connection timed out")
            return False
        except httpx.HTTPError as exc:
            logger.error("OpenAI connection error: %s", exc)
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
            # OpenAI usage API returns daily buckets
            resp = await self._client.get(
                "/organization/usage",
                params={
                    "start_date": start_date.isoformat(),
                    "end_date": end_date.isoformat(),
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
                    # Use reported cost if available, otherwise estimate
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
                            provider=Provider.OPENAI,
                            model=model,
                            tokens_input=input_tokens,
                            tokens_output=output_tokens,
                            source="openai_usage_api",
                            raw_description=f"OpenAI {model} usage",
                        )
                    )

        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429:
                logger.warning("OpenAI rate limit hit — returning partial results")
            else:
                logger.error("OpenAI usage fetch failed: HTTP %s", exc.response.status_code)
        except httpx.TimeoutException:
            logger.error("OpenAI usage fetch timed out — returning partial results")
        except httpx.HTTPError as exc:
            logger.error("OpenAI usage fetch error: %s", exc)

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
        """Generate 90-day realistic OpenAI billing data.

        Profile: ~$400/month total, growing ~8%/month
          - gpt-4o: ~$250/month (per-request records, 80% short tasks <500 input tokens)
          - gpt-4o-mini: ~$50/month (daily aggregate)
          - text-embedding-3-small: ~$100/month (daily aggregate)
        Consistent daily volumes (triggers batch detector).
        Growth trend (triggers spend forecast).
        80% short gpt-4o requests (triggers model routing).
        """
        rng = random.Random(42)  # deterministic for reproducibility
        monthly_growth = 1.08  # 8% month-over-month growth

        records: list[FinancialRecord] = []
        current = start_date
        while current <= end_date:
            is_weekend = current.weekday() >= 5
            weekend_factor = 0.6 if is_weekend else 1.0

            # Growth factor based on how many months from start
            months_elapsed = (current - start_date).days / 30.0
            growth = Decimal(str(round(monthly_growth ** months_elapsed, 4)))

            # ── gpt-4o: per-request records (25/day, 80% short) ────
            # 25 requests per day gives enough volume for token-level
            # savings to be meaningful in model routing analysis.
            gpt4o_daily_budget = 250.0 / 30 * weekend_factor
            n_requests = 25
            n_short = 20  # 80% short
            for req_idx in range(n_requests):
                is_short = req_idx < n_short
                req_budget = gpt4o_daily_budget / n_requests * rng.uniform(0.7, 1.3)
                cost_dec = (Decimal(str(round(req_budget, 4))) * growth).quantize(Decimal("0.01"))

                if is_short:
                    # Short task: <500 input tokens, <200 output
                    input_tokens = rng.randint(100, 480)
                    output_tokens = rng.randint(40, 190)
                else:
                    # Long task: 3000-10000 input tokens
                    input_tokens = rng.randint(3000, 10000)
                    output_tokens = rng.randint(800, 3000)

                records.append(
                    FinancialRecord(
                        record_date=current,
                        amount=-cost_dec,
                        category=SpendCategory.AI_INFERENCE,
                        provider=Provider.OPENAI,
                        model="gpt-4o",
                        tokens_input=input_tokens,
                        tokens_output=output_tokens,
                        source="synthetic",
                        raw_description=f"Synthetic OpenAI gpt-4o request",
                    )
                )

            # ── gpt-4o-mini: daily aggregate ───────────────────────
            mini_cost = 50.0 / 30 * weekend_factor * rng.uniform(0.8, 1.2)
            mini_dec = (Decimal(str(round(mini_cost, 2))) * growth).quantize(Decimal("0.01"))
            pricing = _MODEL_PRICING["gpt-4o-mini"]
            input_cost = mini_dec * Decimal("0.4")
            output_cost = mini_dec * Decimal("0.6")
            mini_input = int(input_cost / pricing["input"] * 1_000_000) if pricing["input"] else 0
            mini_output = int(output_cost / pricing["output"] * 1_000_000) if pricing["output"] else 0

            records.append(
                FinancialRecord(
                    record_date=current,
                    amount=-mini_dec,
                    category=SpendCategory.AI_INFERENCE,
                    provider=Provider.OPENAI,
                    model="gpt-4o-mini",
                    tokens_input=mini_input,
                    tokens_output=mini_output,
                    source="synthetic",
                    raw_description="Synthetic OpenAI gpt-4o-mini usage",
                )
            )

            # ── text-embedding-3-small: daily aggregate ────────────
            embed_cost = 100.0 / 30 * weekend_factor * rng.uniform(0.8, 1.2)
            embed_dec = (Decimal(str(round(embed_cost, 2))) * growth).quantize(Decimal("0.01"))
            embed_pricing = _MODEL_PRICING["text-embedding-3-small"]
            embed_input = int(embed_dec / embed_pricing["input"] * 1_000_000) if embed_pricing["input"] else 0

            records.append(
                FinancialRecord(
                    record_date=current,
                    amount=-embed_dec,
                    category=SpendCategory.AI_INFERENCE,
                    provider=Provider.OPENAI,
                    model="text-embedding-3-small",
                    tokens_input=embed_input,
                    tokens_output=0,
                    source="synthetic",
                    raw_description="Synthetic OpenAI text-embedding-3-small usage",
                )
            )

            current += timedelta(days=1)

        return records
