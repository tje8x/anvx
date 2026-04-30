"""Close pack generator.

Assembles a workspace's monthly financial close pack as a styled PDF
(via WeasyPrint) plus a set of CSV exports, uploads everything to the
'packs' Supabase Storage bucket, and updates the pack row's status.

Run as a background job — never inside a request handler.
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

from ..attribution import attribution_for_period
from ..db import sb_service

STORAGE_BUCKET = "packs"
TEMPLATE_DIR = Path(__file__).parent / "templates"

KIND_LABELS = {
    "close_pack": "Monthly Close Pack",
    "ai_audit_pack": "AI Audit Pack",
    "audit_trail_export": "Audit Trail Export",
}


# ─── helpers ───────────────────────────────────────────────────


def _fmt_money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    abs_c = abs(int(cents))
    return f"{sign}${abs_c // 100:,}.{abs_c % 100:02d}"


def _csv_bytes(rows: list[dict], fieldnames: list[str]) -> bytes:
    buf = io.StringIO()
    buf.write("﻿")  # BOM for Excel
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow(r)
    return buf.getvalue().encode("utf-8")


def _coa_lookup(sb, workspace_id: str) -> dict[str, dict]:
    rows = (
        sb.from_("chart_of_accounts")
        .select("id, code, name, kind")
        .eq("workspace_id", workspace_id)
        .execute()
    ).data or []
    by_id = {r["id"]: r for r in rows}
    return by_id


# ─── Optimization Insights section ─────────────────────────────


_INSIGHT_TYPE_LABELS = {
    "model_tier": "Model Optimization",
    "seat_utilization": "Seat Utilization",
    "provider_comparison": "Provider Comparison",
    "routing_gap": "Routing Coverage",
    "cost_trajectory": "Cost Alert",
}


def _insight_status(row: dict, period_start: date, period_end: date) -> str:
    payload = row.get("action_payload") or {}
    if isinstance(payload, dict) and payload.get("acted_at"):
        return f"Acted on {str(payload['acted_at'])[:10]}"
    if row.get("added_to_pack_at"):
        return "Added by user"
    if row.get("dismissed_at"):
        return "Dismissed"
    return "Pending review"


def _within(period_start: date, period_end: date, ts_str: str | None) -> bool:
    if not ts_str:
        return False
    try:
        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return False
    return period_start <= ts.date() < period_end


def get_optimization_section(workspace_id: str, period_start: date, period_end: date) -> dict[str, Any]:
    """Build the Optimization Insights section payload for the close pack PDF.

    Includes any insight whose `generated_at` (active rows), `added_to_pack_at`,
    or `dismissed_at` falls within [period_start, period_end). Dismissed
    insights still get logged so the pack reflects what the user evaluated
    during the period — closure is a record, not just a snapshot of pending.
    """
    sb = sb_service()
    start_iso = datetime.combine(period_start, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    end_iso = datetime.combine(period_end, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    period_close_iso = end_iso

    # Connected provider keys at the close date (deleted_at is null OR was set
    # after the close date — i.e. deletion happens after the period we're
    # reporting on, so the key was live during).
    keys_rows = (
        sb.from_("provider_keys")
        .select("provider, key_metadata, deleted_at, created_at")
        .eq("workspace_id", workspace_id)
        .execute()
    ).data or []
    connected_keys = []
    has_admin_connector = False
    admin_connector_providers: list[str] = []
    for k in keys_rows:
        deleted = k.get("deleted_at")
        created = k.get("created_at")
        if deleted and deleted < period_close_iso:
            continue  # was already gone before the close
        if created and created > period_close_iso:
            continue  # connected after the close — not relevant to this pack
        connected_keys.append(k)
        meta = k.get("key_metadata") or {}
        caps = set(meta.get("capabilities") or [])
        if "historical_usage" in caps:
            has_admin_connector = True
            admin_connector_providers.append(k["provider"])
    n_providers = len(connected_keys)

    # Insights that overlap the period in any of three ways. We pull all
    # workspace insights and filter in Python because the postgrest OR builder
    # is awkward and the row count per workspace is small (≤ 10s of rows).
    all_rows = (
        sb.from_("optimization_insights")
        .select("*")
        .eq("workspace_id", workspace_id)
        .execute()
    ).data or []

    relevant: list[dict] = []
    for row in all_rows:
        if (
            _within(period_start, period_end, row.get("generated_at"))
            or _within(period_start, period_end, row.get("added_to_pack_at"))
            or _within(period_start, period_end, row.get("dismissed_at"))
        ):
            relevant.append(row)

    # Sort highest-impact first; ties broken by status priority so acted/added
    # rows surface above pending and dismissed.
    status_priority = {"Acted on": 0, "Added by user": 1, "Pending review": 2, "Dismissed": 3}
    insight_rows = []
    for r in relevant:
        status = _insight_status(r, period_start, period_end)
        status_key = status.split(" ")[0] + " " + status.split(" ")[1] if status.startswith("Acted on") else status
        priority_bucket = "Acted on" if status.startswith("Acted on") else status
        insight_rows.append({
            "type_label": _INSIGHT_TYPE_LABELS.get(r.get("type") or "", r.get("type") or "—"),
            "title": r.get("title") or "",
            "impact": r.get("impact") or "",
            "status": status,
            "_sort_priority": status_priority.get(priority_bucket, 99),
            "_impact_cents": int(r.get("impact_cents") or 0),
        })
    insight_rows.sort(key=lambda x: (x["_sort_priority"], -x["_impact_cents"]))
    insight_count_in_period = sum(1 for r in relevant if _within(period_start, period_end, r.get("generated_at")))

    # Routing coverage box — populated only when admin connector data lets us
    # compute the un-routed remainder.
    coverage_box: dict[str, Any] | None = None
    no_admin_blurb: str | None = None
    if has_admin_connector:
        # Look up the most recent routing_gap insight in the period; its
        # action_payload carries the connector_total / routed / gap cents we
        # already computed.
        gap_row: dict | None = None
        for r in relevant:
            if r.get("type") == "routing_gap":
                payload = r.get("action_payload") or {}
                if isinstance(payload, dict) and "connector_total_cents" in payload:
                    if gap_row is None or (r.get("generated_at") or "") > (gap_row.get("generated_at") or ""):
                        gap_row = r
        if gap_row:
            payload = gap_row.get("action_payload") or {}
            connector_total = int(payload.get("connector_total_cents") or 0)
            routed_cents = int(payload.get("routed_cents") or 0)
            gap_cents = int(payload.get("gap_cents") or max(0, connector_total - routed_cents))
            cov_pct = int(payload.get("coverage_pct") or 0)
            gap_pct = max(0, 100 - cov_pct)
            # Engine savings = the midpoint impact of the most recent gap insight.
            engine_savings = int(gap_row.get("impact_cents") or 0)
            coverage_box = {
                "routed_pct": cov_pct,
                "routed_cents": routed_cents,
                "routed_money": _fmt_money(routed_cents),
                "gap_pct": gap_pct,
                "gap_cents": gap_cents,
                "gap_money": _fmt_money(gap_cents),
                "engine_savings_money": _fmt_money(engine_savings),
            }
    else:
        no_admin_blurb = (
            "Routing coverage analysis requires an admin-tier provider key to compute spend that "
            "didn't flow through ANVX. Connect one to enable this section in future packs."
        )

    summary = (
        f"ANVX analyzed {n_providers} connected provider"
        f"{'s' if n_providers != 1 else ''} and identified {insight_count_in_period} optimization "
        f"opportunit{'ies' if insight_count_in_period != 1 else 'y'} during this period."
    )

    return {
        "summary": summary,
        "n_providers": n_providers,
        "n_insights_in_period": insight_count_in_period,
        "insight_rows": [
            # Strip private sort keys before sending to the template.
            {k: v for k, v in r.items() if not k.startswith("_")}
            for r in insight_rows
        ],
        "coverage_box": coverage_box,
        "no_admin_blurb": no_admin_blurb,
    }


# ─── data assembly ─────────────────────────────────────────────


def assemble_close_pack_data(workspace_id: str, period_start: date, period_end: date) -> dict[str, Any]:
    sb = sb_service()

    ws = sb.from_("workspaces").select("name").eq("id", workspace_id).single().execute().data or {}
    workspace_name = ws.get("name") or "Workspace"

    breakdown = attribution_for_period(workspace_id, period_start, period_end)
    by_cat: dict[str, int] = breakdown.get("by_category", {}) or {}
    total = int(breakdown.get("total_cents") or 0)

    # ── routing usage by provider + by model ──
    start_iso = datetime.combine(period_start, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    end_iso = datetime.combine(period_end, datetime.min.time(), tzinfo=timezone.utc).isoformat()

    routing_rows = (
        sb.from_("routing_usage_records")
        .select("provider, model_routed, tokens_in, tokens_out, provider_cost_cents, request_id, model_requested, decision, created_at")
        .eq("workspace_id", workspace_id)
        .gte("created_at", start_iso)
        .lt("created_at", end_iso)
        .limit(50000)
        .execute()
    ).data or []

    by_provider: dict[str, dict[str, int]] = defaultdict(lambda: {"requests": 0, "tokens_in": 0, "tokens_out": 0, "cost_cents": 0})
    by_model: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"requests": 0, "tokens_in": 0, "tokens_out": 0, "cost_cents": 0})
    for r in routing_rows:
        prov = r.get("provider") or "unknown"
        model = r.get("model_routed") or "unknown"
        by_provider[prov]["requests"] += 1
        by_provider[prov]["tokens_in"] += int(r.get("tokens_in") or 0)
        by_provider[prov]["tokens_out"] += int(r.get("tokens_out") or 0)
        by_provider[prov]["cost_cents"] += int(r.get("provider_cost_cents") or 0)
        key = (model, prov)
        by_model[key]["requests"] += 1
        by_model[key]["tokens_in"] += int(r.get("tokens_in") or 0)
        by_model[key]["tokens_out"] += int(r.get("tokens_out") or 0)
        by_model[key]["cost_cents"] += int(r.get("provider_cost_cents") or 0)

    spend_by_provider = sorted(
        [{"provider": p, **v, "cost": _fmt_money(v["cost_cents"])} for p, v in by_provider.items()],
        key=lambda r: r["cost_cents"], reverse=True,
    )
    llm_detail = sorted(
        [{"model": m, "provider": pr, **v, "cost": _fmt_money(v["cost_cents"])} for (m, pr), v in by_model.items()],
        key=lambda r: r["cost_cents"], reverse=True,
    )

    # ── spend by category (resolve code → name) ──
    coa_rows = (
        sb.from_("chart_of_accounts")
        .select("code, name, kind")
        .eq("workspace_id", workspace_id)
        .execute()
    ).data or []
    coa_by_code = {r["code"]: r for r in coa_rows}

    spend_by_category = []
    for code in sorted(by_cat.keys()):
        amount = int(by_cat[code])
        if amount <= 0:
            continue
        meta = coa_by_code.get(code, {})
        spend_by_category.append({
            "code": code, "name": meta.get("name", "—"),
            "amount_cents": amount, "amount": _fmt_money(amount),
        })

    # ── revenue summary ──
    revenue_coa = [r for r in coa_rows if r.get("kind") == "revenue"]
    coa_id_lookup = _coa_lookup(sb, workspace_id)
    revenue_codes = {r["code"] for r in revenue_coa}
    revenue_total_by_code: dict[str, int] = defaultdict(int)
    if revenue_codes:
        cats = (
            sb.from_("reconciliation_categorizations")
            .select("document_transaction_id, category_id")
            .eq("workspace_id", workspace_id)
            .execute()
        ).data or []
        revenue_cat_ids = {c["category_id"] for c in cats if (coa_id_lookup.get(c["category_id"]) or {}).get("kind") == "revenue"}
        if revenue_cat_ids:
            txn_id_to_cat = {c["document_transaction_id"]: c["category_id"] for c in cats if c["category_id"] in revenue_cat_ids}
            txn_ids = list(txn_id_to_cat.keys())
            txns = (
                sb.from_("document_transactions")
                .select("id, amount_cents, txn_date")
                .eq("workspace_id", workspace_id)
                .in_("id", txn_ids)
                .gte("txn_date", period_start.isoformat())
                .lt("txn_date", period_end.isoformat())
                .execute()
            ).data or []
            for t in txns:
                amt = int(t.get("amount_cents") or 0)
                if amt <= 0:
                    continue
                cat_meta = coa_id_lookup.get(txn_id_to_cat.get(t["id"]))
                if not cat_meta:
                    continue
                revenue_total_by_code[cat_meta["code"]] += amt

    revenue_lines = sorted(
        [{
            "code": code, "name": coa_by_code.get(code, {}).get("name", "—"),
            "amount_cents": amt, "amount": _fmt_money(amt),
        } for code, amt in revenue_total_by_code.items()],
        key=lambda r: r["code"],
    )
    revenue_total = sum(r["amount_cents"] for r in revenue_lines)

    # ── reconciliation summary ──
    period_txns = (
        sb.from_("document_transactions")
        .select("id, amount_cents, description, counterparty, txn_date, document_id")
        .eq("workspace_id", workspace_id)
        .gte("txn_date", period_start.isoformat())
        .lt("txn_date", period_end.isoformat())
        .limit(20000)
        .execute()
    ).data or []
    period_txn_ids = [t["id"] for t in period_txns]

    matches = []
    cats_period = []
    flags = []
    if period_txn_ids:
        matches = (
            sb.from_("reconciliation_matches")
            .select("document_transaction_id, auto, source_kind, confidence")
            .eq("workspace_id", workspace_id)
            .in_("document_transaction_id", period_txn_ids)
            .execute()
        ).data or []
        cats_period = (
            sb.from_("reconciliation_categorizations")
            .select("document_transaction_id, category_id")
            .eq("workspace_id", workspace_id)
            .in_("document_transaction_id", period_txn_ids)
            .execute()
        ).data or []
        flags = (
            sb.from_("reconciliation_flags")
            .select("document_transaction_id, reason")
            .eq("workspace_id", workspace_id)
            .in_("document_transaction_id", period_txn_ids)
            .execute()
        ).data or []

    auto_matched = sum(1 for m in matches if m.get("auto"))
    user_resolved = sum(1 for m in matches if not m.get("auto"))
    categorized = len(cats_period)
    flagged_count = len(flags)
    flagged_amount = 0
    if flags:
        flag_ids = {f["document_transaction_id"] for f in flags}
        for t in period_txns:
            if t["id"] in flag_ids:
                flagged_amount += abs(int(t.get("amount_cents") or 0))

    # ── anomalies (table is optional) ──
    anomalies_rows: list[dict] = []
    try:
        anomalies_rows = (
            sb.from_("anomalies")
            .select("kind, severity, detail, created_at")
            .eq("workspace_id", workspace_id)
            .gte("created_at", start_iso)
            .lt("created_at", end_iso)
            .order("created_at", desc=True)
            .limit(50)
            .execute()
        ).data or []
    except Exception:
        anomalies_rows = []
    anomalies_view = [{
        "detected": (a.get("created_at") or "")[:10],
        "kind": a.get("kind", "—"),
        "severity": a.get("severity", "—"),
        "detail": (a.get("detail") if isinstance(a.get("detail"), str) else str(a.get("detail") or ""))[:200],
    } for a in anomalies_rows]

    # ── executive summary lines ──
    period_label = f"{period_start.isoformat()} – {(period_end.isoformat())}"
    top_provider_line = (
        f"Top provider: {spend_by_provider[0]['provider']} at {spend_by_provider[0]['cost']}."
        if spend_by_provider else "No upstream model usage recorded."
    )
    net_line = (
        f"Categorized revenue {_fmt_money(revenue_total)}; categorized spend {_fmt_money(total)}; "
        f"net {_fmt_money(revenue_total - total)}."
    )
    flagged_line = (
        f"{flagged_count} flagged transaction(s) totaling {_fmt_money(flagged_amount)} require review."
        if flagged_count else "No flagged transactions outstanding."
    )
    coverage_line = (
        f"{auto_matched} auto-matched, {user_resolved} user-confirmed, {categorized} categorized, {flagged_count} flagged."
    )
    executive_summary = [
        f"Period {period_label} for {workspace_name}.",
        top_provider_line,
        net_line,
        coverage_line,
        flagged_line,
    ]

    optimization = get_optimization_section(workspace_id, period_start, period_end)

    return {
        "workspace_name": workspace_name,
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "executive_summary": executive_summary,
        "spend_by_provider": spend_by_provider,
        "spend_by_category": spend_by_category,
        "llm_detail": llm_detail,
        "revenue_lines": revenue_lines,
        "recon": {
            "auto_matched": auto_matched,
            "user_resolved": user_resolved,
            "categorized": categorized,
            "flagged": flagged_count,
        },
        "anomalies": anomalies_view,
        "optimization": optimization,
        # Raw data for CSV exports
        "_raw": {
            "routing_rows": routing_rows,
            "period_txns": period_txns,
            "matches": matches,
            "cats": cats_period,
            "flags": flags,
            "coa_by_code": coa_by_code,
            "coa_id_lookup": coa_id_lookup,
        },
    }


# ─── CSV builders ──────────────────────────────────────────────


def _csv_reconciled_transactions(data: dict) -> bytes:
    raw = data["_raw"]
    matches_by_txn = {m["document_transaction_id"]: m for m in raw["matches"]}
    cats_by_txn = {c["document_transaction_id"]: c for c in raw["cats"]}
    flags_by_txn = {f["document_transaction_id"]: f for f in raw["flags"]}
    coa_by_id = raw["coa_id_lookup"]

    rows = []
    for t in raw["period_txns"]:
        m = matches_by_txn.get(t["id"])
        c = cats_by_txn.get(t["id"])
        f = flags_by_txn.get(t["id"])
        category = ""
        if c and c.get("category_id"):
            meta = coa_by_id.get(c["category_id"]) or {}
            category = f"{meta.get('code','')} — {meta.get('name','')}".strip(" —")
        if f:
            status = "flagged"
        elif c:
            status = "categorized"
        elif m and not m.get("auto"):
            status = "user_confirmed"
        elif m and m.get("auto"):
            status = "auto_matched"
        else:
            status = "unmatched"
        rows.append({
            "txn_date": t.get("txn_date", ""),
            "description": t.get("description", ""),
            "counterparty": t.get("counterparty", "") or "",
            "amount_cents": t.get("amount_cents", 0),
            "status": status,
            "match_source": (m or {}).get("source_kind", ""),
            "match_confidence": (m or {}).get("confidence", ""),
            "category": category,
            "flag_reason": (f or {}).get("reason", ""),
            "document_id": t.get("document_id", ""),
        })
    return _csv_bytes(rows, [
        "txn_date", "description", "counterparty", "amount_cents",
        "status", "match_source", "match_confidence", "category", "flag_reason", "document_id",
    ])


def _csv_spend_by_category(data: dict) -> bytes:
    rows = [{"code": r["code"], "name": r["name"], "amount_cents": r["amount_cents"]}
            for r in data["spend_by_category"]]
    return _csv_bytes(rows, ["code", "name", "amount_cents"])


def _csv_routing_audit_trail(data: dict) -> bytes:
    rows = [{
        "request_id": r.get("request_id", ""),
        "model_requested": r.get("model_requested", ""),
        "model_routed": r.get("model_routed", ""),
        "provider": r.get("provider", ""),
        "provider_cost_cents": r.get("provider_cost_cents", 0),
        "decision": r.get("decision", ""),
        "created_at": r.get("created_at", ""),
    } for r in data["_raw"]["routing_rows"]]
    return _csv_bytes(rows, [
        "request_id", "model_requested", "model_routed", "provider",
        "provider_cost_cents", "decision", "created_at",
    ])


# ─── PDF rendering ─────────────────────────────────────────────


def _render_pdf(data: dict, kind: str) -> bytes:
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=select_autoescape(["html"]),
    )
    template = env.get_template("close_pack.html")
    title_by_kind = {
        "close_pack": f"Monthly Close · {data['period_start'][:7]}",
        "ai_audit_pack": f"AI Audit · {data['period_start']} → {data['period_end']}",
        "audit_trail_export": "Audit Trail Export",
    }
    html = template.render(
        title=title_by_kind.get(kind, "Close Pack"),
        kind_label=KIND_LABELS.get(kind, kind),
        **data,
    )
    # Defer the WeasyPrint import: it needs native libs (pango/cairo) and will
    # raise OSError at import time if they aren't installed. Surfacing that as
    # a per-pack failure (with a useful error_message) is better than crashing
    # the whole API at startup.
    from weasyprint import HTML  # type: ignore
    return HTML(string=html, base_url=str(TEMPLATE_DIR)).write_pdf()


# ─── upload ─────────────────────────────────────────────────────


def _upload(sb, path: str, content: bytes, content_type: str) -> None:
    storage = sb.storage.from_(STORAGE_BUCKET)
    try:
        storage.upload(
            path=path, file=content,
            file_options={"content-type": content_type, "upsert": "true"},
        )
    except TypeError:
        storage.upload(path, content, {"content-type": content_type, "upsert": "true"})


# ─── main entry ─────────────────────────────────────────────────


def generate_close_pack(pack_id: str) -> None:
    sb = sb_service()

    pack = (
        sb.from_("packs").select("*").eq("id", pack_id).single().execute()
    ).data
    if not pack:
        return
    if pack["status"] not in ("requested", "generating"):
        return

    sb.from_("packs").update({"status": "generating"}).eq("id", pack_id).execute()

    try:
        workspace_id = pack["workspace_id"]
        period_start = date.fromisoformat(pack["period_start"])
        period_end = date.fromisoformat(pack["period_end"])
        kind = pack["kind"]

        data = assemble_close_pack_data(workspace_id, period_start, period_end)

        pdf_bytes = _render_pdf(data, kind)
        pdf_path = f"workspaces/{workspace_id}/packs/{pack_id}.pdf"
        _upload(sb, pdf_path, pdf_bytes, "application/pdf")

        # CSV exports — same path prefix
        for name, builder in (
            ("reconciled-transactions.csv", _csv_reconciled_transactions),
            ("spend-by-category.csv", _csv_spend_by_category),
            ("routing-audit-trail.csv", _csv_routing_audit_trail),
        ):
            csv_path = f"workspaces/{workspace_id}/packs/{pack_id}-{name}"
            _upload(sb, csv_path, builder(data), "text/csv; charset=utf-8")

        sb.from_("packs").update({
            "status": "ready",
            "storage_path": pdf_path,
            "ready_at": datetime.now(timezone.utc).isoformat(),
            "error_message": None,
        }).eq("id", pack_id).execute()

        from ..analytics import capture as analytics_capture
        analytics_capture(workspace_id, "pack_generated", {"kind": kind})

        try:
            from ..notifications.dispatch import dispatch_fire_and_forget
            kind_label_map = {
                "close_pack": "Monthly close pack",
                "quarterly_close": "Quarterly close pack",
                "annual_tax_prep": "Annual tax prep bundle",
                "audit_trail_export": "Audit trail export",
            }
            dispatch_fire_and_forget("close_pack_ready", workspace_id, {
                "pack_id": pack_id,
                "pack_label": kind_label_map.get(kind, "Close pack"),
                "period_label": f"{period_start.isoformat()} → {period_end.isoformat()}",
            })
        except Exception as notify_err:
            print(f"[NOTIFY_ERR] {notify_err}")

    except Exception as e:
        sb.from_("packs").update({
            "status": "failed",
            "error_message": str(e)[:500],
        }).eq("id", pack_id).execute()
