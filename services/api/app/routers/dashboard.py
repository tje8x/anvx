from datetime import date, datetime, timezone
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
