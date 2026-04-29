from datetime import datetime, timedelta, timezone
from uuid import UUID

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from anvx_core import crypto
from anvx_core.connectors import REGISTRY, validate_key

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

_log = structlog.get_logger("anvx.connectors")


_HTTP_STATUS_HINT = {
    401: "insufficient permissions — admin key required",
    403: "forbidden — check key scopes",
    404: "endpoint not found — provider may have changed",
    429: "rate limited — try again later",
    500: "provider returned 500",
    502: "provider unreachable",
    503: "provider unavailable",
}


def _short_sync_error(status: int, body: str | None = None) -> str:
    hint = _HTTP_STATUS_HINT.get(status)
    if hint:
        return f"{status}: {hint}"
    if body:
        snippet = body.strip().splitlines()[0][:120]
        return f"{status}: {snippet}"
    return f"{status}: sync failed"

router = APIRouter()

_CATEGORIES = {
    "openai": "llm", "anthropic": "llm", "google_ai": "llm",
    "cohere": "llm", "replicate": "llm", "together": "llm", "fireworks": "llm",
    "aws": "cloud", "gcp": "cloud", "vercel": "cloud", "cloudflare": "cloud",
    "stripe": "payments",
    "twilio": "comms", "sendgrid": "comms",
    "datadog": "observability", "langsmith": "observability",
    "pinecone": "utility", "tavily": "utility",
    "cursor": "dev_tools", "github_copilot": "dev_tools", "replit": "dev_tools",
    "lovable": "dev_tools", "v0": "dev_tools", "bolt": "dev_tools",
    "ethereum_wallet": "crypto", "solana_wallet": "crypto", "base_wallet": "crypto",
    "coinbase": "crypto", "binance": "crypto",
}

_TIERS = {
    "openai": "core", "anthropic": "core", "stripe": "core",
    "aws": "core", "gcp": "core", "vercel": "core", "cloudflare": "core",
    "google_ai": "core", "cohere": "extended", "replicate": "extended",
    "together": "extended", "fireworks": "extended",
    "twilio": "extended", "sendgrid": "extended",
    "datadog": "extended", "langsmith": "extended",
    "pinecone": "extended", "tavily": "extended",
    "cursor": "extended", "github_copilot": "extended", "replit": "extended",
    "lovable": "extended", "v0": "extended", "bolt": "extended",
    "ethereum_wallet": "extended", "solana_wallet": "extended", "base_wallet": "extended",
    "coinbase": "extended", "binance": "extended",
}

_KINDS: dict[str, str] = {
    "cursor": "csv_source", "replit": "csv_source",
    "lovable": "manifest", "v0": "manifest", "bolt": "manifest",
}


def _category_for(name: str) -> str:
    return _CATEGORIES.get(name, "other")


def _tier_for(name: str) -> str:
    return _TIERS.get(name, "extended")


def _kind_for(name: str) -> str:
    return _KINDS.get(name, "api_key")


@router.get("/connectors/catalog")
async def get_catalog():
    """Public list of available providers. Used by onboarding and docs."""
    return [
        {"provider": name, "category": _category_for(name), "tier": _tier_for(name), "kind": _kind_for(name)}
        for name in REGISTRY.keys()
    ]


@router.get("/connectors/catalog/{provider}")
async def get_provider_detail(provider: str):
    if provider not in REGISTRY:
        raise HTTPException(404, "unknown provider")
    conn = REGISTRY[provider]
    kind = getattr(conn, "kind", "api_key")
    return {"provider": provider, "kind": kind, "category": _category_for(provider)}


class ConnectBody(BaseModel):
    provider: str
    label: str
    api_key: str
    kind: str | None = None


class RotateBody(BaseModel):
    api_key: str


def _audit(sb, workspace_id: str, actor_user_id: str, action: str, target_kind: str, target_id: str, details: dict | None = None):
    sb.from_("audit_log").insert({
        "workspace_id": workspace_id,
        "actor_user_id": actor_user_id,
        "action": action,
        "target_kind": target_kind,
        "target_id": target_id,
        "details": details or {},
    }).execute()


