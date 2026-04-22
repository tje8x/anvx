import base64

import pytest

from anvx_core.crypto import decrypt_api_key, encrypt_api_key

FAKE_MASTER_KEY = base64.b64encode(b"A" * 32).decode("ascii")
WS_A = "11111111-1111-1111-1111-111111111111"
WS_B = "22222222-2222-2222-2222-222222222222"


def test_roundtrip(monkeypatch):
    monkeypatch.setenv("ANVX_MASTER_ENCRYPTION_KEY", FAKE_MASTER_KEY)
    plaintext = "sk-test-abc"
    envelope = encrypt_api_key(WS_A, plaintext)
    result = decrypt_api_key(WS_A, envelope)
    assert result == plaintext


def test_cross_workspace_fails(monkeypatch):
    monkeypatch.setenv("ANVX_MASTER_ENCRYPTION_KEY", FAKE_MASTER_KEY)
    envelope = encrypt_api_key(WS_A, "sk-test-abc")
    with pytest.raises(Exception):
        decrypt_api_key(WS_B, envelope)


def test_empty_rejected(monkeypatch):
    monkeypatch.setenv("ANVX_MASTER_ENCRYPTION_KEY", FAKE_MASTER_KEY)
    with pytest.raises(ValueError):
        encrypt_api_key(WS_A, "")
