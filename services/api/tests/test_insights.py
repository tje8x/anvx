"""Tests for insight generators."""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.insights import InsightKind, cost_spike, generate_all, top_concentration

WS = "ws-test-123"
NOW = datetime.now(timezone.utc)


def _make_usage(provider: str, cost_cents: int, record_id: str = "rec-1") -> dict:
    return {"id": record_id, "provider": provider, "total_cost_cents_usd": cost_cents, "model": None, "input_tokens": None, "output_tokens": None}


def _mock_sb_query(return_data: list[dict]) -> MagicMock:
    """Build a chained Supabase query mock that returns return_data."""
    result = MagicMock()
    result.data = return_data
    chain = MagicMock()
    chain.execute.return_value = result
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.gte.return_value = chain
    chain.lt.return_value = chain
    chain.lte.return_value = chain
    chain.in_.return_value = chain
    chain.is_.return_value = chain
    chain.limit.return_value = chain
    chain.order.return_value = chain
    chain.single.return_value = chain
    return chain


def _mock_sb_service(query_responses: list[list[dict]]) -> MagicMock:
    """Create a sb_service mock that returns different data for successive from_() calls."""
    sb = MagicMock()
    idx = {"i": 0}

    def from_side_effect(table_name: str):
        i = idx["i"]
        idx["i"] += 1
        data = query_responses[i] if i < len(query_responses) else []
        return _mock_sb_query(data)

    sb.from_.side_effect = from_side_effect
    return sb


# ── top_concentration ────────────────────────────────────────────


@patch("app.insights.sb_service")
def test_top_concentration_above_threshold(mock_sb):
    rows = [_make_usage("openai", 800, "r1"), _make_usage("openai", 700, "r2"), _make_usage("anthropic", 200, "r3"), _make_usage("aws", 100, "r4")]
    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query(rows)
    mock_sb.return_value = sb

    insight = top_concentration(WS)
    assert insight is not None
    assert insight.kind == InsightKind.TOP_CONCENTRATION
    assert "openai" in insight.headline
    assert insight.value_cents == 1500  # 800 + 700


@patch("app.insights.sb_service")
def test_top_concentration_even_distribution(mock_sb):
    rows = [_make_usage("openai", 250, "r1"), _make_usage("anthropic", 250, "r2"), _make_usage("aws", 250, "r3"), _make_usage("gcp", 250, "r4")]
    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query(rows)
    mock_sb.return_value = sb

    insight = top_concentration(WS)
    assert insight is None  # 25% each, below 40% threshold


@patch("app.insights.sb_service")
def test_top_concentration_empty(mock_sb):
    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query([])
    mock_sb.return_value = sb

    insight = top_concentration(WS)
    assert insight is None


# ── cost_spike ───────────────────────────────────────────────────


@patch("app.insights.sb_service")
def test_cost_spike_detected(mock_sb):
    recent = [_make_usage("openai", 1500, "r1")]  # $15 this week
    baseline = [_make_usage("openai", 1000, "r2"), _make_usage("openai", 1000, "r3"), _make_usage("openai", 1000, "r4")]  # $10/week avg over 3 weeks

    sb = MagicMock()
    call_count = {"i": 0}

    def from_side(table):
        c = call_count["i"]
        call_count["i"] += 1
        if c == 0:
            return _mock_sb_query(recent)
        return _mock_sb_query(baseline)

    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    insight = cost_spike(WS)
    assert insight is not None
    assert insight.kind == InsightKind.COST_SPIKE
    assert "50%" in insight.headline  # 1500 vs 1000 avg = +50%


@patch("app.insights.sb_service")
def test_cost_spike_not_detected(mock_sb):
    recent = [_make_usage("openai", 1000, "r1")]
    baseline = [_make_usage("openai", 1000, "r2"), _make_usage("openai", 1000, "r3"), _make_usage("openai", 1000, "r4")]

    sb = MagicMock()
    call_count = {"i": 0}

    def from_side(table):
        c = call_count["i"]
        call_count["i"] += 1
        if c == 0:
            return _mock_sb_query(recent)
        return _mock_sb_query(baseline)

    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    insight = cost_spike(WS)
    assert insight is None  # 1000 vs 1000 avg = 0% change


# ── generate_all ─────────────────────────────────────────────────


@patch("app.insights.sb_service")
def test_generate_all_sorted_by_value(mock_sb):
    # Make sb_service return a mock that always returns concentrated data
    concentrated = [_make_usage("openai", 9000, "r1"), _make_usage("aws", 1000, "r2")]

    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query(concentrated)
    mock_sb.return_value = sb

    insights = generate_all(WS)
    # Should have at least top_concentration and runway_projection
    assert len(insights) >= 1
    # Verify sorted descending
    for i in range(len(insights) - 1):
        assert insights[i].value_cents >= insights[i + 1].value_cents
