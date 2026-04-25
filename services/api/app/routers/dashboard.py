from datetime import date, datetime, timedelta, timezone
from threading import Lock
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ..attribution import attribution_for_period
from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


CACHE_TTL_SECONDS = 60
_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}
_CACHE_LOCK = Lock()
_METRICS_CACHE: dict[str, tuple[float, dict]] = {}
_METRICS_LOCK = Lock()
_IS_CACHE: dict[tuple[str, int, str], tuple[float, dict]] = {}
_IS_LOCK = Lock()


COGS_CODES = [
    ("5010", "LLM inference"),
    ("5020", "Cloud"),
    ("5030", "Third-party APIs"),
]
OPEX_CODES = [
    ("6010", "Dev tools"),
    ("6020", "Monitoring"),
    ("6030", "Payment processing"),
    ("6040", "Other SaaS"),
    ("6050", "Payroll"),
    ("6060", "Rent & office"),
]


def _parse_month(month: str) -> tuple[date, date]:
    try:
        start = datetime.strptime(month, "%Y-%m").date()
    except ValueError:
        raise HTTPException(400, "month must be YYYY-MM")
    if start.month == 12:
        end = date(start.year + 1, 1, 1)
    else:
        end = date(start.year, start.month + 1, 1)
    return start, end


def _revenue_cents(workspace_id: str, start: date, end: date) -> int:
    sb = sb_service()

    coa_rows = (
        sb.from_("chart_of_accounts")
        .select("id")
        .eq("workspace_id", workspace_id)
        .eq("kind", "revenue")
        .execute()
    ).data or []
    revenue_coa_ids = [r["id"] for r in coa_rows]
    if not revenue_coa_ids:
        return 0

    cats = (
        sb.from_("reconciliation_categorizations")
        .select("document_transaction_id, category_id")
        .eq("workspace_id", workspace_id)
        .in_("category_id", revenue_coa_ids)
        .execute()
    ).data or []
    txn_ids = [c["document_transaction_id"] for c in cats]
    if not txn_ids:
        return 0

    txns = (
        sb.from_("document_transactions")
        .select("id, amount_cents, txn_date")
        .eq("workspace_id", workspace_id)
        .in_("id", txn_ids)
        .gte("txn_date", start.isoformat())
        .lt("txn_date", end.isoformat())
        .execute()
    ).data or []

    total = 0
    for t in txns:
        amt = int(t.get("amount_cents") or 0)
        if amt > 0:
            total += amt
    return total


def _waterfall_payload(workspace_id: str, month: str) -> dict[str, Any]:
    start, end = _parse_month(month)

    breakdown = attribution_for_period(workspace_id, start, end)
    by_cat: dict[str, int] = breakdown.get("by_category", {}) or {}
    revenue = _revenue_cents(workspace_id, start, end)

    cogs_stages = [
        {"label": label, "kind": "decrease", "value_cents": int(by_cat.get(code, 0))}
        for code, label in COGS_CODES
    ]
    cogs_total = sum(s["value_cents"] for s in cogs_stages)
    gross_profit = revenue - cogs_total

    opex_stages = [
        {"label": label, "kind": "decrease", "value_cents": int(by_cat.get(code, 0))}
        for code, label in OPEX_CODES
    ]
    opex_total = sum(s["value_cents"] for s in opex_stages)
    ebitda = gross_profit - opex_total

    tax = int(round(ebitda * 0.25)) if ebitda > 0 else 0
    net_income = ebitda - tax

    stages = [
        {"label": "Revenue", "kind": "total", "value_cents": revenue},
        *cogs_stages,
        {"label": "Gross Profit", "kind": "total", "value_cents": gross_profit},
        *opex_stages,
        {"label": "EBITDA", "kind": "total", "value_cents": ebitda},
        {"label": "Tax", "kind": "decrease", "value_cents": tax},
        {"label": "Net Income", "kind": "total", "value_cents": net_income},
    ]

    return {
        "month": month,
        "currency": "USD",
        "has_revenue": revenue > 0,
        "stages": stages,
    }


REVENUE_CODES = [("4010", "SaaS subscriptions"), ("4020", "API usage"), ("4030", "Crypto payments")]


