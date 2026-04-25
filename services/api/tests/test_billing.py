"""Tests for billing endpoints.

Auth is patched the same way as test_tokens.py: stub `_verify_jwt` and
`resolve_workspace_member` so the FastAPI dependency tree resolves a
WorkspaceContext without a real Clerk JWT. Stripe is patched via
`app.routers.billing._stripe`.
"""
from unittest.mock import MagicMock, patch

import pytest


def _mock_sb_query(return_data) -> MagicMock:
    """Mimic supabase-py's chain so tests can drive `.execute().data`."""
    result = MagicMock()
    result.data = return_data
    chain = MagicMock()
    chain.execute.return_value = result
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.in_.return_value = chain
    chain.is_.return_value = chain
    chain.order.return_value = chain
    chain.limit.return_value = chain
    chain.single.return_value = chain
    chain.update.return_value = chain
    chain.insert.return_value = chain
    return chain


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def _stub_stripe_session(url="https://checkout.stripe.com/c/sess_test", session_id="cs_test_123"):
    stripe_mod = MagicMock()
    stripe_mod.checkout.Session.create.return_value = MagicMock(id=session_id, url=url)
    return stripe_mod


# ── Tests ────────────────────────────────────────────────────────


@patch("app.routers.billing._stripe")
@patch("app.routers.billing.sb_service")
@patch("app.db.resolve_workspace_member")
@patch("app.auth._verify_jwt")
def test_checkout_pack_returns_session_url(mock_jwt, mock_resolve, mock_sb, mock_stripe, client):
    mock_jwt.return_value = {"user_id": "clerk_u1", "workspace_id": "org_1", "email": "t@t.com"}
    mock_resolve.return_value = {"user_id": "u-1", "workspace_id": "ws-1", "role": "admin"}

    pack_id = "pack-1"
    sb = MagicMock()

    def from_side(table):
        if table == "packs":
            return _mock_sb_query([
                {"id": pack_id, "kind": "close_pack", "status": "requested", "workspace_id": "ws-1"},
            ])
        return _mock_sb_query([])
    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    mock_stripe.return_value = _stub_stripe_session()

    # Configure the price ID so the endpoint reaches Stripe
    from app.routers import billing as billing_mod
    billing_mod.settings.stripe_close_pack_price_id = "price_close_x"
    billing_mod.settings.webapp_base_url = "http://localhost:3000"

    resp = client.post(
        "/api/v2/billing/checkout/pack",
        json={"pack_id": pack_id},
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["checkout_url"] == "https://checkout.stripe.com/c/sess_test"

    # Stripe was called with the right shape
    create = mock_stripe.return_value.checkout.Session.create
    assert create.called
    kwargs = create.call_args.kwargs
    assert kwargs["mode"] == "payment"
    assert kwargs["line_items"] == [{"price": "price_close_x", "quantity": 1}]
    assert kwargs["metadata"]["pack_id"] == pack_id
    assert kwargs["metadata"]["workspace_id"] == "ws-1"
    assert kwargs["metadata"]["kind"] == "close_pack"
    assert "purchased=true" in kwargs["success_url"]
    assert "canceled=true" in kwargs["cancel_url"]


@patch("app.routers.billing._stripe")
@patch("app.routers.billing.sb_service")
@patch("app.db.resolve_workspace_member")
@patch("app.auth._verify_jwt")
def test_checkout_pack_already_paid_returns_409(mock_jwt, mock_resolve, mock_sb, mock_stripe, client):
    mock_jwt.return_value = {"user_id": "clerk_u1", "workspace_id": "org_1", "email": "t@t.com"}
    mock_resolve.return_value = {"user_id": "u-1", "workspace_id": "ws-1", "role": "admin"}

    sb = MagicMock()
    def from_side(table):
        if table == "packs":
            # Status is 'ready' — already past the requested stage
            return _mock_sb_query([
                {"id": "pack-1", "kind": "close_pack", "status": "ready", "workspace_id": "ws-1"},
            ])
        return _mock_sb_query([])
    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    mock_stripe.return_value = _stub_stripe_session()

    resp = client.post(
        "/api/v2/billing/checkout/pack",
        json={"pack_id": "pack-1"},
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 409
    assert "ready" in resp.json()["detail"]
    # Stripe must not have been touched
    mock_stripe.return_value.checkout.Session.create.assert_not_called()


@patch("app.routers.billing._stripe")
@patch("app.routers.billing.sb_service")
@patch("app.db.resolve_workspace_member")
@patch("app.auth._verify_jwt")
def test_checkout_pack_wrong_workspace_returns_404(mock_jwt, mock_resolve, mock_sb, mock_stripe, client):
    mock_jwt.return_value = {"user_id": "clerk_u1", "workspace_id": "org_1", "email": "t@t.com"}
    mock_resolve.return_value = {"user_id": "u-1", "workspace_id": "ws-1", "role": "admin"}

    sb = MagicMock()
    # Empty result simulates RLS / wrong workspace_id filter
    sb.from_.return_value = _mock_sb_query([])
    mock_sb.return_value = sb

    mock_stripe.return_value = _stub_stripe_session()

    resp = client.post(
        "/api/v2/billing/checkout/pack",
        json={"pack_id": "pack-other-workspace"},
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 404
    mock_stripe.return_value.checkout.Session.create.assert_not_called()


@patch("app.routers.billing._stripe")
@patch("app.routers.billing.sb_service")
@patch("app.db.resolve_workspace_member")
@patch("app.auth._verify_jwt")
def test_audit_trail_export_returns_free_without_stripe(mock_jwt, mock_resolve, mock_sb, mock_stripe, client):
    mock_jwt.return_value = {"user_id": "clerk_u1", "workspace_id": "org_1", "email": "t@t.com"}
    mock_resolve.return_value = {"user_id": "u-1", "workspace_id": "ws-1", "role": "admin"}

    sb = MagicMock()
    def from_side(table):
        if table == "packs":
            return _mock_sb_query([
                {"id": "pack-free", "kind": "audit_trail_export", "status": "requested", "workspace_id": "ws-1"},
            ])
        return _mock_sb_query([])
    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    mock_stripe.return_value = _stub_stripe_session()

    resp = client.post(
        "/api/v2/billing/checkout/pack",
        json={"pack_id": "pack-free"},
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"free": True}
    # Stripe was never invoked
    mock_stripe.return_value.checkout.Session.create.assert_not_called()
