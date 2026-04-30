"""Per-model usage breakdown for the Optimization tab.

Reads `provider_model_usage` rolled up by the connector sync. Returns one block
per provider with the per-model split + a `model_usage_available` flag the UI
uses to show the "upgrade your Anthropic key" prompt when a workspace has only
a standard sk-ant-* key (which 401s on the admin usage report and therefore
never populates the per-model table).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


_PERIOD_DAYS = {
    "7d": 7,
    "14d": 14,
    "30d": 30,
    "60d": 60,
    "90d": 90,
}


def _parse_period(raw: str) -> int:
    if raw in _PERIOD_DAYS:
        return _PERIOD_DAYS[raw]
    raise HTTPException(400, f"Unsupported period {raw!r}; use one of {sorted(_PERIOD_DAYS)}")


@router.get("/workspaces/{workspace_id}/model-usage")
async def model_usage(
    workspace_id: str,
    period: str = Query(default="30d"),
    ctx: WorkspaceContext = Depends(require_role("viewer")),
) -> dict[str, Any]:
    if workspace_id != ctx.workspace_id:
        # The auth context already pins us to one workspace; reject mismatched
        # path params rather than silently overriding.
        raise HTTPException(403, "workspace mismatch")

    days = _parse_period(period)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date()

    sb = sb_service()

    # 1. Per-(provider, model) aggregate over the window.
    rows_res = (
        sb.from_("provider_model_usage")
        .select("provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, num_requests, cost_cents")
        .eq("workspace_id", workspace_id)
        .gte("period_start", cutoff.isoformat())
        .execute()
    )
    rows = rows_res.data or []

    # 2. Connected providers + their tier so we can flag "model-level data unavailable".
    keys_res = (
        sb.from_("provider_keys")
        .select("provider, key_metadata")
        .eq("workspace_id", workspace_id)
        .is_("deleted_at", "null")
        .execute()
    )
    connected: dict[str, dict] = {}
    for row in keys_res.data or []:
        meta = row.get("key_metadata") or {}
        connected[row["provider"]] = meta

    # ── Aggregate ──────────────────────────────────────────────────────────
    by_provider: dict[str, dict[str, dict[str, int]]] = {}
    for r in rows:
        prov = r["provider"]
        model = r["model"]
        bucket = by_provider.setdefault(prov, {})
        m = bucket.setdefault(model, {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "num_requests": 0,
            "cost_cents": 0,
        })
        m["input_tokens"] += r.get("input_tokens") or 0
        m["output_tokens"] += r.get("output_tokens") or 0
        m["cache_read_tokens"] += r.get("cache_read_tokens") or 0
        m["cache_write_tokens"] += r.get("cache_write_tokens") or 0
        m["num_requests"] += r.get("num_requests") or 0
        m["cost_cents"] += r.get("cost_cents") or 0

    providers_out: list[dict[str, Any]] = []
    # Include every connected provider even when it has no rows, so the UI
    # knows whether to show the upgrade prompt vs an empty state.
    seen_provs = set(by_provider) | set(connected)
    for prov in sorted(seen_provs):
        models = by_provider.get(prov, {})
        total_cost = sum(m["cost_cents"] for m in models.values())
        meta = connected.get(prov) or {}
        capabilities = set(meta.get("capabilities") or [])
        tier = meta.get("tier")
        # Model-level data is "available" iff (a) the workspace has a connected
        # key AND (b) the key tier carries `historical_usage`. Anthropic
        # standard sk-ant-* keys lack this capability and the sync skips them.
        model_usage_available = (prov in connected) and ("historical_usage" in capabilities)

        models_out = []
        for model, m in sorted(models.items(), key=lambda kv: kv[1]["cost_cents"], reverse=True):
            pct = (m["cost_cents"] / total_cost * 100) if total_cost > 0 else 0.0
            models_out.append({
                "model": model,
                "cost_cents": m["cost_cents"],
                "pct_of_provider": round(pct, 1),
                "input_tokens": m["input_tokens"],
                "output_tokens": m["output_tokens"],
                "cache_read_tokens": m["cache_read_tokens"],
                "cache_write_tokens": m["cache_write_tokens"],
                "requests": m["num_requests"],
            })

        providers_out.append({
            "provider": prov,
            "tier": tier,
            "model_usage_available": model_usage_available,
            "total_cost_cents": total_cost,
            "models": models_out,
        })

    return {
        "providers": providers_out,
        "period_days": days,
    }