def _month_bounds(today: date) -> tuple[date, date, date, date]:
    """Return (current_start, current_end_exclusive, prior_start, prior_end_exclusive).

    current_end_exclusive is today + 1 day (so today is included).
    prior window mirrors the same day-of-month span in the previous month.
    """
    current_start = today.replace(day=1)
    current_end = today + timedelta(days=1)

    if current_start.month == 1:
        prior_start = current_start.replace(year=current_start.year - 1, month=12)
    else:
        prior_start = current_start.replace(month=current_start.month - 1)

    # Prior window: same day-of-month, capped to the prior month length.
    last_day_prior_month = (current_start - timedelta(days=1)).day
    prior_dom = min(today.day, last_day_prior_month)
    prior_end = prior_start.replace(day=prior_dom) + timedelta(days=1)
    return current_start, current_end, prior_start, prior_end


def _revenue_for_window(workspace_id: str, start: date, end: date) -> int:
    """Same shape as _revenue_cents but parameterised by window."""
    sb = sb_service()

    coa_rows = (
        sb.from_("chart_of_accounts").select("id")
        .eq("workspace_id", workspace_id).eq("kind", "revenue").execute()
    ).data or []
    revenue_coa_ids = [r["id"] for r in coa_rows]
    if not revenue_coa_ids:
        return 0

    cats = (
        sb.from_("reconciliation_categorizations").select("document_transaction_id, category_id")
        .eq("workspace_id", workspace_id).in_("category_id", revenue_coa_ids).execute()
    ).data or []
    txn_ids = [c["document_transaction_id"] for c in cats]
    if not txn_ids:
        return 0

    txns = (
        sb.from_("document_transactions").select("id, amount_cents, txn_date")
        .eq("workspace_id", workspace_id).in_("id", txn_ids)
        .gte("txn_date", start.isoformat()).lt("txn_date", end.isoformat()).execute()
    ).data or []
    total = 0
    for t in txns:
        amt = int(t.get("amount_cents") or 0)
        if amt > 0:
            total += amt
    return total


def _revenue_by_code_for_window(workspace_id: str, start: date, end: date) -> dict[str, int]:
    """Sum positive amount_cents bucketed by chart_of_accounts.code (revenue codes only)."""
    sb = sb_service()

    coa = (
        sb.from_("chart_of_accounts").select("id, code")
        .eq("workspace_id", workspace_id).eq("kind", "revenue").execute()
    ).data or []
    if not coa:
        return {}
    code_by_id = {r["id"]: r["code"] for r in coa}
    revenue_coa_ids = list(code_by_id.keys())

    cats = (
        sb.from_("reconciliation_categorizations").select("document_transaction_id, category_id")
        .eq("workspace_id", workspace_id).in_("category_id", revenue_coa_ids).execute()
    ).data or []
    if not cats:
        return {}
    cat_for_txn = {c["document_transaction_id"]: c["category_id"] for c in cats}
    txn_ids = list(cat_for_txn.keys())

    txns = (
        sb.from_("document_transactions").select("id, amount_cents, txn_date")
        .eq("workspace_id", workspace_id).in_("id", txn_ids)
        .gte("txn_date", start.isoformat()).lt("txn_date", end.isoformat()).execute()
    ).data or []

    out: dict[str, int] = {}
    for t in txns:
        amt = int(t.get("amount_cents") or 0)
        if amt <= 0:
            continue
        code = code_by_id.get(cat_for_txn.get(t["id"]))
        if code:
            out[code] = out.get(code, 0) + amt
    return out


