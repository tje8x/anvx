import base64
from uuid import UUID

import pytest

from anvx_core.crypto import decrypt, encrypt

FAKE_MASTER_KEY = base64.b64encode(b"A" * 32).decode("ascii")
WS_A = UUID("11111111-1111-1111-1111-111111111111")
WS_B = UUID("22222222-2222-2222-2222-222222222222")


def test_roundtrip_same_workspace(monkeypatch):
    monkeypatch.setenv("ANVX_MASTER_ENCRYPTION_KEY", FAKE_MASTER_KEY)
    plaintext = "sk-test-abc123"
    ct = encrypt(plaintext, WS_A)
    result = decrypt(ct, WS_A)
    assert result == plaintext


def test_cross_workspace_fails(monkeypatch):
    monkeypatch.setenv("ANVX_MASTER_ENCRYPTION_KEY", FAKE_MASTER_KEY)
    ct = encrypt("sk-test-abc123", WS_A)
    with pytest.raises(Exception):
        decrypt(ct, WS_B)


def test_tampered_ciphertext_fails(monkeypatch):
    monkeypatch.setenv("ANVX_MASTER_ENCRYPTION_KEY", FAKE_MASTER_KEY)
    ct = encrypt("sk-test-abc123", WS_A)
    raw = bytearray(base64.b64decode(ct))
    raw[-1] ^= 0xFF  # flip last byte
    tampered = base64.b64encode(raw).decode("ascii")
    with pytest.raises(Exception):
        decrypt(tampered, WS_A)


def test_different_nonces(monkeypatch):
    monkeypatch.setenv("ANVX_MASTER_ENCRYPTION_KEY", FAKE_MASTER_KEY)
    ct1 = encrypt("same-plaintext", WS_A)
    ct2 = encrypt("same-plaintext", WS_A)
    assert ct1 != ct2


def test_empty_plaintext_rejected(monkeypatch):
    monkeypatch.setenv("ANVX_MASTER_ENCRYPTION_KEY", FAKE_MASTER_KEY)
    with pytest.raises(ValueError):
        encrypt("", WS_A)
