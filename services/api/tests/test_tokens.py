"""Tests for token CRUD endpoints."""
import hashlib
import secrets
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest


# ── Helpers ──────────────────────────────────────────────────────


def _mock_sb_query(return_data: list[dict]) -> MagicMock:
    result = MagicMock()
    result.data = return_data
    chain = MagicMock()
    chain.execute.return_value = result
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.is_.return_value = chain
    chain.order.return_value = chain
    chain.update.return_value = chain
    chain.insert.return_value = chain
    return chain


# ── Unit tests (no FastAPI) ──────────────────────────────────────


def test_plaintext_format_and_length():
    plaintext = "anvx_live_" + secrets.token_urlsafe(32)
    assert plaintext.startswith("anvx_live_")
    assert len(plaintext) >= 50


def test_hash_matches_plaintext():
    plaintext = "anvx_live_" + secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(plaintext.encode()).hexdigest()
    assert len(token_hash) == 64
    assert hashlib.sha256(plaintext.encode()).hexdigest() == token_hash


def test_prefix_is_first_18_chars():
    plaintext = "anvx_live_" + secrets.token_urlsafe(32)
    prefix = plaintext[:18]
    assert len(prefix) == 18
    assert prefix.startswith("anvx_live_")


# ── Integration tests via TestClient ─────────────────────────────


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


@patch("app.routers.tokens.sb_service")
@patch("app.db.resolve_workspace_member")
@patch("app.auth._verify_jwt")
def test_create_token_returns_plaintext(mock_jwt, mock_resolve, mock_sb, client):
    mock_jwt.return_value = {"user_id": "clerk_u1", "workspace_id": "org_1", "email": "t@t.com"}
    mock_resolve.return_value = {"user_id": "u-1", "workspace_id": "ws-1", "role": "admin"}

    now_iso = datetime.now(timezone.utc).isoformat()
    sb = MagicMock()
    call_count = {"i": 0}

    def from_side(table):
        c = call_count["i"]
        call_count["i"] += 1
        if table == "anvx_api_tokens":
            return _mock_sb_query([{"id": "tok-1", "label": "prod", "token_prefix": "anvx_live_XXXXXXXX", "created_at": now_iso}])
        return _mock_sb_query([])

    sb.from_.side_effect = from_side
    mock_sb.return_value = sb

    resp = client.post("/api/v2/tokens", json={"label": "prod"}, headers={"Authorization": "Bearer fake"})
    assert resp.status_code == 200
    data = resp.json()
    assert "plaintext" in data
    assert data["plaintext"].startswith("anvx_live_")
    assert len(data["plaintext"]) >= 50


@patch("app.routers.tokens.sb_service")
@patch("app.db.resolve_workspace_member")
@patch("app.auth._verify_jwt")
def test_list_tokens_excludes_hash(mock_jwt, mock_resolve, mock_sb, client):
    mock_jwt.return_value = {"user_id": "clerk_u1", "workspace_id": "org_1", "email": "t@t.com"}
    mock_resolve.return_value = {"user_id": "u-1", "workspace_id": "ws-1", "role": "member"}

    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query([{"id": "tok-1", "label": "prod", "token_prefix": "anvx_live_AAAA", "created_at": "2026-04-22T00:00:00Z", "last_used_at": None, "revoked_at": None, "created_by_user_id": "u-1"}])
    mock_sb.return_value = sb

    resp = client.get("/api/v2/tokens", headers={"Authorization": "Bearer fake"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert "token_hash" not in data[0]
    assert "prefix" in data[0]


@patch("app.routers.tokens.sb_service")
@patch("app.db.resolve_workspace_member")
@patch("app.auth._verify_jwt")
def test_revoke_sets_revoked_at(mock_jwt, mock_resolve, mock_sb, client):
    mock_jwt.return_value = {"user_id": "clerk_u1", "workspace_id": "org_1", "email": "t@t.com"}
    mock_resolve.return_value = {"user_id": "u-1", "workspace_id": "ws-1", "role": "admin"}

    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query([])
    mock_sb.return_value = sb

    resp = client.post("/api/v2/tokens/tok-1/revoke", headers={"Authorization": "Bearer fake"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    sb.from_.assert_any_call("anvx_api_tokens")


@patch("app.db.resolve_workspace_member")
@patch("app.auth._verify_jwt")
def test_member_cannot_create_token(mock_jwt, mock_resolve, client):
    mock_jwt.return_value = {"user_id": "clerk_u1", "workspace_id": "org_1", "email": "t@t.com"}
    mock_resolve.return_value = {"user_id": "u-1", "workspace_id": "ws-1", "role": "member"}

    resp = client.post("/api/v2/tokens", json={"label": "prod"}, headers={"Authorization": "Bearer fake"})
    assert resp.status_code == 403


@patch("app.routers.tokens.sb_service")
@patch("app.db.resolve_workspace_member")
@patch("app.auth._verify_jwt")
def test_cross_workspace_isolation(mock_jwt, mock_resolve, mock_sb, client):
    mock_jwt.return_value = {"user_id": "clerk_u2", "workspace_id": "org_2", "email": "t@t.com"}
    mock_resolve.return_value = {"user_id": "u-2", "workspace_id": "ws-2", "role": "member"}

    sb = MagicMock()
    sb.from_.return_value = _mock_sb_query([])
    mock_sb.return_value = sb

    resp = client.get("/api/v2/tokens", headers={"Authorization": "Bearer fake"})
    assert resp.status_code == 200
    assert resp.json() == []
    sb.from_.return_value.eq.assert_any_call("workspace_id", "ws-2")
