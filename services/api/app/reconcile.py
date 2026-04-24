"""Auto-match reconciliation engine.

Matches parsed document_transactions against routing_usage_records using
vendor name aliases, amount proximity, and date proximity.

Entry point: match_document(workspace_id, document_id) -> summary dict.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from .db import sb_service


DATE_WINDOW_DAYS = 3
AUTO_MATCH_THRESHOLD = 85
REVIEW_THRESHOLD = 50
TOP_N_CANDIDATES = 3

_TRAILING_REF_RE = re.compile(r"[A-Z0-9]{6,}$")
_TRAILING_CITY_STATE_RE = re.compile(r"[A-Z]{2}\s*$")
_WS_RE = re.compile(r"\s+")


# ─── text normalization ──────────────────────────────────────────


def normalize_description(desc: str) -> str:
    if not desc:
        return ""
    s = desc
    s = s.replace("* ", " ")
    s = re.sub(r"\s{2,}", " ", s).strip()
    upper = s.upper()
    upper = _TRAILING_REF_RE.sub("", upper).strip()
    upper = _TRAILING_CITY_STATE_RE.sub("", upper).strip()
    normalized = _WS_RE.sub(" ", upper).strip().lower()
    return normalized


# ─── scoring ────────────────────────────────────────────────────


@dataclass
class Candidate:
    provider: str
    bucket_date: date
    total_cents: int
    representative_id: str
    score: int
    matched_alias: str


def _amount_score(txn_cents_abs: int, bucket_cents_abs: int) -> int:
    if txn_cents_abs == 0 or bucket_cents_abs == 0:
        return 0
    ratio = abs(txn_cents_abs - bucket_cents_abs) / txn_cents_abs
    if ratio <= 0.01:
        return 40
    if ratio <= 0.05:
        return 30
    if ratio <= 0.20:
        return 15
    return 0


def _date_score(txn_date: date, bucket_date: date) -> int:
    delta = abs((bucket_date - txn_date).days)
    if delta == 0:
        return 20
    if delta == 1:
        return 15
    if delta <= DATE_WINDOW_DAYS:
        return 5
    return 0


def _alias_score(normalized_desc: str, alias_lower: str) -> int:
    return 40 if alias_lower and alias_lower in normalized_desc else 0


# ─── core ───────────────────────────────────────────────────────


def _load_aliases(sb) -> dict[str, list[str]]:
    rows = sb.from_("vendor_aliases").select("provider, alias").execute().data or []
    out: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        out[r["provider"]].append(r["alias"])
    return out


def _find_matched_providers(normalized_desc: str, aliases_by_provider: dict[str, list[str]]) -> dict[str, str]:
    """Returns {provider: matched_alias_lower} for providers whose aliases appear in the description."""
    matched: dict[str, str] = {}
    for provider, aliases in aliases_by_provider.items():
        for alias in aliases:
            alias_lower = alias.lower()
            if alias_lower and alias_lower in normalized_desc:
                matched[provider] = alias_lower
                break
    return matched


def _aggregate_routing_by_day(
    sb, workspace_id: str, provider: str, txn_date: date
) -> list[tuple[date, int, str]]:
    """Return [(bucket_date, total_cents, representative_id), ...] for a provider within ±N days of txn_date."""
    start = txn_date - timedelta(days=DATE_WINDOW_DAYS)
    end = txn_date + timedelta(days=DATE_WINDOW_DAYS + 1)

    result = (
        sb.from_("routing_usage_records")
        .select("id, provider_cost_cents, markup_cents, created_at")
        .eq("workspace_id", workspace_id)
        .eq("provider", provider)
        .gte("created_at", start.isoformat())
        .lt("created_at", end.isoformat())
        .execute()
    )
    rows: list[dict[str, Any]] = result.data or []

    buckets: dict[date, dict[str, Any]] = defaultdict(lambda: {"total": 0, "rep_id": None})
    for row in rows:
        created_at = row.get("created_at")
        if isinstance(created_at, str):
            d = datetime.fromisoformat(created_at.replace("Z", "+00:00")).date()
        elif isinstance(created_at, datetime):
            d = created_at.date()
        else:
            continue
        cost = (row.get("provider_cost_cents") or 0) + (row.get("markup_cents") or 0)
        bucket = buckets[d]
        bucket["total"] += cost
        if bucket["rep_id"] is None:
            bucket["rep_id"] = row["id"]

    return [(d, b["total"], b["rep_id"]) for d, b in buckets.items() if b["rep_id"] is not None]


def _score_candidate(
    txn_date: date, txn_cents_abs: int, normalized_desc: str, matched_alias: str,
    bucket_date: date, bucket_cents_abs: int,
) -> int:
    return (
        _alias_score(normalized_desc, matched_alias)
        + _amount_score(txn_cents_abs, bucket_cents_abs)
        + _date_score(txn_date, bucket_date)
    )


def _already_matched_ids(sb, workspace_id: str, document_id: str) -> set[str]:
    txn_ids_result = (
        sb.from_("document_transactions").select("id").eq("document_id", document_id).execute()
    )
    txn_ids = [r["id"] for r in (txn_ids_result.data or [])]
    if not txn_ids:
        return set()
    existing = (
        sb.from_("reconciliation_matches")
        .select("document_transaction_id")
        .eq("workspace_id", workspace_id)
        .in_("document_transaction_id", txn_ids)
        .execute()
    )
    return {r["document_transaction_id"] for r in (existing.data or [])}


def match_document(workspace_id: str, document_id: str) -> dict:
    """Reconcile a single uploaded document against routing usage.

    Idempotent: existing reconciliation_matches rows for a given
    document_transaction_id are left untouched (ON CONFLICT DO NOTHING),
    and stale reconciliation_candidates for the document's transactions
    are cleared before fresh candidates are written.
    """
    sb = sb_service()

    txns_result = (
        sb.from_("document_transactions")
        .select("id, txn_date, description, amount_cents")
        .eq("document_id", document_id)
        .eq("workspace_id", workspace_id)
        .order("row_index", desc=False)
        .execute()
    )
    txns = txns_result.data or []

    if not txns:
        return {"auto_matched": 0, "needs_review": 0, "unmatched": 0}

    aliases_by_provider = _load_aliases(sb)
    already_matched = _already_matched_ids(sb, workspace_id, document_id)

    # Clear stale candidates for this document's transactions so re-runs don't stack
    txn_ids_all = [t["id"] for t in txns]
    if txn_ids_all:
        sb.from_("reconciliation_candidates").delete().eq("workspace_id", workspace_id).in_(
            "document_transaction_id", txn_ids_all
        ).execute()

    auto_matched = 0
    needs_review = 0
    unmatched = 0

    for txn in txns:
        txn_id = txn["id"]
        if txn_id in already_matched:
            # Already reconciled previously — count it as auto-matched for the summary
            auto_matched += 1
            continue

        txn_date_raw = txn["txn_date"]
        if isinstance(txn_date_raw, str):
            txn_date = date.fromisoformat(txn_date_raw)
        else:
            txn_date = txn_date_raw
        txn_cents_abs = abs(int(txn["amount_cents"]))
        normalized = normalize_description(txn.get("description") or "")

        providers = _find_matched_providers(normalized, aliases_by_provider)
        if not providers:
            unmatched += 1
            continue

        candidates: list[Candidate] = []
        for provider, matched_alias in providers.items():
            buckets = _aggregate_routing_by_day(sb, workspace_id, provider, txn_date)
            for bucket_date, total_cents, rep_id in buckets:
                score = _score_candidate(
                    txn_date, txn_cents_abs, normalized, matched_alias,
                    bucket_date, abs(total_cents),
                )
                if score <= 0:
                    continue
                candidates.append(Candidate(
                    provider=provider, bucket_date=bucket_date, total_cents=total_cents,
                    representative_id=rep_id, score=score, matched_alias=matched_alias,
                ))

        if not candidates:
            unmatched += 1
            continue

        candidates.sort(key=lambda c: c.score, reverse=True)
        best = candidates[0]

        if best.score >= AUTO_MATCH_THRESHOLD:
            try:
                sb.from_("reconciliation_matches").upsert({
                    "workspace_id": workspace_id,
                    "document_transaction_id": txn_id,
                    "source_kind": "routing",
                    "source_id": best.representative_id,
                    "confidence": best.score,
                    "auto": True,
                }, on_conflict="document_transaction_id", ignore_duplicates=True).execute()
            except TypeError:
                # Older supabase-py without ignore_duplicates kwarg
                try:
                    sb.from_("reconciliation_matches").insert({
                        "workspace_id": workspace_id,
                        "document_transaction_id": txn_id,
                        "source_kind": "routing",
                        "source_id": best.representative_id,
                        "confidence": best.score,
                        "auto": True,
                    }).execute()
                except Exception as e:
                    err = str(e).lower()
                    if "duplicate" not in err and "unique" not in err and "23505" not in err:
                        raise
            auto_matched += 1

        elif best.score >= REVIEW_THRESHOLD:
            top = candidates[:TOP_N_CANDIDATES]
            rows = [{
                "workspace_id": workspace_id,
                "document_transaction_id": txn_id,
                "source_kind": "routing",
                "source_id": c.representative_id,
                "score": c.score,
            } for c in top]
            if rows:
                sb.from_("reconciliation_candidates").insert(rows).execute()
            needs_review += 1
        else:
            unmatched += 1

    return {"auto_matched": auto_matched, "needs_review": needs_review, "unmatched": unmatched}
