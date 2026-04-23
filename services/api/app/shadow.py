"""Shadow-mode recommendation engine — computes routing opportunities and budget protections."""
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from uuid import uuid4

from .db import sb_service


class RecommendationKind(str, Enum):
    ROUTING_OPPORTUNITY = "routing_opportunity"
    BUDGET_PROTECTION = "budget_protection"


@dataclass
class RoutingOpportunity:
    id: str
    model_requested: str
    suggested_model: str
    request_count: int
    current_cost_cents: int
    projected_cost_cents: int
    savings_cents: int
    project_tag: str | None
    headline: str
    detail: str


@dataclass
class BudgetProtection:
    id: str
    spike_count: int
    total_spike_cost_cents: int
    prevented_cost_cents: int
    headline: str
    detail: str


@dataclass
class Recommendation:
    id: str
    kind: RecommendationKind
    headline: str
    detail: str
    savings_cents: int
    metadata: dict


# Approximate cost ratios for model substitution (cheaper / original)
_SUBSTITUTE_MAP: dict[str, tuple[str, float]] = {
    "gpt-4o": ("gpt-4o-mini", 0.06),
    "gpt-4.1": ("gpt-4.1-mini", 0.07),
    "claude-sonnet-4": ("claude-haiku-4", 0.05),
    "claude-3.5-sonnet": ("claude-3.5-haiku", 0.08),
    "claude-3-5-sonnet": ("claude-3.5-haiku", 0.08),
}

_WINDOW_DAYS = {"7d": 7, "30d": 30, "1d": 1}


def compute_routing_opportunities(workspace_id: str, window: str = "7d") -> list[RoutingOpportunity]:
    days = _WINDOW_DAYS.get(window, 7)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    sb = sb_service()
    result = sb.from_("routing_usage_records").select("model_requested, project_tag, provider_cost_cents").eq("workspace_id", workspace_id).gte("ts", cutoff).execute()
    rows = result.data or []

    if not rows:
        return []

    # Group by (model_requested, project_tag)
    clusters: dict[tuple[str, str | None], list[int]] = defaultdict(list)
    for r in rows:
        key = (r["model_requested"], r.get("project_tag"))
        clusters[key].append(r.get("provider_cost_cents", 0))

    opportunities: list[RoutingOpportunity] = []
    for (model, tag), costs in clusters.items():
        if model not in _SUBSTITUTE_MAP:
            continue

        substitute, cost_ratio = _SUBSTITUTE_MAP[model]
        current_total = sum(costs)
        projected_total = round(current_total * cost_ratio)
        savings = current_total - projected_total

        if savings <= 0:
            continue

        tag_label = f" (project: {tag})" if tag else ""
        opp_id = str(uuid4())
        opportunities.append(RoutingOpportunity(
            id=opp_id,
            model_requested=model,
            suggested_model=substitute,
            request_count=len(costs),
            current_cost_cents=current_total,
            projected_cost_cents=projected_total,
            savings_cents=savings,
            project_tag=tag,
            headline=f"{len(costs)} {model} requests could use {substitute}{tag_label} — est. ${savings / 100:.0f}/wk saved",
            detail=f"Current cost: ${current_total / 100:.2f}. With {substitute}: ${projected_total / 100:.2f}. Savings: ${savings / 100:.2f} over {days} days.",
        ))

    opportunities.sort(key=lambda o: o.savings_cents, reverse=True)
    return opportunities[:5]


def compute_budget_protections(workspace_id: str, window: str = "7d") -> list[BudgetProtection]:
    days = _WINDOW_DAYS.get(window, 7)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    sb = sb_service()
    result = sb.from_("routing_usage_records").select("ts, provider_cost_cents").eq("workspace_id", workspace_id).gte("ts", cutoff).order("ts").execute()
    rows = result.data or []

    if not rows:
        return []

    # Bucket into hourly windows
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

    # Compute average hourly spend
    total_hours = len(hourly)
    total_spend = sum(hourly.values())
    avg_hourly = total_spend / total_hours if total_hours > 0 else 0

    if avg_hourly == 0:
        return []

    # Find spike hours (>3x average)
    spike_threshold = avg_hourly * 3
    spike_hours: list[tuple[str, int]] = [(h, cost) for h, cost in hourly.items() if cost > spike_threshold]

    if not spike_hours:
        return []

    total_spike_cost = sum(cost for _, cost in spike_hours)
    # Circuit breaker would cap each hour at the threshold
    prevented = sum(cost - round(spike_threshold) for _, cost in spike_hours)

    bp_id = str(uuid4())
    return [BudgetProtection(
        id=bp_id,
        spike_count=len(spike_hours),
        total_spike_cost_cents=total_spike_cost,
        prevented_cost_cents=max(0, prevented),
        headline=f"{len(spike_hours)} spike events. Circuit breaker would have saved ~${prevented / 100:.0f}",
        detail=f"Detected {len(spike_hours)} hours where spend exceeded 3x the {days}-day hourly average (${avg_hourly / 100:.2f}/hr). Total spike cost: ${total_spike_cost / 100:.2f}. A circuit breaker capping at ${spike_threshold / 100:.2f}/hr would have prevented ${prevented / 100:.2f}.",
    )]


def list_shadow_recommendations(workspace_id: str) -> list[Recommendation]:
    recommendations: list[Recommendation] = []

    for opp in compute_routing_opportunities(workspace_id):
        recommendations.append(Recommendation(
            id=opp.id,
            kind=RecommendationKind.ROUTING_OPPORTUNITY,
            headline=opp.headline,
            detail=opp.detail,
            savings_cents=opp.savings_cents,
            metadata={"model_requested": opp.model_requested, "suggested_model": opp.suggested_model, "request_count": opp.request_count, "project_tag": opp.project_tag},
        ))

    for bp in compute_budget_protections(workspace_id):
        recommendations.append(Recommendation(
            id=bp.id,
            kind=RecommendationKind.BUDGET_PROTECTION,
            headline=bp.headline,
            detail=bp.detail,
            savings_cents=bp.prevented_cost_cents,
            metadata={"spike_count": bp.spike_count, "total_spike_cost_cents": bp.total_spike_cost_cents},
        ))

    recommendations.sort(key=lambda r: r.savings_cents, reverse=True)
    return recommendations
