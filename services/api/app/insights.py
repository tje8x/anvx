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
    meta: dict = field(default_factory=dict)
    next_action_url: str | None = None
    next_action_label: str | None = None


# ─── Shared rendering helpers ───────────────────────────────────────


def _confidence(days_in_window: int) -> str:
    if days_in_window >= 30:
        return "high"
    if days_in_window >= 7:
        return "medium"
    return "low"


def _format_period(start: datetime, end: datetime) -> str:
    if start.year == end.year and start.month == end.month:
        return start.strftime("%B %Y")
    return f"{start.strftime('%b %d, %Y')} – {end.strftime('%b %d, %Y')}"


def _data_window_days(rows: list[dict], ts_field: str = "ts") -> int:
    if not rows:
        return 0
    timestamps: list[datetime] = []
    for r in rows:
        v = r.get(ts_field)
        if not v:
            continue
        try:
            timestamps.append(datetime.fromisoformat(str(v).replace("Z", "+00:00")))
        except Exception:
            pass
    if not timestamps:
        return 0
    return max(1, (max(timestamps) - min(timestamps)).days + 1)


_DOWNGRADE_MAP = {
    "gpt-4o": "gpt-4o-mini",
    "claude-sonnet-4": "claude-haiku-3.5",
    "claude-3.5-sonnet": "claude-haiku-3.5",
    "claude-3-5-sonnet": "claude-haiku-3.5",
}


def top_concentration(workspace_id: str, days: int = 30) -> Insight | None:
    sb = sb_service()
    now = datetime.now(timezone.utc)
    cutoff_dt = now - timedelta(days=days)
    cutoff = cutoff_dt.isoformat()
    result = sb.from_("usage_records").select("id, ts, provider, total_cost_cents_usd").eq("workspace_id", workspace_id).gte("ts", cutoff).execute()
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
    window_days = _data_window_days(rows, "ts") or days
    return Insight(
        kind=InsightKind.TOP_CONCENTRATION,
        headline=f"{top_provider} is {pct:.0f}% of your AI spend (${top_amount / 100:,.0f} of ${total / 100:,.0f})",
        detail=(
            f"Over the last {days} days, {top_provider} took ${top_amount / 100:,.2f} out of "
            f"${total / 100:,.2f} total. A pricing change or outage there would hit "
            f"{pct:.0f}% of your AI cost. Routing some workloads to a second provider gives you "
            f"leverage and a fallback."
        ),
        value_cents=top_amount,
        evidence_usage_ids=evidence,
        meta={
            "concentration_pct": pct,
            "total_spend_cents": total,
            "top_provider": top_provider,
            "why_this_matters": {
                "data_source": "usage_records (provider-level cost from your connected API keys)",
                "formula": f"sum(cost) where provider = '{top_provider}' ÷ sum(cost) all providers",
                "period": _format_period(cutoff_dt, now),
                "confidence": _confidence(window_days),
            },
        },
        next_action_url="/routing",
        next_action_label="Set up routing rules",
    )


def cost_spike(workspace_id: str) -> Insight | None:
    sb = sb_service()
    now = datetime.now(timezone.utc)
    week_ago_dt = now - timedelta(days=7)
    four_weeks_ago_dt = now - timedelta(days=28)
    week_ago = week_ago_dt.isoformat()
    four_weeks_ago = four_weeks_ago_dt.isoformat()

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
    baseline_window_days = 21  # 3 weeks of baseline data
    return Insight(
        kind=InsightKind.COST_SPIKE,
        headline=f"AI spend jumped ${delta_cents / 100:,.0f} this week (+{pct_change:.0f}%)",
        detail=(
            f"You spent ${recent_total / 100:,.2f} in the last 7 days vs a 3-week average of "
            f"${baseline_avg / 100:,.2f}/week. That's ${delta_cents / 100:,.2f} above your "
            f"usual run rate. If this becomes the new normal, that's roughly "
            f"${(delta_cents * 4) / 100:,.0f}/month extra."
        ),
        value_cents=max(0, delta_cents),
        evidence_usage_ids=evidence,
        meta={
            "delta_cents": max(0, delta_cents),
            "baseline_avg_cents": round(baseline_avg),
            "why_this_matters": {
                "data_source": "usage_records (per-call cost from your connected API keys)",
                "formula": "sum(cost) last 7d − (sum(cost) prior 3 weeks ÷ 3)",
                "period": f"{_format_period(week_ago_dt, now)} vs {_format_period(four_weeks_ago_dt, week_ago_dt)}",
                "confidence": _confidence(baseline_window_days),
            },
        },
        next_action_url="/dashboard",
        next_action_label="Investigate this week's usage",
    )


