"""Cross-bucket recommendation engine for token economy optimisation."""
import logging
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from engine.models import FinancialRecord, Recommendation, SpendCategory

logger = logging.getLogger(__name__)

# Thresholds
_SHORT_IO_INPUT_TOKENS = 500
_SHORT_IO_OUTPUT_TOKENS = 200
_EXPENSIVE_MODELS = {"gpt-4o", "claude-sonnet", "claude-opus"}
_CHEAP_ALTERNATIVES = {
    "gpt-4o": "gpt-4o-mini",
    "claude-sonnet": "claude-haiku",
    "claude-opus": "claude-sonnet",
}
_INACTIVE_DAYS = 30
_AI_REVENUE_RATIO_WARNING = Decimal("0.30")  # 30%


def generate_recommendations(
    records: list[FinancialRecord],
    as_of: date | None = None,
) -> list[Recommendation]:
    """Analyse records across all buckets and generate optimisation recommendations.

    Checks:
      1. Model routing — expensive models used for short input/output tasks
      2. Unused subscriptions — SaaS with no records in 30+ days
      3. Cross-bucket — AI costs as % of revenue (if Stripe data present)

    Args:
        records: All financial records across all connectors.
        as_of: Reference date for "inactive" checks. Defaults to today.

    Returns:
        List of Recommendation objects sorted by estimated savings (highest first).
    """
    if not records:
        return []

    if as_of is None:
        as_of = date.today()

    recommendations: list[Recommendation] = []

    recommendations.extend(_check_model_routing(records))
    recommendations.extend(_check_unused_subscriptions(records, as_of))
    recommendations.extend(_check_ai_revenue_ratio(records, as_of))

    # Sort by estimated savings descending (None last)
    recommendations.sort(
        key=lambda r: r.estimated_monthly_savings or Decimal("0"),
        reverse=True,
    )
    return recommendations


def _check_model_routing(records: list[FinancialRecord]) -> list[Recommendation]:
    """Flag expensive model usage on short-context tasks."""
    recs: list[Recommendation] = []

    # Group AI inference records by model
    by_model: dict[str, list[FinancialRecord]] = defaultdict(list)
    for r in records:
        if r.category == SpendCategory.AI_INFERENCE and r.model:
            by_model[r.model].append(r)

    for model_name, model_records in by_model.items():
        if model_name not in _EXPENSIVE_MODELS:
            continue

        # Count records with short I/O (likely simple tasks)
        short_io_records = [
            r for r in model_records
            if r.tokens_input is not None
            and r.tokens_output is not None
            and r.tokens_input < _SHORT_IO_INPUT_TOKENS
            and r.tokens_output < _SHORT_IO_OUTPUT_TOKENS
        ]

        if not short_io_records:
            continue

        short_ratio = len(short_io_records) / len(model_records)
        if short_ratio < 0.1:
            continue

        short_io_cost = sum(abs(r.amount) for r in short_io_records)
        # Cheaper model is roughly 10-20x less expensive for short tasks
        estimated_savings = (short_io_cost * Decimal("0.85")).quantize(Decimal("0.01"))
        # Scale to monthly estimate (use 30-day window from records)
        if model_records:
            date_range = (
                max(r.record_date for r in model_records)
                - min(r.record_date for r in model_records)
            ).days or 1
            monthly_factor = Decimal("30") / Decimal(str(date_range))
            estimated_savings = (estimated_savings * monthly_factor).quantize(Decimal("0.01"))

        cheap_alt = _CHEAP_ALTERNATIVES.get(model_name, "a cheaper model")

        recs.append(
            Recommendation(
                rec_type="model_routing",
                description=(
                    f"{len(short_io_records)} calls to {model_name} "
                    f"({short_ratio:.0%} of usage) had short input/output, "
                    f"suggesting simple tasks that could use {cheap_alt}"
                ),
                estimated_monthly_savings=estimated_savings,
                confidence="high" if short_ratio > 0.3 else "medium",
                action_required=(
                    f"Route simple requests (short context) to {cheap_alt} "
                    f"instead of {model_name}"
                ),
                category=SpendCategory.AI_INFERENCE,
            )
        )

    return recs


def _check_unused_subscriptions(
    records: list[FinancialRecord], as_of: date
) -> list[Recommendation]:
    """Flag SaaS subscriptions with no activity in 30+ days."""
    recs: list[Recommendation] = []

    # Group SaaS records by subcategory/source
    saas_records: dict[str, list[FinancialRecord]] = defaultdict(list)
    for r in records:
        if r.category == SpendCategory.SAAS_SUBSCRIPTION:
            key = r.subcategory or r.source
            saas_records[key].append(r)

    cutoff = as_of - timedelta(days=_INACTIVE_DAYS)

    for service_name, service_records in saas_records.items():
        last_record = max(r.record_date for r in service_records)
        if last_record >= cutoff:
            continue

        days_inactive = (as_of - last_record).days
        # Estimate monthly cost from available records
        total_cost = sum(abs(r.amount) for r in service_records)
        date_span = (
            max(r.record_date for r in service_records)
            - min(r.record_date for r in service_records)
        ).days or 1
        monthly_cost = (total_cost * Decimal("30") / Decimal(str(date_span))).quantize(
            Decimal("0.01")
        )

        recs.append(
            Recommendation(
                rec_type="unused_subscription",
                description=(
                    f"No activity from '{service_name}' in {days_inactive} days. "
                    f"Estimated ~${monthly_cost}/month"
                ),
                estimated_monthly_savings=monthly_cost,
                confidence="medium",
                action_required=(
                    f"Review whether '{service_name}' subscription is still needed. "
                    f"Cancel or downgrade if unused."
                ),
                category=SpendCategory.SAAS_SUBSCRIPTION,
            )
        )

    return recs


def _check_ai_revenue_ratio(
    records: list[FinancialRecord], as_of: date
) -> list[Recommendation]:
    """Flag if AI inference costs exceed a threshold of total revenue."""
    recs: list[Recommendation] = []

    # Use last 30 days for ratio calculation
    period_start = as_of - timedelta(days=30)
    recent = [r for r in records if r.record_date >= period_start]

    ai_cost = sum(
        abs(r.amount)
        for r in recent
        if r.category in (SpendCategory.AI_INFERENCE, SpendCategory.AI_TRAINING)
    )
    revenue = sum(
        r.amount
        for r in recent
        if r.category == SpendCategory.REVENUE
    )

    if revenue <= 0 or ai_cost <= 0:
        return recs

    ratio = ai_cost / revenue

    if ratio > _AI_REVENUE_RATIO_WARNING:
        ratio_pct = f"{float(ratio) * 100:.1f}%"
        recs.append(
            Recommendation(
                rec_type="ai_revenue_ratio",
                description=(
                    f"AI costs are {ratio_pct} of revenue "
                    f"(${ai_cost:.2f} AI spend vs ${revenue:.2f} revenue "
                    f"over last 30 days). Target is under "
                    f"{float(_AI_REVENUE_RATIO_WARNING) * 100:.0f}%."
                ),
                estimated_monthly_savings=(
                    (ai_cost - revenue * _AI_REVENUE_RATIO_WARNING).quantize(Decimal("0.01"))
                ),
                confidence="high",
                action_required=(
                    "Review AI model usage patterns and consider: "
                    "routing to cheaper models, caching frequent queries, "
                    "or batching requests to reduce per-call overhead"
                ),
                category=SpendCategory.AI_INFERENCE,
            )
        )

    return recs
