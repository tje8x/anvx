"""Shadow-mode recommendation engine — computes routing opportunities and budget protections."""
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from uuid import uuid4

from .db import sb_service


class RecommendationKind(str, Enum):
    ROUTING_OPPORTUNITY = "routing_opportunity"
    BUDGET_PROTECTION = "budget_protection"


_PREMIUM_MODELS = {"gpt-4o", "claude-sonnet-4", "claude-3-5-sonnet", "claude-opus-4"}

_SUBSTITUTE_MAP: dict[str, str] = {
    "gpt-4o": "gpt-4o-mini",
    "claude-sonnet-4": "claude-haiku-3.5",
    "claude-3-5-sonnet": "claude-haiku-3.5",
    "claude-opus-4": "claude-sonnet-4",
}

# Fallback price per MTok in cents (input, output)
_FALLBACK_PRICE = {"input": 15, "output": 60}

_MIN_SAVINGS_CENTS = 100  # $1


def _lookup_model_price(sb, provider: str, model: str) -> dict:
    """Look up model price from models table. Returns {input, output} in cents per MTok."""
    result = sb.from_("models").select("input_price_per_mtok_cents, output_price_per_mtok_cents").eq("provider", provider).eq("model", model).maybeSingle().execute()
    if result.data:
        return {"input": result.data["input_price_per_mtok_cents"] or _FALLBACK_PRICE["input"], "output": result.data["output_price_per_mtok_cents"] or _FALLBACK_PRICE["output"]}
    return dict(_FALLBACK_PRICE)


def _infer_provider(model: str) -> str:
    if model.startswith("gpt-") or model.startswith("o1") or model.startswith("o3") or model.startswith("o4"):
        return "openai"
    if model.startswith("claude-"):
        return "anthropic"
    if model.startswith("gemini"):
        return "google"
    return "unknown"


@dataclass
class RoutingOpportunity:
    model_routed: str
    suggested_model: str
    request_count: int
    simple_count: int
    current_cost_cents: int
    projected_cost_cents: int
    savings_cents: int
    monthly_savings_cents: int


@dataclass
class BudgetProtection:
    spike_count: int
    total_spike_cost_cents: int
    prevented_cost_cents: int
    avg_hourly_cents: int


def compute_routing_opportunities(workspace_id: str, window_days: int = 7) -> list[RoutingOpportunity]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()
    sb = sb_service()
    result = sb.from_("routing_usage_records").select("model_routed, tokens_in, tokens_out, provider_cost_cents").eq("workspace_id", workspace_id).gte("ts", cutoff).execute()
    rows = result.data or []
    if not rows:
        return []

    # Cluster by model_routed
    clusters: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        clusters[r.get("model_routed", "")].append(r)

    opportunities: list[RoutingOpportunity] = []
    for model, calls in clusters.items():
        if model not in _PREMIUM_MODELS:
            continue
        if model not in _SUBSTITUTE_MAP:
            continue

        # Check if >50% of calls are simple (tokens_in<500 AND tokens_out<200)
        simple = [c for c in calls if (c.get("tokens_in") or 0) < 500 and (c.get("tokens_out") or 0) < 200]
        if len(simple) < len(calls) * 0.5:
            continue

        substitute = _SUBSTITUTE_MAP[model]
        current_cost = sum(c.get("provider_cost_cents", 0) for c in calls)

        # Price the substitute
        sub_provider = _infer_provider(substitute)
        sub_price = _lookup_model_price(sb, sub_provider, substitute)
        total_in = sum(c.get("tokens_in", 0) or 0 for c in calls)
        total_out = sum(c.get("tokens_out", 0) or 0 for c in calls)
        projected_cost = round((total_in * sub_price["input"] + total_out * sub_price["output"]) / 1_000_000)

        savings = current_cost - projected_cost
        if savings < _MIN_SAVINGS_CENTS:
            continue

        monthly_savings = round(savings * 30 / window_days)
        opportunities.append(RoutingOpportunity(
            model_routed=model, suggested_model=substitute, request_count=len(calls), simple_count=len(simple),
            current_cost_cents=current_cost, projected_cost_cents=projected_cost, savings_cents=savings, monthly_savings_cents=monthly_savings,
        ))

    opportunities.sort(key=lambda o: o.savings_cents, reverse=True)
    return opportunities[:5]


