"""Insight ranking + felt-value scoring tests."""
from unittest.mock import MagicMock, patch

from app.insights import (
    Insight,
    InsightKind,
    compute_felt_value_score,
    pick_top_insight,
)


# ── Synthetic factories ───────────────────────────────────────────


def _top_concentration(value_cents: int, pct: float, total_cents: int) -> Insight:
    return Insight(
        kind=InsightKind.TOP_CONCENTRATION,
        headline="x", detail="x",
        value_cents=value_cents,
        meta={"concentration_pct": pct, "total_spend_cents": total_cents},
        next_action_url="/routing",
    )


def _cost_spike(delta_cents: int) -> Insight:
    return Insight(
        kind=InsightKind.COST_SPIKE,
        headline="x", detail="x",
        value_cents=delta_cents,
        meta={"delta_cents": delta_cents},
        next_action_url="/dashboard",
    )


def _model_downgrade(savings_cents: int) -> Insight:
    return Insight(
        kind=InsightKind.MODEL_DOWNGRADE_CANDIDATE,
        headline="x", detail="x",
        value_cents=savings_cents,
        meta={"estimated_monthly_savings_cents": savings_cents},
        next_action_url="/routing",
    )


def _dormant(days_idle: int, monthly_spend_cents: int) -> Insight:
    return Insight(
        kind=InsightKind.DORMANT_SUBSCRIPTION,
        headline="x", detail="x",
        value_cents=0,
        meta={"days_dormant": days_idle, "monthly_spend_cents": monthly_spend_cents},
        next_action_url="/settings/connections",
    )


def _runway(days_to_overrun: int | None) -> Insight:
    return Insight(
        kind=InsightKind.RUNWAY_PROJECTION,
        headline="x", detail="x",
        value_cents=0,
        meta={"days_to_overrun": days_to_overrun},
        next_action_url="/dashboard",
    )


# ── Score formula tests ──────────────────────────────────────────


def test_score_top_concentration_pct_times_total():
    # $5k provider at 60% = 0.60 * 500_000 = 300_000
    ins = _top_concentration(value_cents=300_000, pct=60.0, total_cents=500_000)
    assert compute_felt_value_score(ins) == 300_000.0


def test_score_cost_spike_delta_times_two():
    # $1k spike → 200_000
    ins = _cost_spike(delta_cents=100_000)
    assert compute_felt_value_score(ins) == 200_000.0


def test_score_model_downgrade_savings_times_three():
    # $640/mo savings → 192_000
    ins = _model_downgrade(savings_cents=64_000)
    assert compute_felt_value_score(ins) == 192_000.0


def test_score_dormant_capped_at_three_x():
    # 90 days idle, $100/mo → 10_000 * 3 = 30_000
    ins = _dormant(days_idle=90, monthly_spend_cents=10_000)
    assert compute_felt_value_score(ins) == 30_000.0
    # Beyond 90 days still caps at 3x
    ins2 = _dormant(days_idle=180, monthly_spend_cents=10_000)
    assert compute_felt_value_score(ins2) == 30_000.0


def test_score_runway_urgency_buckets():
    assert compute_felt_value_score(_runway(7)) == 500_000.0   # ≤7
    assert compute_felt_value_score(_runway(14)) == 300_000.0  # ≤14
    assert compute_felt_value_score(_runway(30)) == 150_000.0  # ≤30
    assert compute_felt_value_score(_runway(60)) == 50_000.0   # >30
    assert compute_felt_value_score(_runway(None)) == 50_000.0  # missing


# ── Ranking + guard tests ────────────────────────────────────────


def test_model_downgrade_outranks_top_concentration_with_higher_score():
    # MODEL_DOWNGRADE @ $640 savings = 192_000
    # TOP_CONCENTRATION @ $1.5k of $5k = 0.30 * 500_000 = 150_000
    downgrade = _model_downgrade(savings_cents=64_000)
    concentration = _top_concentration(value_cents=150_000, pct=30.0, total_cents=500_000)
    top = pick_top_insight("ws-1", [concentration, downgrade])
    assert top is not None
    assert top.kind == InsightKind.MODEL_DOWNGRADE_CANDIDATE


@patch("app.insights.sb_service")
def test_fallback_fires_when_all_candidates_fail_guard(mock_sb):
    # Build insights that all fail the guard: value_cents=0 AND no next_action_url.
    bad = [
        Insight(kind=InsightKind.DORMANT_SUBSCRIPTION, headline="x", detail="x",
                value_cents=0, meta={}, next_action_url=None),
        Insight(kind=InsightKind.RUNWAY_PROJECTION, headline="x", detail="x",
                value_cents=0, meta={}, next_action_url=None),
    ]

    # Mock usage_records with two providers — fallback should compute
    # a TOP_CONCENTRATION result.
    sb = MagicMock()
    chain = MagicMock()
    chain.execute.return_value = MagicMock(data=[
        {"id": "u1", "provider": "openai", "total_cost_cents_usd": 30_000},
        {"id": "u2", "provider": "anthropic", "total_cost_cents_usd": 20_000},
    ])
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.gte.return_value = chain
    sb.from_.return_value = chain
    mock_sb.return_value = sb

    top = pick_top_insight("ws-1", bad)
    assert top is not None
    assert top.kind == InsightKind.TOP_CONCENTRATION
    assert top.meta.get("fallback") is True
    assert top.value_cents > 0  # always has a dollar figure