def model_downgrade_candidate(workspace_id: str) -> Insight | None:
    sb = sb_service()
    now = datetime.now(timezone.utc)
    cutoff_dt = now - timedelta(days=30)
    cutoff = cutoff_dt.isoformat()
    result = sb.from_("usage_records").select("id, ts, model, input_tokens, output_tokens, total_cost_cents_usd").eq("workspace_id", workspace_id).gte("ts", cutoff).in_("model", list(_DOWNGRADE_MAP.keys())).execute()
    rows = result.data or []
    if not rows:
        return None

    simple_calls = [r for r in rows if (r.get("input_tokens") or 0) < 500 and (r.get("output_tokens") or 0) < 200]
    if len(simple_calls) < len(rows) * 0.5:
        return None

    total_cost = sum(r["total_cost_cents_usd"] for r in simple_calls)
    estimated_savings = round(total_cost * 0.85)  # ~85% cheaper on mini/haiku
    evidence = [r["id"] for r in simple_calls][:10]
    window_days = _data_window_days(rows, "ts") or 30

    # Build a "from → to" example line from the top model in simple_calls.
    model_counts: dict[str, int] = {}
    for r in simple_calls:
        m = r.get("model") or ""
        if m:
            model_counts[m] = model_counts.get(m, 0) + 1
    top_model = max(model_counts, key=model_counts.get) if model_counts else ""
    target_model = _DOWNGRADE_MAP.get(top_model, "a smaller model")
    swap_example = f"{top_model} → {target_model}" if top_model else "frontier → smaller model"

    return Insight(
        kind=InsightKind.MODEL_DOWNGRADE_CANDIDATE,
        headline=f"Save ~${estimated_savings / 100:,.0f}/mo by downgrading {len(simple_calls)} simple calls",
        detail=(
            f"{len(simple_calls)} of {len(rows)} frontier-model calls had <500 input and "
            f"<200 output tokens — small enough that a smaller model would handle them just as "
            f"well. Routing those to a cheaper tier ({swap_example}) saves ~"
            f"${estimated_savings / 100:,.2f}/month at current volume."
        ),
        value_cents=estimated_savings,
        evidence_usage_ids=evidence,
        meta={
            "estimated_monthly_savings_cents": estimated_savings,
            "candidate_count": len(simple_calls),
            "why_this_matters": {
                "data_source": "usage_records (per-call model + token counts)",
                "formula": "sum(cost) of frontier calls under 500 in/200 out × 85% (smaller-model price delta)",
                "period": _format_period(cutoff_dt, now),
                "confidence": _confidence(window_days),
            },
        },
        next_action_url="/routing",
        next_action_label="Configure routing rules",
    )


def dormant_subscription(workspace_id: str) -> Insight | None:
    sb = sb_service()
    now = datetime.now(timezone.utc)
    thirty_days_ago_dt = now - timedelta(days=30)
    seven_days_ago_dt = now - timedelta(days=7)
    thirty_days_ago = thirty_days_ago_dt.isoformat()
    seven_days_ago = seven_days_ago_dt.isoformat()

    # Find provider_keys synced recently but with no recent usage
    keys_result = sb.from_("provider_keys").select("id, provider, label, last_used_at").eq("workspace_id", workspace_id).is_("deleted_at", "null").gte("last_used_at", seven_days_ago).execute()
    keys = keys_result.data or []
    if not keys:
        return None

    for key in keys:
        usage = sb.from_("usage_records").select("id").eq("workspace_id", workspace_id).eq("provider", key["provider"]).gte("ts", thirty_days_ago).limit(1).execute()
        if not (usage.data or []):
            days_dormant = 30
            last = key.get("last_used_at")
            if last:
                try:
                    dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
                    days_dormant = max(0, (now - dt).days)
                except Exception:
                    pass
            provider = key["provider"]
            label = key.get("label") or provider
            return Insight(
                kind=InsightKind.DORMANT_SUBSCRIPTION,
                headline=f"{provider} key '{label}' hasn't been used in {days_dormant} days",
                detail=(
                    f"The '{label}' key on {provider} is still active but hasn't generated any "
                    f"calls in the last 30 days. If it's tied to a paid plan or seat, that's a "
                    f"clean cancellation. If it's a stale dev key, rotating or removing it tightens "
                    f"your security surface."
                ),
                value_cents=0,
                evidence_usage_ids=[],
                meta={
                    "days_dormant": days_dormant,
                    "monthly_spend_cents": 0,
                    "provider": provider,
                    "why_this_matters": {
                        "data_source": "provider_keys + usage_records (no calls observed against this key)",
                        "formula": "key.last_used_at recent AND zero usage_records in 30d",
                        "period": _format_period(thirty_days_ago_dt, now),
                        "confidence": _confidence(30),
                    },
                },
                next_action_url="/settings/connections",
                next_action_label="Review connection",
            )

    return None


