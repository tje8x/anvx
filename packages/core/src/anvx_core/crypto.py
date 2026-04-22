import base64
import os
from uuid import UUID
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_HKDF_INFO = b"anvx-provider-key-v1"
_NONCE_LEN = 12


def _master_key() -> bytes:
    raw = os.environ["ANVX_MASTER_ENCRYPTION_KEY"]
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise ValueError("ANVX_MASTER_ENCRYPTION_KEY must decode to 32 bytes")
    return key


def derive_dek(workspace_id: str) -> bytes:
    salt = UUID(workspace_id).bytes
    hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=_HKDF_INFO)
    return hkdf.derive(_master_key())


def encrypt_api_key(workspace_id: str, plaintext: str) -> dict:
    if not plaintext:
        raise ValueError("plaintext must not be empty")
    dek = derive_dek(workspace_id)
    nonce = os.urandom(_NONCE_LEN)
    aesgcm = AESGCM(dek)
    aad = workspace_id.encode("ascii")
    ct_with_tag = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), associated_data=aad)
    ct, tag = ct_with_tag[:-16], ct_with_tag[-16:]
    return {
        "v": 1,
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ct": base64.b64encode(ct).decode("ascii"),
        "tag": base64.b64encode(tag).decode("ascii"),
    }


def decrypt_api_key(workspace_id: str, envelope: dict) -> str:
    if envelope.get("v") != 1:
        raise ValueError(f"unsupported envelope version: {envelope.get('v')}")
    nonce = base64.b64decode(envelope["nonce"])
    ct = base64.b64decode(envelope["ct"])
    tag = base64.b64decode(envelope["tag"])
    dek = derive_dek(workspace_id)
    aesgcm = AESGCM(dek)
    aad = workspace_id.encode("ascii")
    pt = aesgcm.decrypt(nonce, ct + tag, associated_data=aad)
    return pt.decode("utf-8")
