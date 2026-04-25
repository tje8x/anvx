"""Cross-source spend attribution.

Rolls up spend from routing_usage_records, connector usage_records, and
document_transactions into a single breakdown without double-counting.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from .db import sb_service


CATEGORY_LLM_INFERENCE = "5010"
CATEGORY_CLOUD_INFRA = "5020"
CATEGORY_OTHER_SAAS = "6040"

CLOUD_PROVIDERS = {"aws", "vercel", "gcp", "google_cloud", "cloudflare"}


def _to_cents(v) -> int:
    return int(v or 0)


def _parse_iso_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _parse_iso_date(v) -> date | None:
    if isinstance(v, date) and not isinstance(v, datetime):
        return v
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, str):
        try:
            return date.fromisoformat(v[:10])
        except ValueError:
            return None
    return None


def attribution_for_period(workspace_id: str, start: date, end: date) -> dict:
    """Return cross-source spend breakdown for [start, end) (half-open).

    See module docstring for de-dup rules.
    """
    sb = sb_service()

    start_iso = start.isoformat()
    end_iso = end.isoformat()
    start_dt_iso = datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    end_dt_iso = datetime.combine(end, datetime.min.time(), tzinfo=timezone.utc).isoformat()

    by_source: dict[str, int] = {"routing": 0, "connectors": 0, "documents": 0}
    by_category: dict[str, int] = defaultdict(int)

    # ── 1. Routing source ─────────────────────────────────────────
    routing_rows = (
        sb.from_("routing_usage_records")
        .select("id, provider, provider_cost_cents, created_at")
        .eq("workspace_id", workspace_id)
        .gte("created_at", start_dt_iso)
        .lt("created_at", end_dt_iso)
        .execute()
    ).data or []

    routing_provider_days: set[tuple[str, date]] = set()
    for r in routing_rows:
        cents = _to_cents(r.get("provider_cost_cents"))
        by_source["routing"] += cents
        by_category[CATEGORY_LLM_INFERENCE] += cents
        d = _parse_iso_dt(r["created_at"]).date() if isinstance(r.get("created_at"), str) else None
        if d is not None:
            routing_provider_days.add((r["provider"], d))

    # ── 2. Connector source ───────────────────────────────────────
    # TODO: when connector ingestion is wired up, usage_records will populate.
    # For now this branch is exercised against the existing usage_records table
    # (may be empty in dev), and gracefully returns 0.
    try:
        connector_rows = (
            sb.from_("usage_records")
            .select("id, provider, total_cost_cents_usd, ts")
            .eq("workspace_id", workspace_id)
            .gte("ts", start_dt_iso)
            .lt("ts", end_dt_iso)
            .execute()
        ).data or []
    except Exception:
        connector_rows = []

    for r in connector_rows:
        provider = (r.get("provider") or "").lower()
        ts_d = _parse_iso_dt(r["ts"]).date() if isinstance(r.get("ts"), str) else None
        if ts_d is not None and (provider, ts_d) in routing_provider_days:
            continue  # already counted via routing source — skip
        cents = _to_cents(r.get("total_cost_cents_usd"))
        if cents <= 0:
            continue
        by_source["connectors"] += cents
        code = CATEGORY_CLOUD_INFRA if provider in CLOUD_PROVIDERS else CATEGORY_OTHER_SAAS
        by_category[code] += cents

    # ── 3. Documents source ───────────────────────────────────────
    txns = (
        sb.from_("document_transactions")
        .select("id, amount_cents, txn_date")
        .eq("workspace_id", workspace_id)
        .gte("txn_date", start_iso)
        .lt("txn_date", end_iso)
        .execute()
    ).data or []

    if txns:
        txn_ids = [t["id"] for t in txns]

        cats_rows = (
            sb.from_("reconciliation_categorizations")
            .select("document_transaction_id, category_id")
            .eq("workspace_id", workspace_id)
            .in_("document_transaction_id", txn_ids)
            .execute()
        ).data or []
        match_rows = (
            sb.from_("reconciliation_matches")
            .select("document_transaction_id, source_kind, auto")
            .eq("workspace_id", workspace_id)
            .in_("document_transaction_id", txn_ids)
            .execute()
        ).data or []
        flag_rows = (
            sb.from_("reconciliation_flags")
            .select("document_transaction_id")
            .eq("workspace_id", workspace_id)
            .in_("document_transaction_id", txn_ids)
            .execute()
        ).data or []

        category_ids = list({c["category_id"] for c in cats_rows if c.get("category_id")})
        coa_lookup: dict[str, str] = {}
        if category_ids:
            coa_rows = (
                sb.from_("chart_of_accounts")
                .select("id, code")
                .eq("workspace_id", workspace_id)
                .in_("id", category_ids)
                .execute()
            ).data or []
            coa_lookup = {row["id"]: row["code"] for row in coa_rows}

        cat_by_txn = {c["document_transaction_id"]: c["category_id"] for c in cats_rows}
        match_by_txn = {m["document_transaction_id"]: m for m in match_rows}
        flagged_set = {f["document_transaction_id"] for f in flag_rows}

        flagged_count = 0
        flagged_amount_cents = 0

        for t in txns:
            txn_id = t["id"]
            amount_abs = abs(_to_cents(t.get("amount_cents")))

            if txn_id in flagged_set:
                flagged_count += 1
                flagged_amount_cents += amount_abs
                continue

            match = match_by_txn.get(txn_id)
            if match and match.get("source_kind") == "routing":
                continue  # already counted via routing source

            cat_id = cat_by_txn.get(txn_id)
            user_confirmed = bool(match and match.get("auto") is False)

            if not cat_id and not user_confirmed:
                continue

            if cat_id:
                code = coa_lookup.get(cat_id, CATEGORY_OTHER_SAAS)
            else:
                code = CATEGORY_OTHER_SAAS

            by_source["documents"] += amount_abs
            by_category[code] += amount_abs
    else:
        flagged_count = 0
        flagged_amount_cents = 0

    total_cents = sum(by_source.values())

    return {
        "total_cents": total_cents,
        "by_source": by_source,
        "by_category": dict(by_category),
        "flagged_count": flagged_count,
        "flagged_amount_cents": flagged_amount_cents,
    }
