"""Capability-aware key validation.

Every connector exposes a `validate_key(api_key)` capability via this module's
dispatcher. The result tells the caller (1) whether the key is structurally
valid, (2) what tier it is (standard / admin / restricted_*), and (3) which
capabilities the key actually unlocks (historical usage, live tracking,
billing data, transactions, account metadata).

Connector code that fetches data must check capabilities before calling
endpoints that would otherwise 401/403. The API layer enforces this at sync
time so that a missing capability returns 200 with `ok: false` rather than
crashing the request.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import TypedDict, NotRequired

import httpx

# ── Capability tags ──────────────────────────────────────────────
# - historical_usage : can pull retroactive usage / cost data
# - live_tracking    : routing engine can observe new traffic for this provider
# - billing_data     : can read aggregated billing / cost data
# - transactions     : can read individual transactions (Stripe charges, etc.)
# - account_metadata : can read /account or whoami
CAPABILITIES_ALL = {
    "historical_usage",
    "live_tracking",
    "billing_data",
    "transactions",
    "account_metadata",
}


class ValidationResult(TypedDict, total=False):
    valid: bool
    tier: str
    capabilities: list[str]
    error: NotRequired[str]
    warnings: NotRequired[list[str]]


def _ok(tier: str, capabilities: list[str], warnings: list[str] | None = None) -> ValidationResult:
    out: ValidationResult = {"valid": True, "tier": tier, "capabilities": capabilities}
    if warnings:
        out["warnings"] = warnings
    return out


def _bad(error: str) -> ValidationResult:
    return {"valid": False, "tier": "invalid", "capabilities": [], "error": error}


# ── Anthropic ────────────────────────────────────────────────────

async def _validate_anthropic(api_key: str) -> ValidationResult:
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            base_resp = await client.get("https://api.anthropic.com/v1/models", headers=headers)
            if base_resp.status_code == 401:
                return _bad("Invalid Anthropic API key")
            if base_resp.status_code >= 400 and base_resp.status_code != 403:
                return _bad(f"Anthropic /v1/models returned {base_resp.status_code}")

            # Probe admin tier — usage_report only works with sk-ant-admin keys.
            today = datetime.now(timezone.utc).date()
            yday = today - timedelta(days=1)
            admin_resp = await client.get(
                "https://api.anthropic.com/v1/organizations/usage_report/messages",
                headers=headers,
                params={"starting_at": f"{yday}T00:00:00Z", "limit": 1},
            )
            if admin_resp.status_code == 200:
                return _ok("admin", ["historical_usage", "live_tracking", "account_metadata"])
            return _ok(
                "standard",
                ["live_tracking", "account_metadata"],
                warnings=[
                    "Standard Anthropic key — historical usage requires an admin key. "
                    "Create one at https://console.anthropic.com/settings/admin-keys"
                ],
            )
    except httpx.HTTPError as e:
        return _bad(f"Anthropic validation failed: {e}")


# ── OpenAI ───────────────────────────────────────────────────────

async def _validate_openai(api_key: str) -> ValidationResult:
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            base_resp = await client.get("https://api.openai.com/v1/models", headers=headers)
            if base_resp.status_code == 401:
                return _bad("Invalid OpenAI API key")
            if base_resp.status_code >= 400:
                return _bad(f"OpenAI /v1/models returned {base_resp.status_code}")

            # Probe admin tier — /v1/organization/usage requires sk-admin-...
            today = datetime.now(timezone.utc)
            start = int((today - timedelta(days=1)).timestamp())
            admin_resp = await client.get(
                "https://api.openai.com/v1/organization/usage/completions",
                headers=headers,
                params={"start_time": start, "limit": 1},
            )
            if admin_resp.status_code == 200:
                return _ok("admin", ["historical_usage", "live_tracking", "account_metadata"])
            return _ok(
                "standard",
                ["live_tracking", "account_metadata"],
                warnings=[
                    "Standard OpenAI key — historical usage requires an admin key. "
                    "Create one at https://platform.openai.com/settings/organization/admin-keys"
                ],
            )
    except httpx.HTTPError as e:
        return _bad(f"OpenAI validation failed: {e}")


# ── Stripe ───────────────────────────────────────────────────────

async def _validate_stripe(api_key: str) -> ValidationResult:
    headers = {"Authorization": f"Bearer {api_key}"}
    is_restricted = api_key.startswith("rk_")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            acc_resp = await client.get("https://api.stripe.com/v1/account", headers=headers)
            if acc_resp.status_code == 401:
                return _bad("Invalid Stripe API key")
            if acc_resp.status_code == 403:
                # Restricted key with no /v1/account access — try /v1/charges as a fallback
                ch_resp = await client.get(
                    "https://api.stripe.com/v1/charges",
                    headers=headers,
                    params={"limit": 1},
                )
                if ch_resp.status_code >= 400:
                    return _bad(
                        f"Stripe key has no readable scope (account={acc_resp.status_code}, "
                        f"charges={ch_resp.status_code})"
                    )

            # Probe transactions read access
            bt_resp = await client.get(
                "https://api.stripe.com/v1/balance_transactions",
                headers=headers,
                params={"limit": 1},
            )
            has_txns = bt_resp.status_code == 200

            if not is_restricted:
                return _ok(
                    "standard",
                    ["transactions", "account_metadata"] if has_txns else ["account_metadata"],
                )
            if has_txns:
                return _ok("restricted_full", ["transactions", "account_metadata"])
            return _ok(
                "restricted_limited",
                ["account_metadata"],
                warnings=[
                    f"Restricted key missing permission for /v1/balance_transactions "
                    f"({bt_resp.status_code}) — partial data. Increase scope at "
                    f"https://dashboard.stripe.com/apikeys"
                ],
            )
    except httpx.HTTPError as e:
        return _bad(f"Stripe validation failed: {e}")


# ── AWS ──────────────────────────────────────────────────────────
# Reuse the existing connector's validate() (which signs SigV4 against
# Cost Explorer) to detect billing access. STS happens implicitly inside it.

async def _validate_aws(api_key: str) -> ValidationResult:
    try:
        creds = json.loads(api_key)
    except (json.JSONDecodeError, TypeError):
        return _bad("Invalid AWS credentials JSON")
    if not creds.get("access_key_id") or not creds.get("secret_access_key"):
        return _bad("Missing AWS access_key_id or secret_access_key")

    from . import REGISTRY  # late import to avoid cycle
    aws = REGISTRY.get("aws")
    if aws is None:
        return _bad("AWS connector not registered")
    try:
        await aws.validate(api_key)  # type: ignore[attr-defined]
        return _ok("iam_with_billing", ["historical_usage", "billing_data", "account_metadata"])
    except PermissionError as e:
        msg = str(e).lower()
        if "access" in msg or "permission" in msg or "denied" in msg or "forbidden" in msg:
            return _ok(
                "iam_no_billing",
                ["account_metadata"],
                warnings=[
                    "IAM key lacks ce:GetCostAndUsage — historical billing unavailable. "
                    "Add ce:GetCostAndUsage to the IAM policy."
                ],
            )
        return _bad(f"AWS validation failed: {e}")
    except Exception as e:  # noqa: BLE001
        return _bad(f"AWS validation failed: {e}")


# ── GCP ──────────────────────────────────────────────────────────

async def _validate_gcp(api_key: str) -> ValidationResult:
    try:
        json.loads(api_key)
    except (json.JSONDecodeError, TypeError):
        return _bad("Invalid GCP service account JSON")

    from . import REGISTRY
    gcp = REGISTRY.get("gcp")
    if gcp is None:
        return _bad("GCP connector not registered")
    try:
        await gcp.validate(api_key)  # type: ignore[attr-defined]
        return _ok("sa_with_billing", ["historical_usage", "billing_data", "account_metadata"])
    except PermissionError as e:
        msg = str(e).lower()
        if "permission" in msg or "denied" in msg or "forbidden" in msg or "billing" in msg:
            return _ok(
                "sa_no_billing",
                ["account_metadata"],
                warnings=[
                    "Service account lacks billing access. Grant the BigQuery Data Viewer "
                    "role on your billing dataset."
                ],
            )
        return _bad(f"GCP validation failed: {e}")
    except Exception as e:  # noqa: BLE001
        return _bad(f"GCP validation failed: {e}")


# ── Generic fallback ────────────────────────────────────────────

async def _validate_generic(provider: str, api_key: str) -> ValidationResult:
    """For connectors with a single key tier today: success = standard."""
    from . import REGISTRY
    conn = REGISTRY.get(provider)
    if conn is None:
        return _bad(f"Unknown provider: {provider}")
    try:
        await conn.validate(api_key)  # type: ignore[attr-defined]
    except PermissionError as e:
        return _bad(str(e))
    except Exception as e:  # noqa: BLE001
        return _bad(f"{provider} validation failed: {e}")

    # Most non-LLM/non-cloud providers expose historical usage by default.
    # LLM providers without admin tiers get live_tracking only.
    llm_no_history = {"google_ai", "cohere", "replicate", "together", "fireworks"}
    if provider in llm_no_history:
        return _ok("standard", ["live_tracking", "account_metadata"])
    return _ok("standard", ["historical_usage", "account_metadata"])


# ── Dispatcher ──────────────────────────────────────────────────

_VALIDATORS = {
    "anthropic": _validate_anthropic,
    "openai": _validate_openai,
    "stripe": _validate_stripe,
    "aws": _validate_aws,
    "gcp": _validate_gcp,
}


async def validate_key(provider: str, api_key: str) -> ValidationResult:
    """Validate an api_key for the given provider, returning capability info."""
    fn = _VALIDATORS.get(provider)
    if fn is not None:
        return await fn(api_key)
    return await _validate_generic(provider, api_key)
