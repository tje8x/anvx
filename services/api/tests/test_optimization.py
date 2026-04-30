"""Tests for optimization insight computation + dismiss endpoint."""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest


WS = "ws-opt-test-1"
NOW = datetime.now(timezone.utc)


def _routing_row(provider: str, model: str, cost: int, tokens_in: int = 1000, tokens_out: int = 200, days_ago: int = 1) -> dict:
    return {
        "provider": provider,
        "model_routed": model,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "provider_cost_cents": cost,
        "total_cost_cents": cost,
        "created_at": (NOW - timedelta(days=days_ago)).isoformat(),
    }


def _connector_row(provider: str, model: str, cost_cents: int, tokens_in: int = 5000, tokens_out: int = 1000) -> dict:
    return {
        "provider": provider,
        "model": model,
        "input_tokens": tokens_in,
        "output_tokens": tokens_out,
        "cost_cents": cost_cents,
        "num_requests": 100,
        "period_start": (NOW - timedelta(days=1)).date().isoformat(),
    }


def _key_row(provider: str, has_historical: bool = True) -> dict:
    return {
        "provider": provider,
        "key_metadata": {
            "tier": "admin" if has_historical else "standard",
            "capabilities": ["historical_usage"] if has_historical else ["live_tracking"],
        },
        "last_sync_at": NOW.isoformat(),
    }


def _stub_sb(routing_rows=None, connector_rows=None, key_rows=None) -> MagicMock:
    """Stub sb_service() that returns fixed data for the three tables we read."""
    sb = MagicMock()

    def from_side(table):
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.gte.return_value = chain
        chain.is_.return_value = chain
        chain.order.return_value = chain
        chain.limit.return_value = chain
        if table == "routing_usage_records":
            chain.execute.return_value = MagicMock(data=routing_rows or [])
        elif table == "provider_model_usage":
            chain.execute.return_value = MagicMock(data=connector_rows or [])
        elif table == "provider_keys":
            chain.execute.return_value = MagicMock(data=key_rows or [])
        else:
            chain.execute.return_value = MagicMock(data=[])
        return chain

    sb.from_.side_effect = from_side
    return sb


# ─── compute_insights ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_compute_insights_empty_workspace_returns_empty():
    """No routing rows, no connectors, no keys → empty list."""
    from app.optimization import compute_insights

    with patch("app.optimization.sb_service", return_value=_stub_sb()):
        insights = await compute_insights(WS)

    assert insights == []


@pytest.mark.asyncio
async def test_compute_insights_all_opus_emits_model_tier_with_savings():
    """100% Opus routing → model_tier insight with non-zero impact_cents."""
    from app.optimization import compute_insights

    # $300 of Opus traffic — well above the $50 floor.
    rows = [
        _routing_row("anthropic", "claude-opus-4-6", 10_000, tokens_in=5000, tokens_out=2000)
        for _ in range(3)
    ]
    sb = _stub_sb(routing_rows=rows, connector_rows=[], key_rows=[])

    with patch("app.optimization.sb_service", return_value=sb):
        insights = await compute_insights(WS)

    tier = [i for i in insights if i.type == "model_tier"]
    assert len(tier) == 1
    assert tier[0].provider == "anthropic"
    assert tier[0].impact_cents > 0
    assert tier[0].action_type == "create_routing_rule"
    payload = tier[0].action_payload or {}
    assert payload.get("rule_kind") == "downgrade"
    assert any(s.get("from_model", "").startswith("claude-opus") for s in payload.get("swaps", []))


@pytest.mark.asyncio
async def test_compute_insights_routing_gap_with_admin_connector():
    """Connector shows $5k Anthropic spend, only $500 routed → gap insight ~90%."""
    from app.optimization import compute_insights

    # $500 routed (50,000 cents).
    routing = [_routing_row("anthropic", "claude-sonnet-4-5", 50_000, tokens_in=2000, tokens_out=400)]
    # $5k connector spend (500,000 cents) → gap = $4,500 = 90%.
    connector = [_connector_row("anthropic", "claude-opus-4-6", 500_000)]
    keys = [_key_row("anthropic", has_historical=True)]

    sb = _stub_sb(routing_rows=routing, connector_rows=connector, key_rows=keys)

    with patch("app.optimization.sb_service", return_value=sb):
        insights = await compute_insights(WS)

    gap = [i for i in insights if i.type == "routing_gap"]
    assert len(gap) == 1
    # Title carries the percentage; verify it's in the 80-95% window so we
    # know the math is in the right ballpark.
    assert "%" in gap[0].title
    pct_str = gap[0].title.split("%")[0].split()[-1]
    pct = int(pct_str)
    assert 80 <= pct <= 95
    # Conservative savings band — non-zero on a $4,500 gap.
    assert gap[0].impact_cents > 0


