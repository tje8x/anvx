import os
import time

import pytest
from fastapi.testclient import TestClient
from jose import jwt

SUPABASE_JWT_SECRET = os.environ["SUPABASE_JWT_SECRET"]


def mint_jwt(user_id: str, workspace_id: str, email: str = "test@example.com") -> str:
    claims = {
        "aud": "authenticated",
        "role": "authenticated",
        "user_id": user_id,
        "workspace_id": workspace_id,
        "email": email,
        "exp": int(time.time()) + 600,
    }
    return jwt.encode(claims, SUPABASE_JWT_SECRET, algorithm="HS256")


@pytest.fixture
def client():
    from app.main import app
    return TestClient(app)


def test_missing_bearer_returns_401(client: TestClient):
    resp = client.get("/api/v2/workspace/me")
    assert resp.status_code == 401


def test_tampered_signature_returns_401(client: TestClient):
    token = mint_jwt("user_test", "org_test")
    corrupted = token[:-3] + "xxx"
    resp = client.get("/api/v2/workspace/me", headers={"Authorization": f"Bearer {corrupted}"})
    assert resp.status_code == 401


def test_valid_token_but_no_membership_returns_403(client: TestClient):
    token = mint_jwt("user_nonexistent_abc", "org_nonexistent_abc")
    resp = client.get("/api/v2/workspace/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
