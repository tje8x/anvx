"""Tests for observer recommendation engine."""
from unittest.mock import MagicMock, patch

import pytest

from app.observer import compute_routing_opportunities, compute_budget_protections, _FALLBACK_PRICE

WS = "ws-test-123"


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
    chain.maybeSingle.return_value = chain
    return chain


def _make_usage(model: str, tokens_in: int, tokens_out: int, cost_cents: int, ts: str = "2026-04-20T10:00:00+00:00") -> dict:
    return {"model_routed": model, "tokens_in": tokens_in, "tokens_out": tokens_out, "provider_cost_cents": cost_cents, "ts": ts}


# ── Routing opportunities ────────────────────────────────────────


@patch("app.observer.sb_service")
def test_premium_cluster_detected(mock_sb):
    """GPT-4o cluster with >50% simple calls should produce a routing opportunity."""
    # 10 calls: 8 simple (tokens_in<500, tokens_out<200), 2 complex
    simple_calls = [_make_usage("gpt-4o", 300, 100, 50) for _ in range(8)]
    complex_calls = [_make_usage("gpt-4o", 2000, 800, 200) for _ in range(2)]
    all_calls = simple_calls + complex_calls

    sb = MagicMock()
    call_idx = {"i": 0}

    def from_side(table):
        c = call_idx["i"]
        call_idx["i"] += 1
        if table == "routing_usage_records":
            return _mock_sb_query(all_calls)
        if table == "models":
            # Return price for gpt-4o-mini
            return _mock_sb_query({"input_price_per_mtok_cents": 15, "output_price_per_mtok_cents": 60})
        return _mock_sb_query([])

    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    opps = compute_routing_opportunities(WS, window_days=7)
    assert len(opps) >= 1
    assert opps[0].model_routed == "gpt-4o"
    assert opps[0].suggested_model == "gpt-4o-mini"
    assert opps[0].simple_count == 8
    assert opps[0].savings_cents > 0


@patch("app.observer.sb_service")
def test_insufficient_data_returns_empty(mock_sb):
    """No usage records should return empty list."""
    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query([])
    mock_sb.return_value = sb

    opps = compute_routing_opportunities(WS, window_days=7)
    assert opps == []


@patch("app.observer.sb_service")
def test_price_lookup_fallback(mock_sb):
    """When models table has no row, fallback prices should be used."""
    simple_calls = [_make_usage("claude-sonnet-4", 200, 100, 100) for _ in range(20)]

    sb = MagicMock()
    call_idx = {"i": 0}

    def from_side(table):
        c = call_idx["i"]
        call_idx["i"] += 1
        if table == "routing_usage_records":
            return _mock_sb_query(simple_calls)
        if table == "models":
            # No model found — maybeSingle returns None
            return _mock_sb_query(None)
        return _mock_sb_query([])

    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    opps = compute_routing_opportunities(WS, window_days=7)
    assert len(opps) >= 1
    # The savings calculation should use fallback prices
    assert opps[0].projected_cost_cents >= 0


# ── Budget protections ───────────────────────────────────────────


@patch("app.observer.sb_service")
def test_spike_cluster_detected(mock_sb):
    """Hours with >3x average spend and >$1 should be flagged as spikes."""
    # 20 normal hours at 50 cents each, 2 spike hours at 500 cents each
    normal = [{"ts": f"2026-04-20T{h:02d}:30:00+00:00", "provider_cost_cents": 50} for h in range(20)]
    spikes = [{"ts": "2026-04-20T21:30:00+00:00", "provider_cost_cents": 500}, {"ts": "2026-04-20T22:30:00+00:00", "provider_cost_cents": 500}]
    all_rows = normal + spikes

    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query(all_rows)
    mock_sb.return_value = sb

    bps = compute_budget_protections(WS, window_days=7)
    assert len(bps) == 1
    assert bps[0].spike_count == 2
    assert bps[0].prevented_cost_cents > 0
    # Average is (20*50 + 2*500) / 22 ≈ 90.9, threshold ≈ 272.7
    # Each spike: 500 - 273 = 227, total prevented ≈ 454
    assert bps[0].prevented_cost_cents > 400