def _savings_for_window(workspace_id: str, start: date, end: date) -> int:
    """Compute realized savings from rerouted/downgraded routing records.

    For each record, savings = (would_have_paid) − provider_cost_cents,
    where would_have_paid is computed from the originally requested model's
    pricing table. Sum, clamp at >= 0.
    """
    sb = sb_service()

    start_iso = datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    end_iso = datetime.combine(end, datetime.min.time(), tzinfo=timezone.utc).isoformat()

    rows = (
        sb.from_("routing_usage_records")
        .select("provider, model_requested, tokens_in, tokens_out, provider_cost_cents, decision")
        .eq("workspace_id", workspace_id)
        .gte("created_at", start_iso)
        .lt("created_at", end_iso)
        .in_("decision", ["downgraded", "rerouted"])
        .execute()
    ).data or []

    if not rows:
        return 0

    keys = list({(r["provider"], r["model_requested"]) for r in rows})
    if not keys:
        return 0

    providers = list({k[0] for k in keys})
    models = list({k[1] for k in keys})
    try:
        price_rows = (
            sb.from_("models")
            .select("provider, model, input_price_per_mtok_cents, output_price_per_mtok_cents")
            .in_("provider", providers)
            .in_("model", models)
            .execute()
        ).data or []
    except Exception:
        return 0

    prices = {(p["provider"], p["model"]): p for p in price_rows}

    savings = 0
    for r in rows:
        price = prices.get((r["provider"], r["model_requested"]))
        if not price:
            continue
        in_p = int(price.get("input_price_per_mtok_cents") or 0)
        out_p = int(price.get("output_price_per_mtok_cents") or 0)
        tin = int(r.get("tokens_in") or 0)
        tout = int(r.get("tokens_out") or 0)
        would_have = (tin * in_p + tout * out_p) // 1_000_000
        cost = int(r.get("provider_cost_cents") or 0)
        delta = would_have - cost
        if delta > 0:
            savings += delta

    return max(0, savings)


@router.get("/dashboard/metrics")
async def dashboard_metrics(ctx: WorkspaceContext = Depends(require_role("member"))):
    now_ts = datetime.now(timezone.utc).timestamp()
    with _METRICS_LOCK:
        cached = _METRICS_CACHE.get(ctx.workspace_id)
        if cached and now_ts - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]

    today = datetime.now(timezone.utc).date()
    cur_start, cur_end, prior_start, prior_end = _month_bounds(today)

    revenue_mtd = _revenue_for_window(ctx.workspace_id, cur_start, cur_end)
    revenue_prior = _revenue_for_window(ctx.workspace_id, prior_start, prior_end)

    spend_mtd = attribution_for_period(ctx.workspace_id, cur_start, cur_end).get("total_cents", 0)
    spend_prior = attribution_for_period(ctx.workspace_id, prior_start, prior_end).get("total_cents", 0)

    net_income = revenue_mtd - spend_mtd
    net_margin = round((net_income / revenue_mtd) * 100, 2) if revenue_mtd > 0 else None

    def _mom(cur: int, prior: int) -> float | None:
        if prior == 0:
            return None
        return round(((cur - prior) / prior) * 100, 2)

    savings = _savings_for_window(ctx.workspace_id, cur_start, cur_end)

    payload = {
        "revenue_mtd_cents": revenue_mtd,
        "revenue_mtd_mom_pct": _mom(revenue_mtd, revenue_prior),
        "net_income_mtd_cents": net_income,
        "net_margin_mtd_pct": net_margin,
        "total_spend_mtd_cents": spend_mtd,
        "total_spend_mtd_mom_pct": _mom(spend_mtd, spend_prior),
        "anvx_savings_realized_cents": savings,
    }

    with _METRICS_LOCK:
        _METRICS_CACHE[ctx.workspace_id] = (now_ts, payload)

    return payload


def _last_n_complete_months(today: date, n: int) -> list[date]:
    """Return the first day of each of the last N complete months, oldest first."""
    first_of_current = today.replace(day=1)
    months: list[date] = []
    cursor = first_of_current
    for _ in range(n):
        if cursor.month == 1:
            cursor = cursor.replace(year=cursor.year - 1, month=12)
        else:
            cursor = cursor.replace(month=cursor.month - 1)
        months.append(cursor)
    months.reverse()
    return months


def _last_n_months_ending(end_month_start: date, n: int) -> list[date]:
    """Return the first day of each of N months ending at end_month_start (inclusive), oldest first."""
    months: list[date] = [end_month_start]
    cursor = end_month_start
    for _ in range(n - 1):
        if cursor.month == 1:
            cursor = cursor.replace(year=cursor.year - 1, month=12)
        else:
            cursor = cursor.replace(month=cursor.month - 1)
        months.append(cursor)
    months.reverse()
    return months