@router.post("/connectors")
async def create_connector(body: ConnectBody, ctx: WorkspaceContext = Depends(require_role("admin"))):
    if body.provider not in REGISTRY:
        raise HTTPException(400, f"Unknown provider: {body.provider}")

    connector = REGISTRY[body.provider]
    kind = body.kind or getattr(connector, "kind", "api_key")
    sb = sb_service()

    if kind == "manifest":
        # Validate the JSON manifest against the connector
        try:
            await connector.parse_input(body.api_key)
        except Exception as e:
            raise HTTPException(400, f"Invalid manifest: {e}")

        # Store manifest as encrypted envelope (same column, different semantics)
        envelope = crypto.encrypt(body.api_key, UUID(ctx.workspace_id))
        result = sb.from_("provider_keys").insert({
            "workspace_id": ctx.workspace_id,
            "provider": body.provider,
            "label": body.label,
            "envelope": envelope,
            "created_by": ctx.user_id,
        }).execute()

    elif kind == "csv_source":
        # Validate CSV parses
        try:
            await connector.parse_input(body.api_key)
        except Exception as e:
            raise HTTPException(400, f"CSV parse failed: {e}")

        # Insert into provider_csv_uploads
        result = sb.from_("provider_csv_uploads").insert({
            "workspace_id": ctx.workspace_id,
            "provider": body.provider,
            "label": body.label,
            "content": body.api_key,
            "uploaded_by": ctx.user_id,
        }).execute()

    else:
        # api_key path with capability-aware validation.
        validation = await validate_key(body.provider, body.api_key)
        if not validation.get("valid"):
            raise HTTPException(400, validation.get("error") or "Validation failed")

        key_metadata = {
            "tier": validation.get("tier", "standard"),
            "capabilities": validation.get("capabilities", []),
        }
        if validation.get("warnings"):
            key_metadata["warnings"] = validation["warnings"]

        envelope = crypto.encrypt(body.api_key, UUID(ctx.workspace_id))
        result = sb.from_("provider_keys").insert({
            "workspace_id": ctx.workspace_id,
            "provider": body.provider,
            "label": body.label,
            "envelope": envelope,
            "key_metadata": key_metadata,
            "created_by": ctx.user_id,
        }).execute()

    row = result.data[0]

    _audit(sb, ctx.workspace_id, ctx.user_id, "credential:create", "provider_key", row["id"], {"provider": body.provider, "label": body.label, "kind": kind})

    return {
        "id": row["id"],
        "provider": row.get("provider", body.provider),
        "label": row.get("label", body.label),
        "created_at": row["created_at"],
        "key_metadata": row.get("key_metadata", {}),
    }


