"""Insight generator — analyzes workspace spending and surfaces actionable findings."""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum

from .db import sb_service


class InsightKind(str, Enum):
    TOP_CONCENTRATION = "top_concentration"
    COST_SPIKE = "cost_spike"
    MODEL_DOWNGRADE_CANDIDATE = "model_downgrade_candidate"
    DORMANT_SUBSCRIPTION = "dormant_subscription"
    RUNWAY_PROJECTION = "runway_projection"


@dataclass
class Insight:
    kind: InsightKind
    headline: str
    detail: str
    value_cents: int
    evidence_usage_ids: list[str] = field(default_factory=list)


def top_concentration(workspace_id: str, days: int = 30) -> Insight | None:
    sb = sb_service()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    result = sb.from_("usage_records").select("id, provider, total_cost_cents_usd").eq("workspace_id", workspace_id).gte("ts", cutoff).execute()
    rows = result.data or []
    if not rows:
        return None

    by_provider: dict[str, int] = {}
    for r in rows:
        by_provider[r["provider"]] = by_provider.get(r["provider"], 0) + r["total_cost_cents_usd"]

    total = sum(by_provider.values())
    if total == 0:
        return None

    top_provider = max(by_provider, key=by_provider.get)
    top_amount = by_provider[top_provider]
    pct = top_amount / total * 100

    if pct < 40:
        return None

    evidence = [r["id"] for r in rows if r["provider"] == top_provider][:10]
    return Insight(
        kind=InsightKind.TOP_CONCENTRATION,
        headline=f"{top_provider} is {pct:.0f}% of your spend",
        detail=f"{top_provider} accounts for ${top_amount / 100:.2f} of ${total / 100:.2f} total over the last {days} days. Consider diversifying or negotiating volume pricing.",
        value_cents=top_amount,
        evidence_usage_ids=evidence,
    )


def cost_spike(workspace_id: str) -> Insight | None:
    sb = sb_service()
    now = datetime.now(timezone.utc)
    week_ago = (now - timedelta(days=7)).isoformat()
    four_weeks_ago = (now - timedelta(days=28)).isoformat()

    recent = sb.from_("usage_records").select("id, total_cost_cents_usd").eq("workspace_id", workspace_id).gte("ts", week_ago).execute()
    baseline = sb.from_("usage_records").select("total_cost_cents_usd").eq("workspace_id", workspace_id).gte("ts", four_weeks_ago).lt("ts", week_ago).execute()

    recent_rows = recent.data or []
    baseline_rows = baseline.data or []

    recent_total = sum(r["total_cost_cents_usd"] for r in recent_rows)
    baseline_total = sum(r["total_cost_cents_usd"] for r in baseline_rows)
    baseline_avg = baseline_total / 3 if baseline_total > 0 else 0

    if baseline_avg == 0 or recent_total == 0:
        return None

    pct_change = (recent_total - baseline_avg) / baseline_avg * 100
    if pct_change < 25:
        return None

    delta_cents = recent_total - round(baseline_avg)
    evidence = [r["id"] for r in recent_rows][:10]
    return Insight(
        kind=InsightKind.COST_SPIKE,
        headline=f"Spend is up {pct_change:.0f}% this week",
        detail=f"This week: ${recent_total / 100:.2f} vs 3-week avg: ${baseline_avg / 100:.2f}. That's ${delta_cents / 100:.2f} above normal.",
        value_cents=max(0, delta_cents),
        evidence_usage_ids=evidence,
    )


def model_downgrade_candidate(workspace_id: str) -> Insight | None:
    sb = sb_service()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    result = sb.from_("usage_records").select("id, model, input_tokens, output_tokens, total_cost_cents_usd").eq("workspace_id", workspace_id).gte("ts", cutoff).in_("model", ["gpt-4o", "claude-sonnet-4", "claude-3.5-sonnet", "claude-3-5-sonnet"]).execute()
    rows = result.data or []
    if not rows:
        return None

    simple_calls = [r for r in rows if (r.get("input_tokens") or 0) < 500 and (r.get("output_tokens") or 0) < 200]
    if len(simple_calls) < len(rows) * 0.5:
        return None

    total_cost = sum(r["total_cost_cents_usd"] for r in simple_calls)
    estimated_savings = round(total_cost * 0.85)  # ~85% cheaper on mini/haiku
    evidence = [r["id"] for r in simple_calls][:10]

    return Insight(
        kind=InsightKind.MODEL_DOWNGRADE_CANDIDATE,
        headline=f"{len(simple_calls)} simple calls could use a cheaper model",
        detail=f"{len(simple_calls)} of {len(rows)} frontier-model calls have <500 input and <200 output tokens. Routing these to gpt-4o-mini or haiku could save ~${estimated_savings / 100:.2f}/month.",
        value_cents=estimated_savings,
        evidence_usage_ids=evidence,
    )


def dormant_subscription(workspace_id: str) -> Insight | None:
    sb = sb_service()
    now = datetime.now(timezone.utc)
    thirty_days_ago = (now - timedelta(days=30)).isoformat()
    seven_days_ago = (now - timedelta(days=7)).isoformat()

    # Find provider_keys synced recently but with no recent usage
    keys_result = sb.from_("provider_keys").select("id, provider, label, last_used_at").eq("workspace_id", workspace_id).is_("deleted_at", "null").gte("last_used_at", seven_days_ago).execute()
    keys = keys_result.data or []
    if not keys:
        return None

    for key in keys:
        usage = sb.from_("usage_records").select("id").eq("workspace_id", workspace_id).eq("provider", key["provider"]).gte("ts", thirty_days_ago).limit(1).execute()
        if not (usage.data or []):
            return Insight(
                kind=InsightKind.DORMANT_SUBSCRIPTION,
                headline=f"{key['provider']} has no usage in 30 days",
                detail=f"Provider '{key['provider']}' (label: {key['label']}) was last synced recently but has no usage records in the last 30 days. Consider cancelling if unused.",
                value_cents=0,
                evidence_usage_ids=[],
            )

    return None


def runway_projection(workspace_id: str) -> Insight | None:
    sb = sb_service()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    result = sb.from_("usage_records").select("total_cost_cents_usd").eq("workspace_id", workspace_id).gte("ts", cutoff).execute()
    rows = result.data or []
    if not rows:
        return None

    total_30d = sum(r["total_cost_cents_usd"] for r in rows)
    projected = total_30d  # same window = same projection

    return Insight(
        kind=InsightKind.RUNWAY_PROJECTION,
        headline=f"Projected next-month spend: ${projected / 100:.2f}",
        detail=f"Based on the last 30 days (${total_30d / 100:.2f}), your projected next-month spend is ${projected / 100:.2f}.",
        value_cents=projected,
        evidence_usage_ids=[],
    )


def generate_all(workspace_id: str) -> list[Insight]:
    generators = [top_concentration, cost_spike, model_downgrade_candidate, dormant_subscription, runway_projection]
    insights: list[Insight] = []
    for gen in generators:
        try:
            result = gen(workspace_id)
            if result is not None:
                insights.append(result)
        except Exception:
            continue
    insights.sort(key=lambda i: i.value_cents, reverse=True)
    return insights
