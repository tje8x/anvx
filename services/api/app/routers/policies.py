from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


class PolicyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    scope_provider: str | None = None
    scope_project_tag: str | None = None
    scope_user_hint: str | None = None
    daily_limit_cents: int | None = Field(default=None, ge=0)
    monthly_limit_cents: int | None = Field(default=None, ge=0)
    per_request_limit_cents: int | None = Field(default=None, ge=0)
    circuit_breaker_multiplier: float | None = Field(default=None, ge=1.1, le=100)
    runway_alert_months: float | None = Field(default=None, ge=0, le=60)
    alert_at_pcts: list[int] = Field(default_factory=lambda: [80, 90])
    action: str = Field(pattern="^(alert_only|downgrade|pause)$")
    fail_mode: str = Field(default="open", pattern="^(open|closed)$")

    @model_validator(mode="after")
    def at_least_one_limit(self):
        if not any([self.daily_limit_cents is not None, self.monthly_limit_cents is not None, self.per_request_limit_cents is not None, self.circuit_breaker_multiplier is not None, self.runway_alert_months is not None]):
            raise ValueError("at least one of: daily_limit_cents, monthly_limit_cents, per_request_limit_cents, circuit_breaker_multiplier, runway_alert_months")
        return self


class PolicyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    scope_provider: str | None = None
    scope_project_tag: str | None = None
    scope_user_hint: str | None = None
    daily_limit_cents: int | None = Field(default=None, ge=0)
    monthly_limit_cents: int | None = Field(default=None, ge=0)
    per_request_limit_cents: int | None = Field(default=None, ge=0)
    circuit_breaker_multiplier: float | None = Field(default=None, ge=1.1, le=100)
    runway_alert_months: float | None = Field(default=None, ge=0, le=60)
    alert_at_pcts: list[int] | None = None
    action: str | None = Field(default=None, pattern="^(alert_only|downgrade|pause)$")
    fail_mode: str | None = Field(default=None, pattern="^(open|closed)$")


def check_downgrade_feasible(sb, workspace_id: str, action: str):
    if action != "downgrade":
        return
    res = sb.from_("routing_rules").select("approved_models").eq("workspace_id", workspace_id).eq("enabled", True).execute()
    has_multi = any(r for r in (res.data or []) if r.get("approved_models") and len(r["approved_models"]) > 1)
    if not has_multi:
        raise HTTPException(400, "action='downgrade' requires at least one enabled model_routing_rule with 2+ approved models. Create a multi-model rule first, or pick 'alert_only' or 'pause'.")


def _audit(sb, workspace_id: str, actor_user_id: str, action: str, target_id: str, details: dict | None = None):
    sb.from_("audit_log").insert({
        "workspace_id": workspace_id,
        "actor_user_id": actor_user_id,
        "action": action,
        "target_kind": "budget_policy",
        "target_id": target_id,
        "details": details or {},
    }).execute()


@router.get("/policies")
async def list_policies(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    result = sb.from_("budget_policies").select("*").eq("workspace_id", ctx.workspace_id).order("created_at").execute()
    return result.data or []


@router.post("/policies")
async def create_policy(body: PolicyCreate, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()
    check_downgrade_feasible(sb, ctx.workspace_id, body.action)

    try:
        result = sb.from_("budget_policies").insert({
            "workspace_id": ctx.workspace_id,
            "created_by_user_id": ctx.user_id,
            "name": body.name,
            "scope_provider": body.scope_provider,
            "scope_project_tag": body.scope_project_tag,
            "scope_user_hint": body.scope_user_hint,
            "daily_limit_cents": body.daily_limit_cents,
            "monthly_limit_cents": body.monthly_limit_cents,
            "per_request_limit_cents": body.per_request_limit_cents,
            "circuit_breaker_multiplier": body.circuit_breaker_multiplier,
            "runway_alert_months": body.runway_alert_months,
            "alert_at_pcts": body.alert_at_pcts,
            "action": body.action,
            "fail_mode": body.fail_mode,
        }).execute()
    except Exception as e:
        err_str = str(e)
        if "duplicate" in err_str.lower() or "unique" in err_str.lower() or "23505" in err_str:
            raise HTTPException(409, f"a policy named {body.name} already exists")
        raise

    row = result.data[0]
    _audit(sb, ctx.workspace_id, ctx.user_id, "budget_policy:create", row["id"], {"name": body.name, "action": body.action})
    return row


@router.patch("/policies/{policy_id}")
async def update_policy(policy_id: str, body: PolicyUpdate, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()

    lookup = sb.from_("budget_policies").select("*").eq("id", policy_id).eq("workspace_id", ctx.workspace_id).single().execute()
    if not lookup.data:
        raise HTTPException(404, "Budget policy not found")

    current = lookup.data
    updates: dict = {}
    for field_name in ["name", "scope_provider", "scope_project_tag", "scope_user_hint", "daily_limit_cents", "monthly_limit_cents", "per_request_limit_cents", "circuit_breaker_multiplier", "runway_alert_months", "alert_at_pcts", "action", "fail_mode"]:
        val = getattr(body, field_name, None)
        if val is not None:
            updates[field_name] = val

    if not updates:
        return current

    # Re-check downgrade feasibility if action is being changed or already downgrade
    effective_action = updates.get("action", current["action"])
    check_downgrade_feasible(sb, ctx.workspace_id, effective_action)

    try:
        result = sb.from_("budget_policies").update(updates).eq("id", policy_id).eq("workspace_id", ctx.workspace_id).execute()
    except Exception as e:
        err_str = str(e)
        if "duplicate" in err_str.lower() or "unique" in err_str.lower() or "23505" in err_str:
            raise HTTPException(409, f"a policy named {updates.get('name', body.name)} already exists")
        raise

    row = result.data[0] if result.data else {**current, **updates}
    _audit(sb, ctx.workspace_id, ctx.user_id, "budget_policy:update", policy_id, {"changes": updates})
    return row


@router.delete("/policies/{policy_id}")
async def delete_policy(policy_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()

    lookup = sb.from_("budget_policies").select("id, name").eq("id", policy_id).eq("workspace_id", ctx.workspace_id).single().execute()
    if not lookup.data:
        raise HTTPException(404, "Budget policy not found")

    sb.from_("budget_policies").delete().eq("id", policy_id).eq("workspace_id", ctx.workspace_id).execute()
    _audit(sb, ctx.workspace_id, ctx.user_id, "budget_policy:delete", policy_id, {"name": lookup.data["name"]})
    return {"ok": True}
