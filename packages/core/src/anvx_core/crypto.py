import base64
import os
from uuid import UUID
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_HKDF_INFO = b"anvx-dek-v1"
_NONCE_LEN = 12


def _master_key() -> bytes:
    raw = os.environ["ANVX_MASTER_ENCRYPTION_KEY"]
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise ValueError("ANVX_MASTER_ENCRYPTION_KEY must decode to 32 bytes")
    return key


def derive_workspace_dek(workspace_id: UUID) -> bytes:
    salt = workspace_id.bytes
    hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=_HKDF_INFO)
    return hkdf.derive(_master_key())


def encrypt(plaintext: str, workspace_id: UUID) -> str:
    if not plaintext:
        raise ValueError("plaintext must not be empty")
    dek = derive_workspace_dek(workspace_id)
    nonce = os.urandom(_NONCE_LEN)
    aesgcm = AESGCM(dek)
    ct = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), associated_data=None)
    return base64.b64encode(nonce + ct).decode("ascii")


def decrypt(ciphertext_b64: str, workspace_id: UUID) -> str:
    blob = base64.b64decode(ciphertext_b64)
    nonce, ct = blob[:_NONCE_LEN], blob[_NONCE_LEN:]
    dek = derive_workspace_dek(workspace_id)
    aesgcm = AESGCM(dek)
    pt = aesgcm.decrypt(nonce, ct, associated_data=None)
    return pt.decode("utf-8")
