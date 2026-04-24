"""Tests for anomaly detectors."""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.anomaly import detect_recursive_loops, detect_pricing_changes, detect_leaked_keys, detect_budget_trajectory

WS = "ws-test-123"
NOW = datetime.now(timezone.utc)


def _mock_sb_query(return_data):
    result = MagicMock()
    result.data = return_data
    chain = MagicMock()
    chain.execute.return_value = result
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.gte.return_value = chain
    chain.lt.return_value = chain
    chain.is_.return_value = chain
    chain.order.return_value = chain
    chain.limit.return_value = chain
    return chain


# ── Recursive loops ──────────────────────────────────────────────


@patch("app.anomaly.sb_service")
def test_recursive_loops_detected(mock_sb):
    """30+ calls with avg cost >= 500 cents triggers recursive_loop."""
    rows = [{"project_tag": "agent-x", "user_hint": None, "total_cost_cents": 600} for _ in range(35)]
    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query(rows)
    mock_sb.return_value = sb

    anomalies = detect_recursive_loops(WS)
    assert len(anomalies) == 1
    assert anomalies[0].kind == "recursive_loop"
    assert anomalies[0].severity == "warn"
    assert anomalies[0].payload["count"] == 35
    assert anomalies[0].dedupe_key == "agent-x"


@patch("app.anomaly.sb_service")
def test_recursive_loops_critical_over_100(mock_sb):
    rows = [{"project_tag": "runaway", "user_hint": None, "total_cost_cents": 500} for _ in range(120)]
    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query(rows)
    mock_sb.return_value = sb

    anomalies = detect_recursive_loops(WS)
    assert len(anomalies) == 1
    assert anomalies[0].severity == "critical"


# ── Pricing changes ──────────────────────────────────────────────


@patch("app.anomaly.sb_service")
def test_pricing_change_detected(mock_sb):
    """15%+ median price change triggers pricing_change."""
    recent_ts = (NOW - timedelta(hours=12)).isoformat()
    baseline_ts = (NOW - timedelta(days=3)).isoformat()
    # Baseline: 100 cpm, Recent: 130 cpm (30% increase)
    baseline_rows = [{"provider": "openai", "model_routed": "gpt-4o", "tokens_in": 1000, "tokens_out": 0, "total_cost_cents": 100, "created_at": baseline_ts} for _ in range(10)]
    recent_rows = [{"provider": "openai", "model_routed": "gpt-4o", "tokens_in": 1000, "tokens_out": 0, "total_cost_cents": 130, "created_at": recent_ts} for _ in range(10)]

    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query(baseline_rows + recent_rows)
    mock_sb.return_value = sb

    anomalies = detect_pricing_changes(WS)
    assert len(anomalies) == 1
    assert anomalies[0].kind == "pricing_change"
    assert anomalies[0].payload["pct_change"] == 30.0


# ── Leaked keys ──────────────────────────────────────────────────


@patch("app.anomaly.sb_service")
def test_leaked_keys_detected(mock_sb):
    """5x volume spike with 4+ distinct user_hints triggers leaked_key."""
    recent_rows = [{"user_hint": f"user-{i % 5}"} for i in range(60)]
    baseline_rows = [{"id": str(i)} for i in range(7 * 24 * 6 * 8)]  # 8 per 10min avg

    sb = MagicMock()
    call_idx = {"i": 0}

    def from_side(table):
        c = call_idx["i"]
        call_idx["i"] += 1
        if c == 0:
            return _mock_sb_query(recent_rows)
        return _mock_sb_query(baseline_rows)

    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    anomalies = detect_leaked_keys(WS)
    assert len(anomalies) == 1
    assert anomalies[0].kind == "leaked_key"
    assert anomalies[0].severity == "critical"
    assert anomalies[0].payload["distinct_user_hints"] == 5


# ── Budget trajectory ────────────────────────────────────────────


@patch("app.anomaly.datetime")
@patch("app.anomaly.sb_service")
def test_budget_trajectory_detected(mock_sb, mock_dt):
    """MTD spend projecting over monthly limit triggers budget_trajectory."""
    # Pretend it's day 10
    fake_now = NOW.replace(day=10)
    mock_dt.now.return_value = fake_now
    mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)

    policies = [{"id": "pol-1", "name": "Monthly cap", "monthly_limit_cents": 10000, "scope_provider": None, "scope_project_tag": None, "scope_user_hint": None}]
    # MTD spend: 5000 cents in 10 days → projected 15000 for 30 days → 50% overshoot
    mtd_rows = [{"total_cost_cents": 500} for _ in range(10)]

    sb = MagicMock()
    call_idx = {"i": 0}

    def from_side(table):
        c = call_idx["i"]
        call_idx["i"] += 1
        if table == "budget_policies":
            return _mock_sb_query(policies)
        return _mock_sb_query(mtd_rows)

    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    anomalies = detect_budget_trajectory(WS)
    assert len(anomalies) == 1
    assert anomalies[0].kind == "budget_trajectory"
    assert anomalies[0].severity == "critical"  # >25% overshoot
    assert anomalies[0].payload["policy_id"] == "pol-1"
