from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


class RuleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str | None = None
    approved_models: list[str] = Field(min_length=1)
    quality_priority: int = Field(ge=0, le=100)
    cost_priority: int = Field(ge=0, le=100)


class RuleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = None
    approved_models: list[str] | None = Field(default=None, min_length=1)
    quality_priority: int | None = Field(default=None, ge=0, le=100)
    cost_priority: int | None = Field(default=None, ge=0, le=100)
    enabled: bool | None = None


def _audit(sb, workspace_id: str, actor_user_id: str, action: str, target_id: str, details: dict | None = None):
    sb.from_("audit_log").insert({
        "workspace_id": workspace_id,
        "actor_user_id": actor_user_id,
        "action": action,
        "target_kind": "routing_rule",
        "target_id": target_id,
        "details": details or {},
    }).execute()


@router.get("/routing-rules")
async def list_rules(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    result = sb.from_("model_routing_rules").select("*").eq("workspace_id", ctx.workspace_id).order("created_at", desc=True).execute()
    return result.data or []


@router.post("/routing-rules")
async def create_rule(body: RuleCreate, ctx: WorkspaceContext = Depends(require_role("admin"))):
    total = body.quality_priority + body.cost_priority
    if total != 100:
        raise HTTPException(400, f"quality_priority + cost_priority must sum to 100, got {total}")

    sb = sb_service()
    try:
        result = sb.from_("model_routing_rules").insert({
            "workspace_id": ctx.workspace_id,
            "name": body.name,
            "description": body.description,
            "approved_models": body.approved_models,
            "quality_priority": body.quality_priority,
            "cost_priority": body.cost_priority,
            "enabled": True,
        }).execute()
    except Exception as e:
        err_str = str(e)
        if "duplicate" in err_str.lower() or "unique" in err_str.lower() or "23505" in err_str:
            raise HTTPException(409, f"a rule named {body.name} already exists")
        raise

    row = result.data[0]
    _audit(sb, ctx.workspace_id, ctx.user_id, "routing_rule:create", row["id"], {"name": body.name, "approved_models": body.approved_models, "quality_priority": body.quality_priority, "cost_priority": body.cost_priority})
    return row


@router.patch("/routing-rules/{rule_id}")
async def update_rule(rule_id: str, body: RuleUpdate, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()

    # Load current row
    lookup = sb.from_("model_routing_rules").select("*").eq("id", rule_id).eq("workspace_id", ctx.workspace_id).single().execute()
    if not lookup.data:
        raise HTTPException(404, "Routing rule not found")

    current = lookup.data

    # Build update dict from non-None fields
    updates: dict = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.description is not None:
        updates["description"] = body.description
    if body.approved_models is not None:
        updates["approved_models"] = body.approved_models
    if body.quality_priority is not None:
        updates["quality_priority"] = body.quality_priority
    if body.cost_priority is not None:
        updates["cost_priority"] = body.cost_priority
    if body.enabled is not None:
        updates["enabled"] = body.enabled

    if not updates:
        return current

    # Validate priority sum using current values for missing side
    q = updates.get("quality_priority", current["quality_priority"])
    c = updates.get("cost_priority", current["cost_priority"])
    total = q + c
    if total != 100:
        raise HTTPException(400, f"quality_priority + cost_priority must sum to 100, got {total}")

    try:
        result = sb.from_("model_routing_rules").update(updates).eq("id", rule_id).eq("workspace_id", ctx.workspace_id).execute()
    except Exception as e:
        err_str = str(e)
        if "duplicate" in err_str.lower() or "unique" in err_str.lower() or "23505" in err_str:
            raise HTTPException(409, f"a rule named {updates.get('name', body.name)} already exists")
        raise

    row = result.data[0] if result.data else {**current, **updates}
    _audit(sb, ctx.workspace_id, ctx.user_id, "routing_rule:update", rule_id, {"changes": updates})
    return row


@router.delete("/routing-rules/{rule_id}")
async def delete_rule(rule_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()

    lookup = sb.from_("model_routing_rules").select("id, name").eq("id", rule_id).eq("workspace_id", ctx.workspace_id).single().execute()
    if not lookup.data:
        raise HTTPException(404, "Routing rule not found")

    sb.from_("model_routing_rules").delete().eq("id", rule_id).eq("workspace_id", ctx.workspace_id).execute()
    _audit(sb, ctx.workspace_id, ctx.user_id, "routing_rule:delete", rule_id, {"name": lookup.data["name"]})
    return {"ok": True}
