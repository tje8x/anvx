from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()

MAX_FILE_SIZE_BYTES = 25_000_000
STORAGE_BUCKET = "documents"
ALLOWED_FILE_KINDS = {"bank_csv", "bank_pdf", "cc_csv", "cc_pdf", "invoice_pdf", "other"}


class UploadUrlRequest(BaseModel):
    file_name: str = Field(min_length=1, max_length=255)
    file_size_bytes: int = Field(ge=1)
    content_hash: str = Field(min_length=16, max_length=128)


class UploadUrlResponse(BaseModel):
    document_id: str
    storage_path: str
    signed_url: str
    token: str


class ConfirmRequest(BaseModel):
    document_id: str
    storage_path: str
    file_name: str
    file_size_bytes: int = Field(ge=1)
    content_hash: str
    file_kind: str


def _audit(sb, workspace_id: str, actor_user_id: str, action: str, target_id: str, details: dict | None = None) -> None:
    sb.from_("audit_log").insert({
        "workspace_id": workspace_id,
        "actor_user_id": actor_user_id,
        "action": action,
        "target_kind": "document",
        "target_id": target_id,
        "details": details or {},
    }).execute()


def _ext_for(file_name: str) -> str:
    if "." not in file_name:
        return "bin"
    return file_name.rsplit(".", 1)[1].lower() or "bin"


@router.post("/documents/upload-url", response_model=UploadUrlResponse)
async def create_upload_url(body: UploadUrlRequest, ctx: WorkspaceContext = Depends(require_role("member"))):
    if body.file_size_bytes > MAX_FILE_SIZE_BYTES:
        raise HTTPException(413, f"File exceeds {MAX_FILE_SIZE_BYTES} byte limit")

    sb = sb_service()

    dup = (
        sb.from_("documents")
        .select("id")
        .eq("workspace_id", ctx.workspace_id)
        .eq("content_hash", body.content_hash)
        .is_("removed_at", "null")
        .limit(1)
        .execute()
    )
    if dup.data:
        raise HTTPException(409, detail={"error": "duplicate", "existing_id": dup.data[0]["id"]})

    document_id = str(uuid4())
    ext = _ext_for(body.file_name)
    storage_path = f"workspaces/{ctx.workspace_id}/documents/{document_id}.{ext}"

    try:
        signed = sb.storage.from_(STORAGE_BUCKET).create_signed_upload_url(storage_path)
    except Exception as e:
        raise HTTPException(502, f"Failed to create signed upload URL: {e}")

    return UploadUrlResponse(
        document_id=document_id,
        storage_path=storage_path,
        signed_url=signed.get("signed_url") or signed.get("signedUrl"),
        token=signed.get("token", ""),
    )


@router.post("/documents/confirm")
async def confirm_upload(body: ConfirmRequest, ctx: WorkspaceContext = Depends(require_role("member"))):
    if body.file_kind not in ALLOWED_FILE_KINDS:
        raise HTTPException(400, f"Invalid file_kind '{body.file_kind}'. Must be one of: {sorted(ALLOWED_FILE_KINDS)}")
    if body.file_size_bytes > MAX_FILE_SIZE_BYTES:
        raise HTTPException(413, f"File exceeds {MAX_FILE_SIZE_BYTES} byte limit")

    sb = sb_service()

    try:
        result = sb.from_("documents").insert({
            "id": body.document_id,
            "workspace_id": ctx.workspace_id,
            "storage_path": body.storage_path,
            "file_name": body.file_name,
            "file_kind": body.file_kind,
            "file_size_bytes": body.file_size_bytes,
            "content_hash": body.content_hash,
            "status": "uploaded",
            "uploaded_by_user_id": ctx.user_id,
        }).execute()
    except Exception as e:
        err = str(e).lower()
        if "duplicate" in err or "unique" in err or "23505" in err:
            raise HTTPException(409, detail={"error": "duplicate"})
        raise

    row = result.data[0] if result.data else None
    if not row:
        raise HTTPException(500, "Failed to insert document row")

    _audit(sb, ctx.workspace_id, ctx.user_id, "document:upload", body.document_id, {
        "file_name": body.file_name, "file_kind": body.file_kind, "file_size_bytes": body.file_size_bytes,
    })

    print(f"TODO: enqueue parsing job for {body.document_id}")
    return row


@router.get("/documents")
async def list_documents(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    result = (
        sb.from_("documents")
        .select("*")
        .eq("workspace_id", ctx.workspace_id)
        .neq("status", "removed")
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )
    return result.data or []


@router.delete("/documents/{document_id}")
async def delete_document(document_id: str, ctx: WorkspaceContext = Depends(require_role("admin"))):
    sb = sb_service()

    lookup = (
        sb.from_("documents")
        .select("id, file_name, storage_path, status")
        .eq("id", document_id)
        .eq("workspace_id", ctx.workspace_id)
        .single()
        .execute()
    )
    if not lookup.data:
        raise HTTPException(404, "Document not found")

    now_iso = datetime.now(timezone.utc).isoformat()
    sb.from_("documents").update({
        "status": "removed",
        "removed_at": now_iso,
    }).eq("id", document_id).eq("workspace_id", ctx.workspace_id).execute()

    try:
        sb.storage.from_(STORAGE_BUCKET).remove([lookup.data["storage_path"]])
    except Exception as e:
        # Storage removal is best-effort — the row is already marked removed.
        print(f"WARN: failed to delete storage object {lookup.data['storage_path']}: {e}")

    _audit(sb, ctx.workspace_id, ctx.user_id, "document:delete", document_id, {
        "file_name": lookup.data["file_name"], "storage_path": lookup.data["storage_path"],
    })

    return {"ok": True}
