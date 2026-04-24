"""Anomaly detection — recursive loops, pricing changes, leaked keys, budget trajectory."""
import calendar
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Literal

from .db import sb_service


@dataclass
class Anomaly:
    kind: str
    severity: Literal["info", "warn", "critical"]
    payload: dict
    dedupe_key: str


def _insert_if_new(sb, workspace_id: str, anomaly: Anomaly) -> bool:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    print(f"[INSERT_ATTEMPT] workspace={workspace_id} kind={anomaly.kind} dedupe_key={anomaly.dedupe_key}")
    try:
        existing = sb.from_("anomalies").select("id, payload").eq("workspace_id", workspace_id).eq("kind", anomaly.kind).is_("acknowledged_at", "null").gte("detected_at", cutoff).execute()
        existing_rows = existing.data or []
        print(f"[INSERT_DEDUPE] found {len(existing_rows)} existing rows")
        for row in existing_rows:
            row_dedupe = (row.get("payload") or {}).get("dedupe_key")
            print(f"[INSERT_DEDUPE] existing row id={row.get('id')} dedupe_key={row_dedupe}")
            if row_dedupe == anomaly.dedupe_key:
                print(f"[INSERT_SKIP] duplicate found, skipping")
                return False
    except Exception as e:
        print(f"[INSERT_DEDUPE_ERROR] {str(e)}")
    try:
        sb.from_("anomalies").insert({
            "workspace_id": workspace_id,
            "kind": anomaly.kind,
            "severity": anomaly.severity,
            "payload": {**anomaly.payload, "dedupe_key": anomaly.dedupe_key},
        }).execute()
        print(f"[INSERT_OK] workspace={workspace_id} kind={anomaly.kind}")
        return True
    except Exception as e:
        print(f"[INSERT_ERROR] {str(e)}")
        return False


def detect_recursive_loops(workspace_id: str) -> list[Anomaly]:
    sb = sb_service()
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    result = sb.from_("routing_usage_records").select("project_tag, user_hint, total_cost_cents").eq("workspace_id", workspace_id).gte("created_at", cutoff).execute()
    rows = result.data or []
    print(f"[LOOP_DEBUG] workspace={workspace_id} rows_fetched={len(rows)} cutoff={cutoff}")
    if not rows:
        return []

    clusters: dict[str, list[int]] = defaultdict(list)
    for r in rows:
        key = r.get("project_tag") or r.get("user_hint") or "unscoped"
        clusters[key].append(r.get("total_cost_cents", 0))

    anomalies: list[Anomaly] = []
    for key, costs in clusters.items():
        count = len(costs)
        avg_cost = sum(costs) / count if count > 0 else 0
        passes = count >= 30 and avg_cost >= 1
        print(f"[LOOP_DEBUG] cluster={key} count={count} avg_cost={avg_cost} passes={passes}")
        if count >= 30 and avg_cost >= 1:
            severity: Literal["warn", "critical"] = "critical" if count > 100 else "warn"
            anomalies.append(Anomaly(kind="recursive_loop", severity=severity, payload={"cluster_key": key, "count": count, "avg_cost_cents": round(avg_cost), "window_minutes": 10}, dedupe_key=key))
    return anomalies


def detect_pricing_changes(workspace_id: str) -> list[Anomaly]:
    sb = sb_service()
    cutoff_7d = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    cutoff_1d = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    result = sb.from_("routing_usage_records").select("provider, model_routed, tokens_in, tokens_out, total_cost_cents, created_at").eq("workspace_id", workspace_id).gte("created_at", cutoff_7d).execute()
    rows = result.data or []
    if not rows:
        return []

    groups: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(lambda: {"recent": [], "baseline": []})
    for r in rows:
        provider = r.get("provider", "")
        model = r.get("model_routed", "")
        tokens = (r.get("tokens_in") or 0) + (r.get("tokens_out") or 0)
        cost = r.get("total_cost_cents", 0)
        if tokens == 0:
            continue
        cpm = cost * 1_000_000 / tokens
        bucket = "recent" if r.get("created_at", "") >= cutoff_1d else "baseline"
        groups[(provider, model)][bucket].append(cpm)

    anomalies: list[Anomaly] = []
    for (provider, model), buckets in groups.items():
        if len(buckets["recent"]) < 5 or len(buckets["baseline"]) < 5:
            continue
        med_recent = median(buckets["recent"])
        med_baseline = median(buckets["baseline"])
        if med_baseline == 0:
            continue
        pct_change = abs(med_recent - med_baseline) / med_baseline
        if pct_change > 0.15:
            anomalies.append(Anomaly(kind="pricing_change", severity="warn", payload={"provider": provider, "model": model, "baseline_cpm": round(med_baseline, 2), "recent_cpm": round(med_recent, 2), "pct_change": round(pct_change * 100, 1)}, dedupe_key=f"{provider}/{model}"))
    return anomalies


