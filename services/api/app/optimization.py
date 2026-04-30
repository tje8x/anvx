"""Optimization insights computation.

Insights are generated PRIMARILY from `routing_usage_records` (every request
that flowed through anvx.io/v1) and OPTIONALLY backed by `provider_model_usage`
when the workspace has admin-tier connectors. This pivots the original PRD,
which assumed admin connectors as the canonical source — most workspaces don't
have admin keys, so an admin-only insights tab would be empty for them.

Flowing primarily off routing-records also gives us the natural "routing gap"
upsell: when a customer's connector says they spent $5k on Anthropic but only
$500 of that came through the router, the gap is the value story for ANVX.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

# packages/core is imported the same way the rest of services/api does
# (see connectors.py).
from anvx_core.connectors.pricing import estimate_cost_cents

from .db import sb_service

log = logging.getLogger(__name__)


InsightType = Literal[
    "model_tier",
    "seat_utilization",
    "provider_comparison",
    "routing_gap",
    "cost_trajectory",
]
ActionType = Literal["create_routing_rule", "link_to_settings", "informational"]


class OptimizationInsight(BaseModel):
    id: str
    type: InsightType
    title: str
    impact: str
    impact_cents: int
    description: str
    provider: str | None = None
    action_type: ActionType
    action_label: str | None = None
    action_payload: dict[str, Any] | None = None
    dismissed_at: datetime | None = None
    added_to_pack_at: datetime | None = None
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc) + timedelta(days=30))


# ─── Model tiers ────────────────────────────────────────────────────────────
# Coarse-grained classification used for the model_tier insight. We don't
# care about exact list-price ratios — just whether the user's most expensive
# tier is dominating their bill.

_MODEL_TIERS: dict[str, dict[str, list[str]]] = {
    "anthropic": {
        "top": ["claude-opus-4-5", "claude-opus-4-6", "claude-3-opus"],
        "mid": ["claude-sonnet-4-5", "claude-sonnet-4-6", "claude-3-5-sonnet-latest"],
        "low": ["claude-haiku-4-5", "claude-3-5-haiku-latest"],
    },
    "openai": {
        "top": ["gpt-5", "gpt-5.4", "gpt-4.1", "gpt-4o", "o1", "o3"],
        "mid": ["gpt-4.1-mini", "o1-mini", "o3-mini", "o4-mini"],
        "low": ["gpt-4o-mini", "gpt-4o-nano"],
    },
    "google": {
        "top": ["gemini-2.0-pro", "gemini-1.5-pro-latest"],
        "mid": ["gemini-2.0-flash", "gemini-1.5-flash-latest"],
        "low": ["gemini-flash-8b"],
    },
}

# Recommended swap when "top" tier is over-used. (provider, top_model) → mid_model.
_TIER_SUGGESTED_SWAP: dict[tuple[str, str], str] = {
    ("anthropic", "claude-opus-4-5"): "claude-sonnet-4-5",
    ("anthropic", "claude-opus-4-6"): "claude-sonnet-4-6",
    ("anthropic", "claude-3-opus"): "claude-3-5-sonnet-latest",
    ("openai", "gpt-5"): "gpt-4.1-mini",
    ("openai", "gpt-5.4"): "gpt-4.1-mini",
    ("openai", "gpt-4.1"): "gpt-4.1-mini",
    ("openai", "gpt-4o"): "gpt-4o-mini",
    ("openai", "o1"): "o1-mini",
    ("openai", "o3"): "o3-mini",
    ("google", "gemini-2.0-pro"): "gemini-2.0-flash",
    ("google", "gemini-1.5-pro-latest"): "gemini-1.5-flash-latest",
}


def _tier_for(provider: str, model: str) -> str | None:
    tiers = _MODEL_TIERS.get(provider)
    if not tiers:
        return None
    for tier_name in ("top", "mid", "low"):
        if model in tiers[tier_name]:
            return tier_name
    return None


# ─── Data shaping helpers ───────────────────────────────────────────────────


def _routing_window_days() -> int:
    return 30


def _new_id() -> str:
    return str(uuid.uuid4())


def _format_dollars(cents: int) -> str:
    return f"${(cents / 100):,.0f}"


def _format_range(low_cents: int, high_cents: int) -> str:
    return f"{_format_dollars(low_cents)}-{_format_dollars(high_cents)}/mo potential savings"


# ─── Data fetchers ──────────────────────────────────────────────────────────


def _fetch_routing_rows(workspace_id: str, days: int) -> list[dict[str, Any]]:
    """Per-row routing usage. Returns model_routed/provider/tokens/cost/created_at."""
    sb = sb_service()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    res = (
        sb.from_("routing_usage_records")
        .select("provider, model_routed, tokens_in, tokens_out, provider_cost_cents, total_cost_cents, created_at")
        .eq("workspace_id", workspace_id)
        .gte("created_at", cutoff)
        .execute()
    )
    return res.data or []


def _fetch_connector_rows(workspace_id: str, days: int) -> list[dict[str, Any]]:
    """Per-day per-model rollup from connector syncs (admin-tier keys only)."""
    sb = sb_service()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    res = (
        sb.from_("provider_model_usage")
        .select("provider, model, input_tokens, output_tokens, cost_cents, num_requests, period_start")
        .eq("workspace_id", workspace_id)
        .gte("period_start", cutoff)
        .execute()
    )
    return res.data or []


def _fetch_connected_keys(workspace_id: str) -> list[dict[str, Any]]:
    sb = sb_service()
    res = (
        sb.from_("provider_keys")
        .select("provider, key_metadata, last_sync_at")
        .eq("workspace_id", workspace_id)
        .is_("deleted_at", "null")
        .execute()
    )
    return res.data or []


# ─── Insight generators ─────────────────────────────────────────────────────


_LLM_PROVIDERS = {"anthropic", "openai", "google", "cohere", "together", "fireworks", "replicate"}


def _spend_by_model(rows: list[dict[str, Any]], cost_field: str) -> dict[tuple[str, str], dict[str, int]]:
    """Aggregate rows by (provider, model). Returns {(p,m): {cost_cents, tokens_in, tokens_out, n}}.
    `cost_field` is `total_cost_cents` for routing rows, `cost_cents` for connector rows.
    `model` field name differs too — caller normalizes upstream.
    """
    out: dict[tuple[str, str], dict[str, int]] = {}
    for r in rows:
        provider = r.get("provider")
        model = r.get("model_routed") or r.get("model")
        if not provider or not model:
            continue
        bucket = out.setdefault((provider, model), {"cost_cents": 0, "tokens_in": 0, "tokens_out": 0, "n": 0})
        bucket["cost_cents"] += int(r.get(cost_field) or 0)
        bucket["tokens_in"] += int(r.get("tokens_in") or r.get("input_tokens") or 0)
        bucket["tokens_out"] += int(r.get("tokens_out") or r.get("output_tokens") or 0)
        bucket["n"] += 1
    return out


def _model_tier_insights(by_model: dict[tuple[str, str], dict[str, int]]) -> list[OptimizationInsight]:
    """Emit one insight per provider where >40% of spend is on the top tier
    AND total provider spend > $50.
    """
    insights: list[OptimizationInsight] = []

    # Group by provider
    by_provider: dict[str, list[tuple[str, dict[str, int]]]] = {}
    for (provider, model), agg in by_model.items():
        by_provider.setdefault(provider, []).append((model, agg))

    for provider, model_aggs in by_provider.items():
        if provider not in _MODEL_TIERS:
            continue
        total_cents = sum(a["cost_cents"] for _, a in model_aggs)
        if total_cents < 5_000:  # < $50/period — skip
            continue
        top_models: list[tuple[str, dict[str, int]]] = []
        for model, agg in model_aggs:
            if _tier_for(provider, model) == "top":
                top_models.append((model, agg))
        if not top_models:
            continue
        top_cents = sum(a["cost_cents"] for _, a in top_models)
        if top_cents / total_cents < 0.40:
            continue

        # Estimated savings: assume 50% of top-tier requests could move to mid.
        # Use the pricing.py estimator with the same token counts but the
        # suggested swap model.
        savings_low = 0
        savings_high = 0
        suggested_swaps: list[dict[str, str]] = []
        for model, agg in top_models:
            swap = _TIER_SUGGESTED_SWAP.get((provider, model))
            if not swap:
                continue
            current_cost = agg["cost_cents"]
            swapped_cost = estimate_cost_cents(
                swap,
                agg["tokens_in"],
                agg["tokens_out"],
            )
            half_delta = max(0, (current_cost - swapped_cost)) // 2
            # Range envelope to communicate uncertainty: 70%–100% of the
            # naive midpoint.
            savings_low += int(half_delta * 0.7)
            savings_high += int(half_delta * 1.0)
            suggested_swaps.append({"from_model": model, "to_model": swap})

        if savings_high <= 0:
            continue

        midpoint = (savings_low + savings_high) // 2
        pct = round(top_cents / total_cents * 100)
        provider_pretty = {"anthropic": "Anthropic", "openai": "OpenAI", "google": "Google"}.get(provider, provider.title())
        insights.append(OptimizationInsight(
            id=_new_id(),
            type="model_tier",
            title=f"{provider_pretty}: {pct}% of spend on top-tier models",
            impact=_format_range(savings_low, savings_high),
            impact_cents=midpoint,
            description=(
                f"{pct}% of your {provider_pretty} spend in the last 30 days went to top-tier models "
                f"({', '.join(m for m, _ in top_models[:3])}). For tasks that don't need that depth, "
                f"a routing rule that downgrades to {suggested_swaps[0]['to_model']} can recover roughly half of that spend."
            ),
            provider=provider,
            action_type="create_routing_rule",
            action_label="Draft routing rule",
            action_payload={
                "rule_kind": "downgrade",
                "scope_provider": provider,
                "swaps": suggested_swaps,
            },
        ))

    return insights


def _routing_gap_insight(
    routing_by_provider: dict[str, int],
    connector_by_provider: dict[str, int],
    connected_providers: set[str],
    has_any_routing: bool,
    has_any_connector: bool,
) -> OptimizationInsight | None:
    """Always emitted when there's any LLM activity. The framing changes based
    on whether the workspace has admin connectors that give us comparison data.
    """
    if not has_any_routing and not has_any_connector:
        return None

    if has_any_connector:
        # Compare connector spend to routed spend for LLM providers we can see both for.
        biggest_gap_provider: str | None = None
        biggest_gap_cents = 0
        gap_total = 0
        connector_total = 0
        for provider, connector_cents in connector_by_provider.items():
            if provider not in _LLM_PROVIDERS:
                continue
            routed_cents = routing_by_provider.get(provider, 0)
            gap = max(0, connector_cents - routed_cents)
            connector_total += connector_cents
            gap_total += gap
            if gap > biggest_gap_cents:
                biggest_gap_cents = gap
                biggest_gap_provider = provider

        if connector_total == 0:
            return None
        gap_pct = round(gap_total / connector_total * 100) if connector_total > 0 else 0
        if gap_total < 5_000 and gap_pct < 30:
            # Already largely routed — skip the upsell.
            return None

        # Conservative savings band: 5%–15% of the un-routed spend (typical
        # routing-rule headroom on opus-vs-sonnet style swaps).
        low = int(gap_total * 0.05)
        high = int(gap_total * 0.15)
        provider_pretty = (biggest_gap_provider or "").title()
        return OptimizationInsight(
            id=_new_id(),
            type="routing_gap",
            title=f"{gap_pct}% of LLM spend isn't going through ANVX yet",
            impact=_format_range(low, high),
            impact_cents=(low + high) // 2,
            description=(
                f"Your connectors show {_format_dollars(connector_total)} of LLM spend in the last 30 days, "
                f"but only {_format_dollars(connector_total - gap_total)} flowed through anvx.io/v1. "
                f"We can only optimize what we route — point more application code (especially "
                f"{provider_pretty}) at anvx.io/v1 to unlock automatic policies on the rest."
            ),
            provider=biggest_gap_provider,
            action_type="link_to_settings",
            action_label="Open routing setup",
            action_payload={"target": "/settings/routing"},
        )

    # No connector visibility — softer framing aimed at workspaces still ramping.
    routed_total = sum(routing_by_provider.values())
    return OptimizationInsight(
        id=_new_id(),
        type="routing_gap",
        title="Connect more code to anvx.io/v1 to unlock optimization",
        impact="Estimate available after connector sync",
        impact_cents=0,
        description=(
            "We can only optimize the LLM traffic that flows through ANVX routing. "
            f"You've routed {_format_dollars(routed_total)} so far — to get a full optimization picture, "
            "point more of your application code at anvx.io/v1, or connect an admin-tier provider key "
            "so we can compare what's routed vs what isn't."
        ),
        provider=None,
        action_type="link_to_settings",
        action_label="Open routing setup",
        action_payload={"target": "/settings/routing"},
    )


def _provider_comparison_insights(
    by_model: dict[tuple[str, str], dict[str, int]],
    connected_providers: set[str],
) -> list[OptimizationInsight]:
    """For each routed model, suggest a cheaper equivalent at a connected
    provider when the workload looks light enough to swap (avg input < 500
    tokens). Only suggests providers already connected — no new sign-ups.
    """
    insights: list[OptimizationInsight] = []
    # Suggested cross-provider swaps: (from_provider, from_model) → (to_provider, to_model)
    cross_swaps: dict[tuple[str, str], tuple[str, str]] = {
        ("openai", "gpt-4o"): ("anthropic", "claude-haiku-4-5"),
        ("openai", "gpt-4.1"): ("anthropic", "claude-haiku-4-5"),
        ("openai", "gpt-5"): ("anthropic", "claude-sonnet-4-5"),
        ("anthropic", "claude-opus-4-6"): ("openai", "gpt-4.1-mini"),
        ("anthropic", "claude-opus-4-5"): ("openai", "gpt-4.1-mini"),
    }
    for (provider, model), agg in by_model.items():
        target = cross_swaps.get((provider, model))
        if not target:
            continue
        to_provider, to_model = target
        if to_provider not in connected_providers:
            continue
        if agg["n"] == 0 or agg["cost_cents"] < 20_000:  # < $200 — not worth surfacing
            continue
        avg_in = agg["tokens_in"] // max(1, agg["n"])
        if avg_in >= 500:
            continue
        cheaper_cost = estimate_cost_cents(to_model, agg["tokens_in"], agg["tokens_out"])
        delta = max(0, agg["cost_cents"] - cheaper_cost)
        if delta < 5_000:
            continue
        low = int(delta * 0.6)
        high = int(delta * 0.9)
        insights.append(OptimizationInsight(
            id=_new_id(),
            type="provider_comparison",
            title=f"Short prompts on {model} could route to {to_model}",
            impact=_format_range(low, high),
            impact_cents=(low + high) // 2,
            description=(
                f"You spent {_format_dollars(agg['cost_cents'])} on {model} with average prompts under 500 tokens. "
                f"For workloads that light, {to_model} ({to_provider}) is significantly cheaper at comparable quality. "
                f"You already have {to_provider} connected, so a routing rule is one click away."
            ),
            provider=provider,
            action_type="create_routing_rule",
            action_label="Draft cross-provider rule",
            action_payload={
                "rule_kind": "cross_provider_downgrade",
                "from_provider": provider,
                "from_model": model,
                "to_provider": to_provider,
                "to_model": to_model,
                "scope_max_input_tokens": 500,
            },
        ))
    return insights


def _cost_trajectory_insight(rows: list[dict[str, Any]]) -> OptimizationInsight | None:
    """Week-over-week growth alert from routing rows. Skip when monthly volume
    < $50 so noise doesn't trigger this on tiny workspaces.
    """
    if not rows:
        return None
    monthly_cents = sum(int(r.get("total_cost_cents") or 0) for r in rows)
    if monthly_cents < 5_000:
        return None

    now = datetime.now(timezone.utc)
    weeks: list[int] = [0, 0, 0, 0]  # week 0 = oldest, week 3 = most recent
    for r in rows:
        ts_str = r.get("created_at")
        if not ts_str:
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            continue
        days_ago = (now - ts).days
        if days_ago < 0 or days_ago >= 28:
            continue
        bucket = 3 - (days_ago // 7)
        weeks[bucket] += int(r.get("total_cost_cents") or 0)

    biggest_growth_pct = 0.0
    growth_week_idx: int | None = None
    for i in range(1, 4):
        prev = weeks[i - 1]
        cur = weeks[i]
        if prev == 0:
            continue
        pct = (cur - prev) / prev
        if pct > biggest_growth_pct:
            biggest_growth_pct = pct
            growth_week_idx = i

    if growth_week_idx is None or biggest_growth_pct < 0.25:
        return None

    pct_int = int(biggest_growth_pct * 100)
    growth_cents = weeks[growth_week_idx] - weeks[growth_week_idx - 1]
    # Annualized impact at current run rate is the rough "if this continues" lens.
    annualized = growth_cents * 52
    return OptimizationInsight(
        id=_new_id(),
        type="cost_trajectory",
        title=f"Spend up {pct_int}% week-over-week",
        impact=f"~{_format_dollars(annualized)} annualized if trend continues",
        impact_cents=max(0, annualized),
        description=(
            f"Week-over-week growth of {pct_int}% in the last 4 weeks. "
            "Set a budget policy or routing cap before the trajectory bakes into your run rate."
        ),
        provider=None,
        action_type="link_to_settings",
        action_label="Set budget policy",
        action_payload={"target": "/settings/budgets"},
    )


# ─── Public entry point ─────────────────────────────────────────────────────


async def compute_insights(workspace_id: str) -> list[OptimizationInsight]:
    """Compute the live insight set for a workspace. Pure read — does not
    persist. Caller is responsible for upsert.
    """
    days = _routing_window_days()
    routing_rows = _fetch_routing_rows(workspace_id, days)
    connector_rows = _fetch_connector_rows(workspace_id, days)
    connected = _fetch_connected_keys(workspace_id)

    # Filter connector rows to the providers whose key still has historical_usage.
    historical_providers: set[str] = set()
    connected_providers: set[str] = set()
    for k in connected:
        provider = k.get("provider")
        if not provider:
            continue
        connected_providers.add(provider)
        meta = k.get("key_metadata") or {}
        caps = set(meta.get("capabilities") or [])
        if "historical_usage" in caps:
            historical_providers.add(provider)

    connector_rows = [r for r in connector_rows if r.get("provider") in historical_providers]

    # Per-(provider, model) breakdown — both sources merged. Routing wins as the
    # source of truth for spend that flowed through ANVX; connector data adds
    # the spend that didn't.
    by_model_routing = _spend_by_model(routing_rows, "total_cost_cents")
    # NOTE: seat_utilization is intentionally skipped — connectors don't expose
    # per-seat data for Cursor/Copilot yet. TODO once they do.

    routing_by_provider: dict[str, int] = {}
    for (p, _m), agg in by_model_routing.items():
        routing_by_provider[p] = routing_by_provider.get(p, 0) + agg["cost_cents"]

    connector_by_provider: dict[str, int] = {}
    for r in connector_rows:
        p = r.get("provider")
        if not p:
            continue
        connector_by_provider[p] = connector_by_provider.get(p, 0) + int(r.get("cost_cents") or 0)

    insights: list[OptimizationInsight] = []
    insights.extend(_model_tier_insights(by_model_routing))
    insights.extend(_provider_comparison_insights(by_model_routing, connected_providers))

    trajectory = _cost_trajectory_insight(routing_rows)
    if trajectory:
        insights.append(trajectory)

    routing_gap = _routing_gap_insight(
        routing_by_provider=routing_by_provider,
        connector_by_provider=connector_by_provider,
        connected_providers=connected_providers,
        has_any_routing=bool(routing_rows),
        has_any_connector=bool(connector_rows),
    )
    if routing_gap:
        insights.append(routing_gap)

    insights.sort(key=lambda i: i.impact_cents, reverse=True)
    return insights
