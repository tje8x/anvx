"""Billing endpoints: one-shot pack checkout + metered subscription scaffold.

Stripe is imported lazily so a missing `stripe` package or unset env var
surfaces as a 503 on the request, not as an import-time crash that kills the
whole API.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import WorkspaceContext, require_role
from ..db import sb_service
from ..settings import settings

router = APIRouter()


KIND_TO_PRICE_ATTR = {
    "close_pack": "stripe_close_pack_price_id",
    "ai_audit_pack": "stripe_ai_audit_pack_price_id",
}


def _stripe():
    """Lazy import + configure stripe. Raises 503 if unusable."""
    if not settings.stripe_secret_key:
        raise HTTPException(503, "Stripe is not configured (STRIPE_SECRET_KEY missing)")
    try:
        import stripe  # type: ignore
    except ImportError:
        raise HTTPException(503, "Stripe SDK not installed on this server")
    stripe.api_key = settings.stripe_secret_key
    return stripe


def _audit(sb, workspace_id: str, actor_user_id: str, action: str, target_kind: str, target_id: str, details: dict | None = None) -> None:
    sb.from_("audit_log").insert({
        "workspace_id": workspace_id,
        "actor_user_id": actor_user_id,
        "action": action,
        "target_kind": target_kind,
        "target_id": target_id,
        "details": details or {},
    }).execute()


# ─── Pack checkout ──────────────────────────────────────────────


class PackCheckoutBody(BaseModel):
    pack_id: str


@router.post("/billing/checkout/pack")
async def checkout_pack(body: PackCheckoutBody, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()

    pack_rows = (
        sb.from_("packs")
        .select("id, kind, status, workspace_id")
        .eq("id", body.pack_id)
        .eq("workspace_id", ctx.workspace_id)
        .limit(1)
        .execute()
    ).data or []
    if not pack_rows:
        raise HTTPException(404, "Pack not found")
    pack = pack_rows[0]

    if pack["status"] != "requested":
        raise HTTPException(409, f"Pack is in status {pack['status']!r}; cannot initiate checkout")

    kind = pack["kind"]
    if kind == "audit_trail_export":
        return {"free": True}

    price_attr = KIND_TO_PRICE_ATTR.get(kind)
    if not price_attr:
        raise HTTPException(400, f"Unsupported pack kind for checkout: {kind}")
    price_id = getattr(settings, price_attr, None)
    if not price_id:
        raise HTTPException(503, f"Stripe price ID not configured for {kind}")

    stripe = _stripe()
    try:
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=f"{settings.webapp_base_url}/reports?pack_id={body.pack_id}&purchased=true",
            cancel_url=f"{settings.webapp_base_url}/reports?pack_id={body.pack_id}&canceled=true",
            metadata={
                "pack_id": str(body.pack_id),
                "workspace_id": str(ctx.workspace_id),
                "kind": kind,
            },
            customer_email=ctx.email or None,
        )
    except Exception as e:
        raise HTTPException(502, f"Stripe checkout creation failed: {e}")

    sb.from_("packs").update({
        "stripe_checkout_session_id": session.id,
    }).eq("id", body.pack_id).eq("workspace_id", ctx.workspace_id).execute()

    _audit(sb, ctx.workspace_id, ctx.user_id, "pack:checkout_initiated", "pack", body.pack_id, {
        "kind": kind,
        "stripe_checkout_session_id": session.id,
        "price_id": price_id,
    })

    return {"checkout_url": session.url}


# ─── Subscription scaffold ──────────────────────────────────────


@router.post("/billing/subscription")
async def create_subscription(ctx: WorkspaceContext = Depends(require_role("admin"))):
    if not settings.stripe_metered_price_id:
        raise HTTPException(503, "Metered price ID not configured (STRIPE_METERED_PRICE_ID)")

    sb = sb_service()
    ws = (
        sb.from_("workspaces")
        .select("id, name, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id")
        .eq("id", ctx.workspace_id)
        .single()
        .execute()
    ).data
    if not ws:
        raise HTTPException(404, "Workspace not found")

    stripe = _stripe()

    # 1. Ensure a Stripe Customer exists
    customer_id = ws.get("stripe_customer_id")
    if not customer_id:
        try:
            customer = stripe.Customer.create(
                email=ctx.email or None,
                metadata={"workspace_id": str(ctx.workspace_id)},
            )
        except Exception as e:
            raise HTTPException(502, f"Stripe customer creation failed: {e}")
        customer_id = customer.id
        sb.from_("workspaces").update({"stripe_customer_id": customer_id}).eq("id", ctx.workspace_id).execute()

    # 2. Ensure a metered subscription exists
    subscription_id = ws.get("stripe_subscription_id")
    subscription_item_id = ws.get("stripe_subscription_item_id")
    if not subscription_id:
        try:
            subscription = stripe.Subscription.create(
                customer=customer_id,
                items=[{"price": settings.stripe_metered_price_id}],
                metadata={"workspace_id": str(ctx.workspace_id)},
                payment_behavior="default_incomplete",
                expand=["latest_invoice.payment_intent"],
            )
        except Exception as e:
            raise HTTPException(502, f"Stripe subscription creation failed: {e}")
        subscription_id = subscription.id
        items = getattr(subscription, "items", None) or {}
        item_data = (items.get("data") if isinstance(items, dict) else getattr(items, "data", None)) or []
        subscription_item_id = item_data[0].id if item_data else None
        sb.from_("workspaces").update({
            "stripe_subscription_id": subscription_id,
            "stripe_subscription_item_id": subscription_item_id,
            "subscription_status": getattr(subscription, "status", None),
        }).eq("id", ctx.workspace_id).execute()

    # 3. SetupIntent for card collection via Stripe Elements
    try:
        setup_intent = stripe.SetupIntent.create(
            customer=customer_id,
            usage="off_session",
            metadata={"workspace_id": str(ctx.workspace_id)},
        )
    except Exception as e:
        raise HTTPException(502, f"Stripe SetupIntent creation failed: {e}")

    _audit(sb, ctx.workspace_id, ctx.user_id, "subscription:created", "workspace", str(ctx.workspace_id), {
        "stripe_customer_id": customer_id,
        "stripe_subscription_id": subscription_id,
        "stripe_subscription_item_id": subscription_item_id,
    })

    return {
        "customer_id": customer_id,
        "subscription_id": subscription_id,
        "subscription_item_id": subscription_item_id,
        "setup_intent_client_secret": setup_intent.client_secret,
    }
