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


@pytest.mark.asyncio
async def test_routing_gap_sub_dollar_volume_uses_request_count_phrasing():
    """0 < routed_total < 100 cents → "X requests, ~$X.XX" phrasing, not "$0 routed"."""
    from app.optimization import compute_insights

    # Three requests totaling 47 cents — below the rounded-to-zero threshold.
    routing = [
        _routing_row("openai", "gpt-4o-mini", 15, tokens_in=80, tokens_out=20),
        _routing_row("openai", "gpt-4o-mini", 16, tokens_in=80, tokens_out=20),
        _routing_row("openai", "gpt-4o-mini", 16, tokens_in=80, tokens_out=20),
    ]
    sb = _stub_sb(routing_rows=routing, connector_rows=[], key_rows=[])

    with patch("app.optimization.sb_service", return_value=sb):
        insights = await compute_insights(WS)

    gap = next(i for i in insights if i.type == "routing_gap")
    # The misleading "$0 routed" copy must NOT appear at any sub-dollar volume.
    assert "$0 so far" not in gap.description
    assert "$0 routed" not in gap.description
    # Required phrasing: request count + 2-decimal dollars.
    assert "3 requests so far" in gap.description
    assert "about $0.47 in spend" in gap.description


def test_pack_optimization_section_for_mixed_status_workspace():
    """`get_optimization_section` returns the right shape for a workspace with
    a mix of pending / dismissed / added-to-pack insights, plus an admin connector
    so the routing-coverage box is populated."""
    from datetime import date, timedelta
    from app.packs.close_pack import get_optimization_section

    period_start = date(2026, 4, 1)
    period_end = date(2026, 5, 1)

    in_period = (NOW.replace(year=2026, month=4, day=15)).isoformat()

    insight_rows = [
        # Active model_tier — pending review.
        {
            "id": "ins-1",
            "workspace_id": WS,
            "type": "model_tier",
            "title": "Anthropic: 70% on top tier",
            "impact": "$300-$500/mo potential savings",
            "impact_cents": 40_000,
            "description": "x",
            "provider": "anthropic",
            "action_type": "create_routing_rule",
            "action_label": None,
            "action_payload": None,
            "dismissed_at": None,
            "added_to_pack_at": None,
            "generated_at": in_period,
            "expires_at": (NOW + timedelta(days=10)).isoformat(),
        },
        # Added by user.
        {
            "id": "ins-2",
            "workspace_id": WS,
            "type": "provider_comparison",
            "title": "Short prompts on gpt-4o → claude-haiku-4-5",
            "impact": "$50-$80/mo potential savings",
            "impact_cents": 6_500,
            "description": "y",
            "provider": "openai",
            "action_type": "create_routing_rule",
            "action_label": None,
            "action_payload": None,
            "dismissed_at": None,
            "added_to_pack_at": in_period,
            "generated_at": in_period,
            "expires_at": (NOW + timedelta(days=10)).isoformat(),
        },
        # Dismissed.
        {
            "id": "ins-3",
            "workspace_id": WS,
            "type": "cost_trajectory",
            "title": "Spend up 30% week-over-week",
            "impact": "~$5,000 annualized",
            "impact_cents": 500_000,
            "description": "z",
            "provider": None,
            "action_type": "link_to_settings",
            "action_label": None,
            "action_payload": None,
            "dismissed_at": in_period,
            "added_to_pack_at": None,
            "generated_at": in_period,
            "expires_at": (NOW + timedelta(days=10)).isoformat(),
        },
        # Routing gap with admin-connector payload — drives the coverage box.
        {
            "id": "ins-4",
            "workspace_id": WS,
            "type": "routing_gap",
            "title": "82% of LLM spend isn't going through ANVX yet",
            "impact": "$200-$600/mo potential savings",
            "impact_cents": 40_000,
            "description": "w",
            "provider": "anthropic",
            "action_type": "link_to_settings",
            "action_label": "Open routing setup",
            "action_payload": {
                "target": "/settings/routing",
                "coverage_pct": 18,
                "connector_total_cents": 500_000,
                "routed_cents": 90_000,
                "gap_cents": 410_000,
            },
            "dismissed_at": None,
            "added_to_pack_at": None,
            "generated_at": in_period,
            "expires_at": (NOW + timedelta(days=10)).isoformat(),
        },
    ]

    keys_rows = [
        # Admin-tier Anthropic key — drives has_admin_connector=True.
        {
            "provider": "anthropic",
            "key_metadata": {"tier": "admin", "capabilities": ["historical_usage"]},
            "deleted_at": None,
            "created_at": "2025-01-01T00:00:00+00:00",
        },
    ]

    def from_side(table):
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.is_.return_value = chain
        chain.gte.return_value = chain
        chain.lt.return_value = chain
        chain.order.return_value = chain
        chain.limit.return_value = chain
        if table == "optimization_insights":
            chain.execute.return_value = MagicMock(data=insight_rows)
        elif table == "provider_keys":
            chain.execute.return_value = MagicMock(data=keys_rows)
        else:
            chain.execute.return_value = MagicMock(data=[])
        return chain

    sb = MagicMock()
    sb.from_.side_effect = from_side

    with patch("app.packs.close_pack.sb_service", return_value=sb):
        section = get_optimization_section(WS, period_start, period_end)

    assert section["n_providers"] == 1
    assert section["n_insights_in_period"] == 4
    assert section["summary"].startswith("ANVX analyzed 1 connected provider")
    assert "4 optimization opportunities" in section["summary"]

    statuses = {r["status"] for r in section["insight_rows"]}
    assert "Pending review" in statuses
    assert "Added by user" in statuses
    assert "Dismissed" in statuses

    # Coverage box populated from the routing_gap payload.
    assert section["coverage_box"] is not None
    assert section["coverage_box"]["routed_pct"] == 18
    assert section["coverage_box"]["gap_pct"] == 82
    assert section["no_admin_blurb"] is None


def test_pack_optimization_section_no_admin_emits_blurb():
    """No admin-tier connector → coverage_box is None and the upsell blurb is set."""
    from datetime import date
    from app.packs.close_pack import get_optimization_section

    period_start = date(2026, 4, 1)
    period_end = date(2026, 5, 1)

    keys_rows = [
        # Standard tier — no historical_usage capability, so not an admin connector.
        {
            "provider": "openai",
            "key_metadata": {"tier": "standard", "capabilities": ["live_tracking"]},
            "deleted_at": None,
            "created_at": "2025-01-01T00:00:00+00:00",
        },
    ]

    def from_side(table):
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.is_.return_value = chain
        chain.gte.return_value = chain
        chain.lt.return_value = chain
        chain.order.return_value = chain
        chain.limit.return_value = chain
        if table == "provider_keys":
            chain.execute.return_value = MagicMock(data=keys_rows)
        else:
            chain.execute.return_value = MagicMock(data=[])
        return chain

    sb = MagicMock()
    sb.from_.side_effect = from_side

    with patch("app.packs.close_pack.sb_service", return_value=sb):
        section = get_optimization_section(WS, period_start, period_end)

    assert section["coverage_box"] is None
    assert section["no_admin_blurb"] is not None
    assert "admin-tier provider key" in section["no_admin_blurb"]


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
