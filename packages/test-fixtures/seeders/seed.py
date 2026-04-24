"""
Seed a dev workspace with 12 months of Acme AI synthetic data.
Usage:
    uv run python packages/test-fixtures/seeders/seed.py --workspace <uuid>
Refuses to run against production:
    SUPABASE_URL contains 'anvx-dev' or 'localhost' → allowed.
    Anything else → error out.
"""
from __future__ import annotations
import argparse
import hashlib
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from supabase import create_client

RNG = random.Random(42)  # deterministic seed across runs

def require_dev_supabase():
    url = os.environ.get("SUPABASE_URL", "")
    if not url:
        sys.exit("SUPABASE_URL not set")
    if "anvx-prod" in url:
        sys.exit(f"REFUSING to seed against non-dev Supabase: {url}")
    return url

def sb_service():
    url = require_dev_supabase()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set")
    return create_client(url, key)

def seed_routing_usage(sb, workspace_id: str, token_id: str):
    """12 months x ~50 requests/day = ~18k rows. Realistic model mix."""
    models = [
        ("openai", "gpt-4o-mini", 200, 100, 15, 60),
        ("openai", "gpt-4o", 400, 200, 300, 1200),
        ("anthropic", "claude-haiku-3.5", 250, 150, 80, 400),
        ("anthropic", "claude-sonnet-4", 500, 250, 300, 1500),
        ("google", "gemini-flash-1.5", 300, 120, 10, 40),
    ]
    rows = []
    now = datetime.now(timezone.utc)
    for day_offset in range(365):
        d = now - timedelta(days=day_offset)
        n_reqs = RNG.randint(30, 80)
        for _ in range(n_reqs):
            provider, model, tin_med, tout_med, pin, pout = RNG.choice(models)
            tin = int(RNG.gauss(tin_med, tin_med * 0.3))
            tout = int(RNG.gauss(tout_med, tout_med * 0.3))
            tin = max(10, tin)
            tout = max(5, tout)
            cost = (tin * pin + tout * pout) // 1_000_000
            rows.append({
                "workspace_id": workspace_id,
                "token_id": token_id,
                "request_id": hashlib.sha1(f"{d.isoformat()}:{_}".encode()).hexdigest()[:16],
                "model_requested": model,
                "model_routed": model,
                "provider": provider,
                "tokens_in": tin,
                "tokens_out": tout,
                "provider_cost_cents": cost,
                "markup_cents": 0,
                "decision": "passthrough",
                "upstream_latency_ms": RNG.randint(200, 1200),
                "total_latency_ms": RNG.randint(250, 1400),
                "created_at": d.isoformat(),
            })
    # Insert in batches of 500
    for i in range(0, len(rows), 500):
        sb.table("routing_usage_records").insert(rows[i:i+500]).execute()
    print(f"  seeded {len(rows)} routing_usage_records")

def seed_connector_usage(sb, workspace_id: str):
    """Monthly cloud bills from connectors: AWS, Vercel, Stripe (we earn rev), etc."""
    # You'll implement this after Day 23 connectors are exercised — today seed zero rows.
    # Intentional: forces the tests to surface the gap.
    print(f"  skipped connector usage_records — wire up after Day 23")

def seed_routing_rules(sb, workspace_id: str, owner_user_id: str):
    # The 3 standard rules — may already exist from the Day 3 Clerk webhook.
    # Idempotent via on-conflict.
    rules = [
        ("Code generation", ["anthropic/claude-sonnet-4", "openai/gpt-4o"], 80, 20),
        ("Classification & extraction", ["anthropic/claude-haiku-3.5", "google/gemini-flash-1.5", "openai/gpt-4o-mini"], 30, 70),
        ("Agent planning", ["anthropic/claude-opus-4"], 100, 0),
    ]
    for name, models, qp, cp in rules:
        try:
            sb.table("model_routing_rules").insert({
                "workspace_id": workspace_id, "name": name,
                "approved_models": models,
                "quality_priority": qp, "cost_priority": cp,
                "created_by_user_id": owner_user_id,
            }).execute()
        except Exception as e:
            if "duplicate" not in str(e).lower(): raise
    print("  seeded model_routing_rules (3)")

def seed_budget_policy(sb, workspace_id: str, owner_user_id: str):
    try:
        sb.table("budget_policies").insert({
            "workspace_id": workspace_id,
            "name": "LLM daily alert",
            "scope_provider": None,
            "daily_limit_cents": 150000,  # $1500
            "action": "alert_only",
            "fail_mode": "open",
            "enabled": True,
            "created_by_user_id": owner_user_id,
        }).execute()
        print("  seeded budget_policies (1)")
    except Exception as e:
        if "duplicate" not in str(e).lower(): raise

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--reset", action="store_true", help="Wipe existing seeded data first")
    args = ap.parse_args()

    sb = sb_service()

    # Find the workspace and its owner
    ws = sb.table("workspaces").select("id, name").eq("id", args.workspace).maybe_single().execute().data
    if not ws:
        sys.exit(f"Workspace not found: {args.workspace}")
    print(f"Seeding workspace '{ws['name']}' ({ws['id']})")

    owner = sb.table("workspace_members").select("user_id").eq("workspace_id", args.workspace).eq("role", "owner").limit(1).execute().data
    if not owner:
        sys.exit("No owner found on workspace")
    owner_user_id = owner[0]["user_id"]

    # Find an anvx_api_token for this workspace (required for routing_usage_records FK)
    tokens = sb.table("anvx_api_tokens").select("id").eq("workspace_id", args.workspace).limit(1).execute().data
    if not tokens:
        sys.exit("No anvx_api_tokens for this workspace — mint one via /settings/tokens first")
    token_id = tokens[0]["id"]

    if args.reset:
        print("Resetting seeded data...")
        sb.table("routing_usage_records").delete().eq("workspace_id", args.workspace).execute()
        sb.table("model_routing_rules").delete().eq("workspace_id", args.workspace).execute()
        sb.table("budget_policies").delete().eq("workspace_id", args.workspace).execute()

    print("Seeding...")
    seed_routing_usage(sb, args.workspace, token_id)
    seed_connector_usage(sb, args.workspace)
    seed_routing_rules(sb, args.workspace, owner_user_id)
    seed_budget_policy(sb, args.workspace, owner_user_id)
    print("Done.")

if __name__ == "__main__":
    main()