def compute_budget_protections(workspace_id: str, window_days: int = 7) -> list[BudgetProtection]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()
    sb = sb_service()
    result = sb.from_("routing_usage_records").select("ts, provider_cost_cents").eq("workspace_id", workspace_id).gte("ts", cutoff).order("ts").execute()
    rows = result.data or []
    if not rows:
        return []

    # Bucket by hour
    hourly: dict[str, int] = defaultdict(int)
    for r in rows:
        ts_str = r.get("ts", "")
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            hour_key = ts.strftime("%Y-%m-%dT%H")
        except (ValueError, AttributeError):
            continue
        hourly[hour_key] += r.get("provider_cost_cents", 0)

    if not hourly:
        return []

    total_spend = sum(hourly.values())
    avg_hourly = total_spend / len(hourly)
    if avg_hourly == 0:
        return []

    spike_threshold = avg_hourly * 3
    spikes = [(h, cost) for h, cost in hourly.items() if cost > spike_threshold and cost > _MIN_SAVINGS_CENTS]
    if not spikes:
        return []

    total_spike_cost = sum(cost for _, cost in spikes)
    prevented = sum(cost - round(spike_threshold) for _, cost in spikes)
    if prevented < _MIN_SAVINGS_CENTS:
        return []

    return [BudgetProtection(spike_count=len(spikes), total_spike_cost_cents=total_spike_cost, prevented_cost_cents=prevented, avg_hourly_cents=round(avg_hourly))]


def refresh_recommendations(workspace_id: str) -> None:
    """Generate new recommendations and insert into shadow_recommendations, deduplicating against unresponded rows."""
    sb = sb_service()

    # Get existing unresponded recommendation kinds
    existing = sb.from_("shadow_recommendations").select("kind").eq("workspace_id", workspace_id).is_("user_response", "null").execute()
    existing_kinds = {r["kind"] for r in (existing.data or [])}

    # Routing opportunities
    if RecommendationKind.ROUTING_OPPORTUNITY.value not in existing_kinds:
        opps = compute_routing_opportunities(workspace_id)
        for opp in opps:
            sb.from_("shadow_recommendations").insert({
                "workspace_id": workspace_id,
                "kind": RecommendationKind.ROUTING_OPPORTUNITY.value,
                "headline": f"{opp.simple_count} simple {opp.model_routed} calls could use {opp.suggested_model} — est. ${opp.monthly_savings_cents / 100:.0f}/mo saved",
                "detail": f"{opp.simple_count} of {opp.request_count} {opp.model_routed} calls had <500 input and <200 output tokens. Routing to {opp.suggested_model} would save ${opp.savings_cents / 100:.2f}/wk (${opp.monthly_savings_cents / 100:.0f}/mo projected).",
                "estimated_value_cents": opp.monthly_savings_cents,
                "metadata": {"model_routed": opp.model_routed, "suggested_model": opp.suggested_model, "request_count": opp.request_count, "simple_count": opp.simple_count},
            }).execute()

    # Budget protections
    if RecommendationKind.BUDGET_PROTECTION.value not in existing_kinds:
        bps = compute_budget_protections(workspace_id)
        for bp in bps:
            sb.from_("shadow_recommendations").insert({
                "workspace_id": workspace_id,
                "kind": RecommendationKind.BUDGET_PROTECTION.value,
                "headline": f"{bp.spike_count} spike events. Circuit breaker would have saved ~${bp.prevented_cost_cents / 100:.0f}",
                "detail": f"Detected {bp.spike_count} hours exceeding 3x the hourly average (${bp.avg_hourly_cents / 100:.2f}/hr). A circuit breaker would have prevented ${bp.prevented_cost_cents / 100:.2f} in overspend.",
                "estimated_value_cents": bp.prevented_cost_cents,
                "metadata": {"spike_count": bp.spike_count, "total_spike_cost_cents": bp.total_spike_cost_cents, "avg_hourly_cents": bp.avg_hourly_cents},
            }).execute()


def list_for_workspace(workspace_id: str) -> list[dict]:
    """Return unresponded shadow_recommendations ordered by estimated_value_cents desc."""
    sb = sb_service()
    result = sb.from_("shadow_recommendations").select("id, kind, headline, detail, estimated_value_cents, metadata, created_at").eq("workspace_id", workspace_id).is_("user_response", "null").order("estimated_value_cents", desc=True).execute()
    return result.data or []
