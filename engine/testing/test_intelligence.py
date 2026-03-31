"""Test suite: categorisation, anomaly detection, recommendations, financial model."""
import asyncio
import os
import tempfile
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from engine.connectors import (
    AnthropicBillingConnector,
    OpenAIBillingConnector,
    SendGridCostsConnector,
    StripeConnector,
    TwilioCostsConnector,
)
from engine.intelligence.anomaly_detector import detect_anomalies
from engine.intelligence.categoriser import categorise_records
from engine.intelligence.financial_model import FinancialModelManager
from engine.intelligence.recommender import generate_recommendations
from engine.models import (
    FinancialRecord,
    Provider,
    SpendCategory,
)

_END = date.today()
_START = _END - timedelta(days=90)


# ── Categorisation tests ────────────────────────────────────────


class TestCategoriser:
    """Categoriser correctly classifies known records."""

    @pytest.fixture(autouse=True)
    def _synthetic_mode(self):
        os.environ["SYNTHETIC_MODE"] = "true"
        yield
        os.environ.pop("SYNTHETIC_MODE", None)

    @pytest.mark.asyncio
    async def test_known_categories(self):
        records = [
            _make_record("OpenAI GPT-4o inference costs"),
            _make_record("AWS EC2 instance hosting"),
            _make_record("Slack Team subscription"),
            _make_record("Payment received - invoice paid"),
            _make_record("Stripe processing fee"),
        ]
        result = await categorise_records(records)
        assert result[0].category == SpendCategory.AI_INFERENCE
        assert result[1].category == SpendCategory.CLOUD_INFRASTRUCTURE
        assert result[2].category == SpendCategory.SAAS_SUBSCRIPTION
        assert result[3].category == SpendCategory.REVENUE
        assert result[4].category == SpendCategory.PAYMENT_PROCESSING

    @pytest.mark.asyncio
    async def test_communication_providers(self):
        """Categoriser recognises Twilio and SendGrid as COMMUNICATION."""
        records = [
            _make_record("Twilio SMS messaging costs"),
            _make_record("SendGrid email delivery"),
        ]
        result = await categorise_records(records)
        assert result[0].category == SpendCategory.COMMUNICATION
        assert result[1].category == SpendCategory.COMMUNICATION

    @pytest.mark.asyncio
    async def test_monitoring_providers(self):
        """Categoriser recognises Datadog and LangSmith as MONITORING."""
        records = [
            _make_record("Datadog APM monitoring"),
            _make_record("LangSmith tracing costs"),
        ]
        result = await categorise_records(records)
        assert result[0].category == SpendCategory.MONITORING
        assert result[1].category == SpendCategory.MONITORING

    @pytest.mark.asyncio
    async def test_search_data_providers(self):
        """Categoriser recognises Pinecone and Tavily as SEARCH_DATA."""
        records = [
            _make_record("Pinecone vector database queries"),
            _make_record("Tavily search API credits"),
        ]
        result = await categorise_records(records)
        assert result[0].category == SpendCategory.SEARCH_DATA
        assert result[1].category == SpendCategory.SEARCH_DATA

    @pytest.mark.asyncio
    async def test_already_categorised_skipped(self):
        """Records with high confidence are not re-categorised."""
        record = FinancialRecord(
            record_date=_END,
            amount=Decimal("-10.00"),
            category=SpendCategory.AI_INFERENCE,
            provider=Provider.OPENAI,
            source="test",
            raw_description="already done",
            confidenc=0.95,
        )
        result = await categorise_records([record])
        assert result[0].category == SpendCategory.AI_INFERENCE
        assert result[0].confidenc == 0.95

    @pytest.mark.asyncio
    async def test_confidence_scores_set(self):
        """Categorised records get reasonable confidence scores."""
        records = [_make_record("OpenAI GPT-4o inference")]
        result = await categorise_records(records)
        assert result[0].confidenc >= 0.5


# ── Anomaly detection tests ─────────────────────────────────────