def runway_projection(workspace_id: str) -> Insight | None:
    sb = sb_service()

    # Suppress entirely when no enabled monthly budget policy exists — without
    # a budget there's nothing to overrun, so the insight isn't actionable.
    policy_result = (
        sb.from_("budget_policies")
        .select("id, name, monthly_limit_cents")
        .eq("workspace_id", workspace_id)
        .eq("enabled", True)
        .not_.is_("monthly_limit_cents", "null")
        .execute()
    )
    policies = policy_result.data or []
    if not policies:
        return None

    # Use the strictest monthly budget (lowest limit) as the runway anchor.
    policy = min(policies, key=lambda p: p["monthly_limit_cents"])
    monthly_limit = int(policy["monthly_limit_cents"])
    policy_name = policy.get("name") or "monthly budget"

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    cutoff_30d_dt = now - timedelta(days=30)

    mtd = sb.from_("usage_records").select("total_cost_cents_usd").eq("workspace_id", workspace_id).gte("ts", month_start.isoformat()).execute()
    mtd_rows = mtd.data or []
    mtd_spend = sum(r["total_cost_cents_usd"] for r in mtd_rows)

    burn = sb.from_("usage_records").select("total_cost_cents_usd").eq("workspace_id", workspace_id).gte("ts", cutoff_30d_dt.isoformat()).execute()
    burn_rows = burn.data or []
    burn_30d = sum(r["total_cost_cents_usd"] for r in burn_rows)
    daily_burn = burn_30d / 30.0
    if daily_burn <= 0:
        return None

    remaining = monthly_limit - mtd_spend
    days_to_overrun: int | None
    if remaining <= 0:
        days_to_overrun = 0
    else:
        days_to_overrun = max(0, int(remaining // daily_burn))

    # Project end-of-month spend.
    days_in_month = (month_start.replace(month=month_start.month % 12 + 1) if month_start.month < 12 else month_start.replace(year=month_start.year + 1, month=1)) - month_start
    days_remaining_in_month = max(0, days_in_month.days - (now - month_start).days)
    projected_eom = mtd_spend + int(daily_burn * days_remaining_in_month)

    if days_to_overrun == 0:
        headline = f"You're already over your '{policy_name}' budget for {now.strftime('%B')}"
        detail = (
            f"Month-to-date spend is ${mtd_spend / 100:,.2f}, above your "
            f"${monthly_limit / 100:,.0f} '{policy_name}' limit. At your current burn rate of "
            f"${daily_burn / 100:,.2f}/day, you'll finish the month around "
            f"${projected_eom / 100:,.0f}."
        )
        action_label = "Review budget policy"
    elif days_to_overrun <= 30 - (now - month_start).days:
        headline = f"On track to overrun '{policy_name}' in {days_to_overrun} days"
        detail = (
            f"You've spent ${mtd_spend / 100:,.2f} of your ${monthly_limit / 100:,.0f} "
            f"'{policy_name}' budget so far this month. At ${daily_burn / 100:,.2f}/day, "
            f"you'll hit the limit in {days_to_overrun} days — projected end-of-month "
            f"${projected_eom / 100:,.0f}."
        )
        action_label = "Adjust budget or spend"
    else:
        headline = f"On pace to finish {now.strftime('%B')} at ${projected_eom / 100:,.0f} (${monthly_limit / 100:,.0f} budget)"
        detail = (
            f"You've spent ${mtd_spend / 100:,.2f} so far this month against your "
            f"${monthly_limit / 100:,.0f} '{policy_name}' budget. At ${daily_burn / 100:,.2f}/day, "
            f"you'll land around ${projected_eom / 100:,.0f} — comfortably under."
        )
        action_label = "View dashboard"

    return Insight(
        kind=InsightKind.RUNWAY_PROJECTION,
        headline=headline,
        detail=detail,
        value_cents=max(0, projected_eom),
        evidence_usage_ids=[],
        meta={
            "projected_monthly_cents": projected_eom,
            "days_to_overrun": days_to_overrun,
            "monthly_limit_cents": monthly_limit,
            "mtd_spend_cents": mtd_spend,
            "daily_burn_cents": int(daily_burn),
            "policy_name": policy_name,
            "why_this_matters": {
                "data_source": "budget_policies (your limit) + usage_records (month-to-date and 30-day burn)",
                "formula": "(monthly_limit − month_to_date_spend) ÷ (last 30 days spend ÷ 30)",
                "period": f"{_format_period(month_start, now)} vs ${monthly_limit / 100:,.0f} limit",
                "confidence": _confidence(_data_window_days(burn_rows, "ts") if burn_rows and "ts" in (burn_rows[0] or {}) else 30),
            },
        },
        next_action_url="/settings/policies",
        next_action_label=action_label,
    )


# ─── Felt-value scoring + top-pick selection ────────────────────────


def compute_felt_value_score(insight: "Insight") -> float:
    """How much the user will *feel* this insight is worth surfacing.

    Per-kind formula reads from `insight.meta` with a fallback to
    `insight.value_cents` when the structured field isn't present.
    """
    m = insight.meta or {}
    if insight.kind == InsightKind.TOP_CONCENTRATION:
        pct = float(m.get("concentration_pct") or 0.0)
        total = float(m.get("total_spend_cents") or insight.value_cents)
        return (pct / 100.0) * total

    if insight.kind == InsightKind.COST_SPIKE:
        delta = float(m.get("delta_cents") or insight.value_cents)
        return delta * 2.0

    if insight.kind == InsightKind.MODEL_DOWNGRADE_CANDIDATE:
        savings = float(m.get("estimated_monthly_savings_cents") or insight.value_cents)
        return savings * 3.0

    if insight.kind == InsightKind.DORMANT_SUBSCRIPTION:
        days_idle = float(m.get("days_dormant") or 0)
        monthly = float(m.get("monthly_spend_cents") or 0)
        multiplier = min(days_idle / 30.0, 3.0)
        return monthly * multiplier

    if insight.kind == InsightKind.RUNWAY_PROJECTION:
        days = m.get("days_to_overrun")
        if days is None:
            urgency = 0.5
        elif days <= 7:
            urgency = 5.0
        elif days <= 14:
            urgency = 3.0
        elif days <= 30:
            urgency = 1.5
        else:
            urgency = 0.5
        return urgency * 100_000.0

    return 0.0


def _passes_top_guard(insight: "Insight") -> bool:
    """Top insight must have either a positive dollar figure or a deeplink."""
    if (insight.value_cents or 0) > 0:
        return True
    if insight.next_action_url:
        return True
    return False


def _top_concentration_fallback(workspace_id: str) -> "Insight | None":
    """Unfiltered TOP_CONCENTRATION (no 40% cutoff). Always has a dollar
    figure as long as the workspace has any usage data at all.
    """
    sb = sb_service()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
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
    return Insight(
        kind=InsightKind.TOP_CONCENTRATION,
        headline=f"{top_provider} is {pct:.0f}% of your spend",
        detail=f"{top_provider} accounts for ${top_amount / 100:.2f} of ${total / 100:.2f} total over the last 30 days.",
        value_cents=top_amount,
        evidence_usage_ids=[r["id"] for r in rows if r["provider"] == top_provider][:10],
        meta={"concentration_pct": pct, "total_spend_cents": total, "top_provider": top_provider, "fallback": True},
        next_action_url="/routing",
    )


def pick_top_insight(workspace_id: str, insights: list["Insight"]) -> "Insight | None":
    """Sort by felt-value score and return the top insight that passes the guard.
    Falls back to an unfiltered TOP_CONCENTRATION if no candidate qualifies.
    """
    if insights:
        ranked = sorted(insights, key=compute_felt_value_score, reverse=True)
        for ins in ranked:
            if _passes_top_guard(ins):
                return ins
    return _top_concentration_fallback(workspace_id)


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
    insights.sort(key=compute_felt_value_score, reverse=True)
    return insights
