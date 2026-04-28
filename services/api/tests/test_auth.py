import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from app.main import app
    return TestClient(app)


def test_missing_bearer_returns_401(client: TestClient):
    resp = client.get("/api/v2/workspace/me")
    assert resp.status_code == 401


def test_invalid_token_returns_401(client: TestClient, monkeypatch):
    """If the JWT layer rejects the token, we surface 401."""
    from app import auth as auth_mod

    async def fake_verify(_request):
        raise HTTPException(401, "Invalid token: bad signature")

    monkeypatch.setattr(auth_mod, "_verify_jwt", fake_verify)
    resp = client.get(
        "/api/v2/workspace/me",
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


def test_valid_token_but_no_membership_returns_403(client: TestClient, monkeypatch):
    """A verified Clerk JWT for a user with no workspace membership → 403."""
    from app import auth as auth_mod

    async def fake_verify(_request):
        return {
            "sub": "user_nonexistent_abc",
            "o": {"id": "org_nonexistent_abc"},
            "email": "test@example.com",
        }

    monkeypatch.setattr(auth_mod, "_verify_jwt", fake_verify)
    resp = client.get(
        "/api/v2/workspace/me",
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 403