class TestAnomalyDetector:
    def test_detects_anomaly_in_synthetic_data(self):
        """Synthetic data has a built-in anomaly week — detector should find it."""
        records = OpenAIBillingConnector().get_synthetic_records(_START, _END)
        records += AnthropicBillingConnector().get_synthetic_records(_START, _END)

        # Test across all weeks to find the anomaly
        found_anomaly = False
        current = _START - timedelta(days=_START.weekday())
        while current <= _END:
            anomalies = detect_anomalies(records, current_week_start=current)
            if anomalies:
                found_anomaly = True
                break
            current += timedelta(weeks=1)

        assert found_anomaly, "Expected anomaly from synthetic data spike"

    def test_no_anomaly_with_constant_data(self):
        """Flat data with complete weeks should produce no anomalies."""
        # Use a fixed Monday so all weeks are complete
        current_monday = date(2026, 3, 23)  # a Monday
        records = []
        # 5 complete weeks: current + 4 baseline, all at $70/week ($10/day)
        for week_offset in range(5):
            week_start = current_monday - timedelta(weeks=week_offset)
            for day in range(7):
                records.append(
                    FinancialRecord(
                        record_date=week_start + timedelta(days=day),
                        amount=Decimal("-10.00"),
                        category=SpendCategory.AI_INFERENCE,
                        provider=Provider.OPENAI,
                        source="test",
                    )
                )
        anomalies = detect_anomalies(records, current_week_start=current_monday)
        assert len(anomalies) == 0

    def test_severity_levels(self):
        """Large deviations get higher severity."""
        # Use fixed Monday so current week is complete
        current_monday = date(2026, 3, 23)
        records = []
        # 4 weeks of baseline at $100/week ($14.29/day × 7)
        for week in range(1, 5):
            week_start = current_monday - timedelta(weeks=week)
            for day in range(7):
                records.append(
                    FinancialRecord(
                        record_date=week_start + timedelta(days=day),
                        amount=Decimal("-14.29"),
                        category=SpendCategory.AI_INFERENCE,
                        provider=Provider.OPENAI,
                        source="test",
                    )
                )
        # Current week at $300 (3x = 200% deviation)
        for day in range(7):
            records.append(
                FinancialRecord(
                    record_date=current_monday + timedelta(days=day),
                    amount=Decimal("-42.86"),
                    category=SpendCategory.AI_INFERENCE,
                    provider=Provider.OPENAI,
                    source="test",
                )
            )

        anomalies = detect_anomalies(records, current_week_start=current_monday)
        assert len(anomalies) > 0
        # 200% deviation should be "critical"
        assert anomalies[0].severity in ("high", "critical")


# ── Recommendation tests ────────────────────────────────────────


class TestRecommender:
    def test_ai_revenue_ratio(self):
        """Detects when AI costs are too high relative to revenue."""
        records = (
            OpenAIBillingConnector().get_synthetic_records(_START, _END)
            + AnthropicBillingConnector().get_synthetic_records(_START, _END)
            + StripeConnector().get_synthetic_records(_START, _END)
        )
        recs = generate_recommendations(records, as_of=_END)
        ratio_recs = [r for r in recs if r.rec_type == "ai_revenue_ratio"]
        assert len(ratio_recs) > 0, "Expected AI-revenue ratio recommendation"
        assert ratio_recs[0].estimated_monthly_savings is not None

    def test_model_routing_with_short_io(self):
        """Detects expensive models used for short I/O tasks."""
        records = []
        for i in range(50):
            d = _END - timedelta(days=i % 30)
            records.append(
                FinancialRecord(
                    record_date=d,
                    amount=Decimal("-0.50"),
                    category=SpendCategory.AI_INFERENCE,
                    provider=Provider.OPENAI,
                    model="gpt-4o",
                    tokens_input=100,  # very short
                    tokens_output=50,  # very short
                    source="test",
                )
            )
        recs = generate_recommendations(records, as_of=_END)
        routing_recs = [r for r in recs if r.rec_type == "model_routing"]
        assert len(routing_recs) > 0, "Expected model routing recommendation"
        assert "gpt-4o-mini" in routing_recs[0].action_required

    def test_no_recommendations_for_healthy_profile(self):
        """A low-spend profile with no revenue shouldn't trigger ratio alert."""
        records = []
        for i in range(30):
            d = _END - timedelta(days=i)
            records.append(
                FinancialRecord(
                    record_date=d,
                    amount=Decimal("-1.00"),
                    category=SpendCategory.AI_INFERENCE,
                    provider=Provider.OPENAI,
                    model="gpt-4o-mini",
                    tokens_input=5000,
                    tokens_output=2000,
                    source="test",
                )
            )
        recs = generate_recommendations(records, as_of=_END)
        ratio_recs = [r for r in recs if r.rec_type == "ai_revenue_ratio"]
        assert len(ratio_recs) == 0