@router.get("/connectors")
async def list_connectors(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    result = (
        sb.from_("provider_keys")
        .select("id, provider, label, last_used_at, last_sync_at, last_sync_error, key_metadata, created_at")
        .eq("workspace_id", ctx.workspace_id)
        .is_("deleted_at", "null")
        .order("created_at", desc=True)
        .execute()
    )
    return result.data


@router.post("/connectors/{key_id}/rotate")
async def rotate_connector(key_id: str, body: RotateBody, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    lookup = sb.from_("provider_keys").select("id, provider").eq("id", key_id).eq("workspace_id", ctx.workspace_id).is_("deleted_at", "null").single().execute()

    if not lookup.data:
        raise HTTPException(404, "Provider key not found")

    provider = lookup.data["provider"]
    connector = REGISTRY.get(provider)
    if not connector:
        raise HTTPException(400, f"Unknown provider: {provider}")

    try:
        await connector.validate(body.api_key)
    except Exception as e:
        raise HTTPException(400, f"Validation failed: {e}")

    envelope = crypto.encrypt(body.api_key, UUID(ctx.workspace_id))
    sb.from_("provider_keys").update({"envelope": envelope}).eq("id", key_id).execute()

    _audit(sb, ctx.workspace_id, ctx.user_id, "credential:rotate", "provider_key", key_id, {"provider": provider})

    return {"ok": True}


@router.delete("/connectors/{key_id}")
async def delete_connector(key_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    sb.from_("provider_keys").update({"deleted_at": datetime.now(timezone.utc).isoformat()}).eq("id", key_id).eq("workspace_id", ctx.workspace_id).execute()

    _audit(sb, ctx.workspace_id, ctx.user_id, "credential:delete", "provider_key", key_id)

    return {"ok": True}


@router.post("/connectors/{key_id}/sync")
async def sync_connector(key_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    lookup = (
        sb.from_("provider_keys")
        .select("id, provider, envelope, key_metadata")
        .eq("id", key_id)
        .eq("workspace_id", ctx.workspace_id)
        .is_("deleted_at", "null")
        .single()
        .execute()
    )

    if not lookup.data:
        raise HTTPException(404, "Provider key not found")

    provider = lookup.data["provider"]
    envelope = lookup.data["envelope"]
    key_metadata = lookup.data.get("key_metadata") or {}
    capabilities = set(key_metadata.get("capabilities") or [])
    tier = key_metadata.get("tier", "standard")

    connector = REGISTRY.get(provider)
    if not connector:
        raise HTTPException(400, f"Unknown provider: {provider}")

    api_key = crypto.decrypt(envelope, UUID(ctx.workspace_id))

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=30)

    # Detect connector type: revenue (Stripe) vs usage (OpenAI, etc.)
    is_revenue = hasattr(connector, "fetch_transactions")

    # Capability gate — short-circuit before calling endpoints that would 401/403.
    needed = "transactions" if is_revenue else "historical_usage"
    if needed not in capabilities:
        _log.info(
            "connector_sync_skipped_no_capability",
            provider=provider,
            tier=tier,
            needed=needed,
            workspace_id=ctx.workspace_id,
            key_id=key_id,
        )
        sb.from_("provider_keys").update({"last_sync_at": now.isoformat()}).eq("id", key_id).execute()
        return {
            "ok": True,
            "tier": tier,
            "records_synced": 0,
            "note": (
                f"Key tier '{tier}' lacks '{needed}' capability — skipped sync. "
                f"Connect a higher-tier key to enable historical pulls."
            ),
        }

    try:
        if is_revenue:
            records = await connector.fetch_transactions(api_key, since, now)
            if records:
                rows = [r.as_insert_row(ctx.workspace_id, key_id) for r in records]
                sb.from_("transactions").upsert(rows, on_conflict="workspace_id,provider,ts,amount_cents,counterparty").execute()
        else:
            records = await connector.fetch_usage(api_key, since, now)
            if records:
                rows = [r.as_insert_row(ctx.workspace_id, key_id) for r in records]
                sb.from_("usage_records").upsert(rows, on_conflict="workspace_id,provider,ts,model").execute()
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code if exc.response is not None else 0
        body_text = exc.response.text if exc.response is not None else None
        msg = _short_sync_error(status_code, body_text)
        _log.warning(
            "connector_sync_http_error",
            provider=provider,
            status_code=status_code,
            key_id=key_id,
            workspace_id=ctx.workspace_id,
            error=msg,
        )

        update_payload: dict = {
            "last_sync_error": msg,
            "last_sync_at": now.isoformat(),
        }
        # If permissions changed since connect (401/403), reflect the drift in
        # key_metadata so the dashboard surfaces "tier downgraded".
        if status_code in (401, 403):
            stripped_caps = [c for c in capabilities if c not in {"historical_usage", "transactions", "billing_data"}]
            updated_meta = dict(key_metadata)
            updated_meta["tier"] = "drift_limited"
            updated_meta["capabilities"] = stripped_caps
            warnings = list(updated_meta.get("warnings") or [])
            warnings.append(f"Key returned {status_code} on {needed} read — permissions may have changed.")
            updated_meta["warnings"] = warnings
            update_payload["key_metadata"] = updated_meta

        sb.from_("provider_keys").update(update_payload).eq("id", key_id).execute()
        _audit(sb, ctx.workspace_id, ctx.user_id, "credential:sync_failed", "provider_key", key_id, {
            "provider": provider, "status_code": status_code, "error": msg,
        })
        return {"ok": False, "error": msg, "status": status_code, "tier": tier, "records_synced": 0}

    sb.from_("provider_keys").update({
        "last_used_at": now.isoformat(),
        "last_sync_at": now.isoformat(),
        "last_sync_error": None,
    }).eq("id", key_id).execute()

    _audit(sb, ctx.workspace_id, ctx.user_id, "credential:sync", "provider_key", key_id, {"provider": provider, "records_synced": len(records)})

    return {"ok": True, "tier": tier, "records_synced": len(records)}
