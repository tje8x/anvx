from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from anvx_core import crypto
from anvx_core.connectors import REGISTRY

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()

_CATEGORIES = {
    "openai": "llm", "anthropic": "llm",
    "aws": "cloud", "gcp": "cloud", "vercel": "cloud", "cloudflare": "cloud",
    "stripe": "payments",
    "twilio": "comms", "sendgrid": "comms",
    "datadog": "observability", "langsmith": "observability",
    "pinecone": "utility", "tavily": "utility",
}

_TIERS = {
    "openai": "core", "anthropic": "core", "stripe": "core",
    "aws": "core", "gcp": "core", "vercel": "core", "cloudflare": "core",
    "twilio": "extended", "sendgrid": "extended",
    "datadog": "extended", "langsmith": "extended",
    "pinecone": "extended", "tavily": "extended",
}


def _category_for(name: str) -> str:
    return _CATEGORIES.get(name, "other")


def _tier_for(name: str) -> str:
    return _TIERS.get(name, "extended")


@router.get("/connectors/catalog")
async def get_catalog():
    """Public list of available providers. Used by onboarding and docs."""
    return [
        {"provider": name, "category": _category_for(name), "tier": _tier_for(name)}
        for name in REGISTRY.keys()
    ]


class ConnectBody(BaseModel):
    provider: str
    label: str
    api_key: str


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
    try:
        await connector.validate(body.api_key)
    except Exception as e:
        raise HTTPException(400, f"Validation failed: {e}")

    envelope = crypto.encrypt_api_key(ctx.workspace_id, body.api_key)
    sb = sb_service()

    result = sb.from_("provider_keys").insert({
        "workspace_id": ctx.workspace_id,
        "provider": body.provider,
        "label": body.label,
        "envelope": envelope,
        "created_by": ctx.user_id,
    }).execute()

    row = result.data[0]

    _audit(sb, ctx.workspace_id, ctx.user_id, "credential:create", "provider_key", row["id"], {"provider": body.provider, "label": body.label})

    return {"id": row["id"], "provider": row["provider"], "label": row["label"], "created_at": row["created_at"]}


@router.get("/connectors")
async def list_connectors(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    result = sb.from_("provider_keys").select("id, provider, label, last_used_at, created_at").eq("workspace_id", ctx.workspace_id).is_("deleted_at", "null").order("created_at", desc=True).execute()
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

    envelope = crypto.encrypt_api_key(ctx.workspace_id, body.api_key)
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
    lookup = sb.from_("provider_keys").select("id, provider, envelope").eq("id", key_id).eq("workspace_id", ctx.workspace_id).is_("deleted_at", "null").single().execute()

    if not lookup.data:
        raise HTTPException(404, "Provider key not found")

    provider = lookup.data["provider"]
    envelope = lookup.data["envelope"]

    connector = REGISTRY.get(provider)
    if not connector:
        raise HTTPException(400, f"Unknown provider: {provider}")

    api_key = crypto.decrypt_api_key(ctx.workspace_id, envelope)

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=30)

    # Detect connector type: revenue (Stripe) vs usage (OpenAI, etc.)
    is_revenue = hasattr(connector, "fetch_transactions")

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

    sb.from_("provider_keys").update({"last_used_at": now.isoformat()}).eq("id", key_id).execute()

    _audit(sb, ctx.workspace_id, ctx.user_id, "credential:sync", "provider_key", key_id, {"provider": provider, "records_synced": len(records)})

    return {"ok": True, "records_synced": len(records)}