# ── Financial model tests ───────────────────────────────────────


class TestFinancialModel:
    def test_save_load_roundtrip(self):
        """Model state survives save/load cycle."""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.json"
            mgr = FinancialModelManager(state_path=path)
            records = OpenAIBillingConnector().get_synthetic_records(_START, _END)
            mgr.add_records(records, "openai")
            mgr.record_query("test query")
            mgr.save()

            mgr2 = FinancialModelManager(state_path=path)
            mgr2.load()

            assert mgr2.get_summary().record_count == len(records)
            assert len(mgr2.query_history) == 1

    def test_deduplication(self):
        """Adding the same records twice doesn't duplicate."""
        mgr = FinancialModelManager(state_path="/dev/null")
        records = OpenAIBillingConnector().get_synthetic_records(_START, _END)
        n1 = mgr.add_records(records, "openai")
        n2 = mgr.add_records(records, "openai")
        assert n1 == len(records)
        assert n2 == 0

    def test_get_summary_fields(self):
        """Summary includes all expected fields."""
        mgr = FinancialModelManager(state_path="/dev/null")
        records = OpenAIBillingConnector().get_synthetic_records(_START, _END)
        records += StripeConnector().get_synthetic_records(_START, _END)
        mgr.add_records(records, "openai")
        mgr.add_records(records, "stripe")

        summary = mgr.get_summary()
        assert summary.total_monthly_spend > 0
        assert len(summary.spend_by_category) > 0
        assert len(summary.spend_by_provider) > 0
        assert summary.revenue_monthly is not None and summary.revenue_monthly > 0

    def test_get_context_for_llm(self):
        """LLM context is a non-empty string with key sections."""
        mgr = FinancialModelManager(state_path="/dev/null")
        records = OpenAIBillingConnector().get_synthetic_records(_START, _END)
        mgr.add_records(records, "openai")
        ctx = mgr.get_context_for_llm()
        assert "Token Economy Financial Context" in ctx
        assert "Monthly spend" in ctx

    def test_reset_clears_state(self):
        mgr = FinancialModelManager(state_path="/dev/null")
        records = OpenAIBillingConnector().get_synthetic_records(_START, _END)
        mgr.add_records(records, "openai")
        assert mgr.get_summary().record_count > 0
        mgr.reset()
        assert mgr.get_summary().record_count == 0


# ── Cross-bucket insight tests ──────────────────────────────────


class TestCrossBucketInsights:
    def test_ai_costs_as_percent_of_revenue(self):
        """When Stripe is connected, AI cost ratio is calculated."""
        ai_records = OpenAIBillingConnector().get_synthetic_records(_START, _END)
        stripe_records = StripeConnector().get_synthetic_records(_START, _END)
        all_records = ai_records + stripe_records

        recs = generate_recommendations(all_records, as_of=_END)
        # The ratio recommendation should reference revenue
        ratio_recs = [r for r in recs if r.rec_type == "ai_revenue_ratio"]
        if ratio_recs:
            assert "revenue" in ratio_recs[0].description.lower()


# ── Helpers ─────────────────────────────────────────────────────


def _make_record(description: str) -> FinancialRecord:
    return FinancialRecord(
        record_date=_END,
        amount=Decimal("-10.00"),
        category=SpendCategory.OTHER,
        provider=Provider.OTHER,
        source="test",
        raw_description=description,
        confidenc=0.1,
    )