def _next_month_start(d: date) -> date:
    return date(d.year + 1, 1, 1) if d.month == 12 else date(d.year, d.month + 1, 1)


@router.get("/dashboard/income-statement")
async def income_statement(
    months: int = Query(3, ge=1, le=12),
    end_month: str | None = Query(None, description="rightmost column month (YYYY-MM); defaults to last complete month"),
    ctx: WorkspaceContext = Depends(require_role("member")),
):
    cache_key = (ctx.workspace_id, months, end_month or "")
    now_ts = datetime.now(timezone.utc).timestamp()
    with _IS_LOCK:
        cached = _IS_CACHE.get(cache_key)
        if cached and now_ts - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]

    today = datetime.now(timezone.utc).date()
    if end_month:
        try:
            end_start = datetime.strptime(end_month, "%Y-%m").date()
        except ValueError:
            raise HTTPException(400, "end_month must be YYYY-MM")
        month_starts = _last_n_months_ending(end_start, months)
    else:
        month_starts = _last_n_complete_months(today, months)
    columns = [m.strftime("%Y-%m") for m in month_starts]

    revenue_by_code: list[dict[str, int]] = []
    by_category_per_month: list[dict[str, int]] = []
    for ms in month_starts:
        me = _next_month_start(ms)
        revenue_by_code.append(_revenue_by_code_for_window(ctx.workspace_id, ms, me))
        by_category_per_month.append(
            attribution_for_period(ctx.workspace_id, ms, me).get("by_category", {}) or {}
        )

    def _detail_revenue(code: str) -> list[int]:
        return [int(r.get(code, 0)) for r in revenue_by_code]

    def _detail_by_cat(code: str) -> list[int]:
        return [int(c.get(code, 0)) for c in by_category_per_month]

    revenue_details = [
        {"label": f"  {label}", "kind": "detail", "values": _detail_revenue(code)}
        for code, label in REVENUE_CODES
    ]
    revenue_section = [
        sum(d["values"][i] for d in revenue_details) for i in range(len(columns))
    ]

    cogs_details = [
        {"label": f"  {label}", "kind": "detail", "values": _detail_by_cat(code)}
        for code, label in COGS_CODES
    ]
    cogs_section = [sum(d["values"][i] for d in cogs_details) for i in range(len(columns))]

    opex_details = [
        {"label": f"  {label}", "kind": "detail", "values": _detail_by_cat(code)}
        for code, label in OPEX_CODES
    ]
    opex_section = [sum(d["values"][i] for d in opex_details) for i in range(len(columns))]

    gross_profit = [revenue_section[i] - cogs_section[i] for i in range(len(columns))]
    ebitda = [gross_profit[i] - opex_section[i] for i in range(len(columns))]
    tax = [int(round(v * 0.25)) if v > 0 else 0 for v in ebitda]
    net_income = [ebitda[i] - tax[i] for i in range(len(columns))]

    rows = [
        {"label": "Revenue", "kind": "section", "values": revenue_section},
        *revenue_details,
        {"label": "COGS", "kind": "section", "values": cogs_section},
        *cogs_details,
        {"label": "Gross Profit", "kind": "subtotal", "values": gross_profit},
        {"label": "OpEx", "kind": "section", "values": opex_section},
        *opex_details,
        {"label": "EBITDA", "kind": "subtotal", "values": ebitda},
        {"label": "  Tax", "kind": "detail", "values": tax},
        {"label": "Net Income", "kind": "subtotal", "values": net_income},
    ]

    payload = {"columns": columns, "rows": rows}

    with _IS_LOCK:
        _IS_CACHE[cache_key] = (now_ts, payload)

    return payload


@router.get("/dashboard/waterfall")
async def waterfall(
    month: str = Query(..., description="Month in YYYY-MM format"),
    ctx: WorkspaceContext = Depends(require_role("member")),
):
    key = (ctx.workspace_id, month)
    now = datetime.now(timezone.utc).timestamp()

    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]

    payload = _waterfall_payload(ctx.workspace_id, month)

    with _CACHE_LOCK:
        _CACHE[key] = (now, payload)

    return payload