def detect_leaked_keys(workspace_id: str) -> list[Anomaly]:
    sb = sb_service()
    cutoff_10m = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    cutoff_7d = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

    recent = sb.from_("routing_usage_records").select("user_hint").eq("workspace_id", workspace_id).gte("created_at", cutoff_10m).execute()
    recent_rows = recent.data or []
    recent_count = len(recent_rows)
    distinct_hints = len({r.get("user_hint") for r in recent_rows if r.get("user_hint")})

    baseline = sb.from_("routing_usage_records").select("id").eq("workspace_id", workspace_id).gte("created_at", cutoff_7d).execute()
    baseline_count = len(baseline.data or [])
    intervals_in_7d = 7 * 24 * 6
    avg_per_10m = baseline_count / intervals_in_7d if intervals_in_7d > 0 else 0

    if avg_per_10m < 5:
        return []
    if recent_count > 5 * avg_per_10m and distinct_hints >= 4:
        return [Anomaly(kind="leaked_key", severity="critical", payload={"recent_count": recent_count, "baseline_avg_per_10m": round(avg_per_10m, 1), "distinct_user_hints": distinct_hints}, dedupe_key="workspace_volume_spike")]
    return []


def detect_budget_trajectory(workspace_id: str) -> list[Anomaly]:
    now = datetime.now(timezone.utc)
    day_of_month = now.day
    if day_of_month > 14:
        return []

    sb = sb_service()
    policies = sb.from_("budget_policies").select("id, name, monthly_limit_cents, scope_provider, scope_project_tag, scope_user_hint").eq("workspace_id", workspace_id).eq("enabled", True).execute()
    policy_rows = policies.data or []
    if not policy_rows:
        return []

    days_in_month = calendar.monthrange(now.year, now.month)[1]
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()

    anomalies: list[Anomaly] = []
    for p in policy_rows:
        limit = p.get("monthly_limit_cents")
        if not limit:
            continue
        q = sb.from_("routing_usage_records").select("total_cost_cents").eq("workspace_id", workspace_id).gte("created_at", month_start)
        if p.get("scope_provider"):
            q = q.eq("provider", p["scope_provider"])
        if p.get("scope_project_tag"):
            q = q.eq("project_tag", p["scope_project_tag"])
        if p.get("scope_user_hint"):
            q = q.eq("user_hint", p["scope_user_hint"])
        mtd_result = q.execute()
        mtd_total = sum(r.get("total_cost_cents", 0) for r in (mtd_result.data or []))
        projected = mtd_total * days_in_month / day_of_month if day_of_month > 0 else 0
        if projected <= limit:
            continue
        overshoot = (projected - limit) / limit
        severity: Literal["warn", "critical"] = "critical" if overshoot > 0.25 else "warn"
        anomalies.append(Anomaly(kind="budget_trajectory", severity=severity, payload={"policy_id": p["id"], "policy_name": p.get("name", ""), "mtd_cents": mtd_total, "projected_cents": round(projected), "limit_cents": limit, "overshoot_pct": round(overshoot * 100, 1)}, dedupe_key=p["id"]))
    return anomalies


def run_for_all_workspaces() -> dict:
    sb = sb_service()
    ws_result = sb.from_("workspaces").select("id").execute()
    workspaces = ws_result.data or []
    total_inserted = 0
    detectors = [detect_recursive_loops, detect_pricing_changes, detect_leaked_keys, detect_budget_trajectory]
    for ws in workspaces:
        ws_id = ws["id"]
        for detector in detectors:
            try:
                anomalies = detector(ws_id)
                for a in anomalies:
                    if _insert_if_new(sb, ws_id, a):
                        total_inserted += 1
            except Exception:
                continue
    return {"workspaces_scanned": len(workspaces), "total_inserted": total_inserted}