@pytest.mark.asyncio
async def test_compute_insights_routing_only_emits_soft_routing_gap():
    """No connectors, just routing activity → soft 'connect more code' upsell."""
    from app.optimization import compute_insights

    routing = [_routing_row("openai", "gpt-4o", 5_000, tokens_in=200, tokens_out=100)]
    sb = _stub_sb(routing_rows=routing, connector_rows=[], key_rows=[])

    with patch("app.optimization.sb_service", return_value=sb):
        insights = await compute_insights(WS)

    gap = [i for i in insights if i.type == "routing_gap"]
    assert len(gap) == 1
    # Soft framing has impact_cents == 0 because we don't have comparison data.
    assert gap[0].impact_cents == 0
    assert "anvx.io/v1" in gap[0].description


# ─── dismiss endpoint ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dismiss_sets_dismissed_at_and_filters_from_list():
    """POST /dismiss sets dismissed_at; subsequent GET excludes the row."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers import optimization as optimization_router
    from app.auth import WorkspaceContext, get_context

    insight_id = "ins-1"

    # In-memory store the stub mutates so we can verify dismiss takes effect.
    store: dict[str, dict] = {
        insight_id: {
            "id": insight_id,
            "workspace_id": WS,
            "type": "model_tier",
            "title": "test",
            "impact": "$100/mo",
            "impact_cents": 10_000,
            "description": "x",
            "provider": "anthropic",
            "action_type": "create_routing_rule",
            "action_label": None,
            "action_payload": None,
            "dismissed_at": None,
            "added_to_pack_at": None,
            "generated_at": NOW.isoformat(),
            "expires_at": (NOW + timedelta(days=30)).isoformat(),
        }
    }

    def stub_sb():
        sb = MagicMock()

        def from_side(table):
            chain = MagicMock()
            captured = {"updates": None}

            def select(*a, **kw):
                return chain
            def eq(*a, **kw):
                return chain
            def is_(*a, **kw):
                return chain
            def gt(*a, **kw):
                return chain
            def gte(*a, **kw):
                return chain
            def order(*a, **kw):
                return chain
            def update(payload):
                captured["updates"] = payload
                return chain
            def insert(rows):
                return chain

            def execute():
                if table != "optimization_insights":
                    # compute_insights queries other tables when the live set is
                    # empty; return empty rows so it falls through cleanly.
                    return MagicMock(data=[])
                if captured["updates"] is not None:
                    # Apply the update to the matching row; then return it as the result.
                    for row in store.values():
                        for k, v in captured["updates"].items():
                            row[k] = v
                    return MagicMock(data=list(store.values()))
                # Plain select: filter by dismissed_at is null and expires_at > now.
                now_iso = datetime.now(timezone.utc).isoformat()
                live = [r for r in store.values() if r["dismissed_at"] is None and r["expires_at"] > now_iso]
                return MagicMock(data=live)

            chain.select.side_effect = select
            chain.eq.side_effect = eq
            chain.is_.side_effect = is_
            chain.gt.side_effect = gt
            chain.gte.side_effect = gte
            chain.order.side_effect = order
            chain.update.side_effect = update
            chain.insert.side_effect = insert
            chain.execute.side_effect = execute
            return chain

        sb.from_.side_effect = from_side
        return sb

    app = FastAPI()
    app.include_router(optimization_router.router, prefix="/api/v2")

    # Override the underlying auth dependency so the test doesn't need real
    # Clerk JWTs. `require_role` builds a fresh closure each call, so overriding
    # those individually doesn't help — every `_checker` closure depends on
    # `get_context`, so overriding that handles all role levels at once.
    fake_ctx = WorkspaceContext(
        user_id="u-1", clerk_user_id="user_test", workspace_id=WS,
        clerk_org_id="org_test", role="admin", email="t@example.com",
    )
    app.dependency_overrides[get_context] = lambda: fake_ctx

    # Patch at the source module — `app.db.sb_service` — so both
    # `app.routers.optimization` and `app.optimization` see the stub.
    with patch("app.db.sb_service", side_effect=stub_sb), \
         patch("app.routers.optimization.sb_service", side_effect=stub_sb), \
         patch("app.optimization.sb_service", side_effect=stub_sb):
        client = TestClient(app)

        # 1. List shows the insight.
        resp = client.get(f"/api/v2/workspaces/{WS}/optimization-insights")
        assert resp.status_code == 200
        assert len(resp.json()["insights"]) == 1

        # 2. Dismiss it.
        resp = client.post(f"/api/v2/workspaces/{WS}/optimization-insights/{insight_id}/dismiss")
        assert resp.status_code == 200
        assert resp.json()["insight"]["dismissed_at"] is not None

        # 3. List no longer includes it.
        resp = client.get(f"/api/v2/workspaces/{WS}/optimization-insights")
        assert resp.status_code == 200
        # The dismiss took effect — no insight returned. (Compute may run on
        # empty results, but our stub always serves the same store, so the
        # dismissed row stays filtered.)
        live = [i for i in resp.json()["insights"] if i["id"] == insight_id]
        assert live == []
