from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


class ConfirmBody(BaseModel):
    document_transaction_id: str
    candidate_id: str


class CategorizeBody(BaseModel):
    document_transaction_id: str
    category_id: str
    notes: str | None = None


class FlagBody(BaseModel):
    document_transaction_id: str
    reason: str = Field(min_length=5, max_length=500)


def _audit(sb, workspace_id: str, actor_user_id: str, action: str, target_id: str, details: dict | None = None) -> None:
    sb.from_("audit_log").insert({
        "workspace_id": workspace_id,
        "actor_user_id": actor_user_id,
        "action": action,
        "target_kind": "document_transaction",
        "target_id": target_id,
        "details": details or {},
    }).execute()


def _ensure_txn_in_workspace(sb, workspace_id: str, txn_id: str) -> dict:
    txn = (
        sb.from_("document_transactions")
        .select("id, workspace_id")
        .eq("id", txn_id)
        .eq("workspace_id", workspace_id)
        .single()
        .execute()
    ).data
    if not txn:
        raise HTTPException(404, "Transaction not found")
    return txn


def _ensure_not_already_resolved(sb, workspace_id: str, txn_id: str) -> None:
    m = (
        sb.from_("reconciliation_matches")
        .select("id").eq("workspace_id", workspace_id).eq("document_transaction_id", txn_id)
        .limit(1).execute()
    ).data
    if m:
        raise HTTPException(409, "Transaction already matched")
    c = (
        sb.from_("reconciliation_categorizations")
        .select("id").eq("workspace_id", workspace_id).eq("document_transaction_id", txn_id)
        .limit(1).execute()
    ).data
    if c:
        raise HTTPException(409, "Transaction already categorized")
    f = (
        sb.from_("reconciliation_flags")
        .select("id").eq("workspace_id", workspace_id).eq("document_transaction_id", txn_id)
        .limit(1).execute()
    ).data
    if f:
        raise HTTPException(409, "Transaction already flagged")


@router.get("/reconcile/queue")
async def reconcile_queue(
    document_id: str = Query(..., description="document id whose queue to return"),
    ctx: WorkspaceContext = Depends(require_role("member")),
):
    sb = sb_service()

    doc = (
        sb.from_("documents")
        .select("id")
        .eq("id", document_id)
        .eq("workspace_id", ctx.workspace_id)
        .single()
        .execute()
    ).data
    if not doc:
        raise HTTPException(404, "Document not found")

    txns = (
        sb.from_("document_transactions")
        .select("id, txn_date, description, amount_cents, counterparty, row_index")
        .eq("document_id", document_id)
        .eq("workspace_id", ctx.workspace_id)
        .order("row_index", desc=False)
        .execute()
    ).data or []

    if not txns:
        return {"needs_review": [], "unmatched": [], "auto_matched": [], "auto_matched_count": 0}

    txn_ids = [t["id"] for t in txns]

    matches = (
        sb.from_("reconciliation_matches")
        .select("id, document_transaction_id, auto, confidence, source_kind")
        .eq("workspace_id", ctx.workspace_id)
        .in_("document_transaction_id", txn_ids)
        .execute()
    ).data or []
    cats = (
        sb.from_("reconciliation_categorizations")
        .select("id, document_transaction_id")
        .eq("workspace_id", ctx.workspace_id)
        .in_("document_transaction_id", txn_ids)
        .execute()
    ).data or []
    flags = (
        sb.from_("reconciliation_flags")
        .select("id, document_transaction_id")
        .eq("workspace_id", ctx.workspace_id)
        .in_("document_transaction_id", txn_ids)
        .execute()
    ).data or []
    cands = (
        sb.from_("reconciliation_candidates")
        .select("id, document_transaction_id, source_kind, source_id, score")
        .eq("workspace_id", ctx.workspace_id)
        .in_("document_transaction_id", txn_ids)
        .order("score", desc=True)
        .execute()
    ).data or []

    matched_ids = {m["document_transaction_id"] for m in matches}
    cat_ids = {c["document_transaction_id"] for c in cats}
    flag_ids = {f["document_transaction_id"] for f in flags}
    resolved = matched_ids | cat_ids | flag_ids

    cands_by_txn: dict[str, list[dict]] = {}
    for c in cands:
        cands_by_txn.setdefault(c["document_transaction_id"], []).append(c)

    needs_review = []
    unmatched = []

    for t in txns:
        if t["id"] in resolved:
            continue
        t_view = {
            "id": t["id"], "txn_date": t["txn_date"], "description": t["description"],
            "amount_cents": t["amount_cents"], "counterparty": t.get("counterparty"),
        }
        candidates = cands_by_txn.get(t["id"], [])
        if candidates:
            top = candidates[0]
            needs_review.append({
                "txn": t_view,
                "top_candidate": {
                    "id": top["id"], "source_kind": top["source_kind"],
                    "source_id": top["source_id"], "score": float(top["score"]),
                },
                "other_candidates": [
                    {"id": c["id"], "source_kind": c["source_kind"], "source_id": c["source_id"], "score": float(c["score"])}
                    for c in candidates[1:]
                ],
            })
        else:
            unmatched.append(t_view)

    auto_matches_by_txn = {m["document_transaction_id"]: m for m in matches if m.get("auto")}
    auto_matched_count = len(auto_matches_by_txn)

    auto_matched_rows = []
    for t in txns:
        m = auto_matches_by_txn.get(t["id"])
        if not m:
            continue
        auto_matched_rows.append({
            "txn": {
                "id": t["id"], "txn_date": t["txn_date"], "description": t["description"],
                "amount_cents": t["amount_cents"], "counterparty": t.get("counterparty"),
            },
            "match": {
                "id": m["id"], "source_kind": m["source_kind"],
                "confidence": float(m["confidence"]) if m.get("confidence") is not None else None,
            },
        })

    return {
        "needs_review": needs_review,
        "unmatched": unmatched,
        "auto_matched": auto_matched_rows,
        "auto_matched_count": auto_matched_count,
    }


@router.post("/reconcile/confirm")
async def reconcile_confirm(body: ConfirmBody, ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    _ensure_txn_in_workspace(sb, ctx.workspace_id, body.document_transaction_id)
    _ensure_not_already_resolved(sb, ctx.workspace_id, body.document_transaction_id)

    candidate = (
        sb.from_("reconciliation_candidates")
        .select("id, source_kind, source_id, score, document_transaction_id")
        .eq("id", body.candidate_id)
        .eq("workspace_id", ctx.workspace_id)
        .eq("document_transaction_id", body.document_transaction_id)
        .single()
        .execute()
    ).data
    if not candidate:
        raise HTTPException(404, "Candidate not found")

    try:
        sb.from_("reconciliation_matches").insert({
            "workspace_id": ctx.workspace_id,
            "document_transaction_id": body.document_transaction_id,
            "source_kind": candidate["source_kind"],
            "source_id": candidate["source_id"],
            "confidence": candidate["score"],
            "auto": False,
            "resolved_by_user_id": ctx.user_id,
        }).execute()
    except Exception as e:
        err = str(e).lower()
        if "duplicate" in err or "unique" in err or "23505" in err:
            raise HTTPException(409, "Transaction already matched")
        raise

    sb.from_("reconciliation_candidates").delete().eq(
        "workspace_id", ctx.workspace_id
    ).eq("document_transaction_id", body.document_transaction_id).execute()

    _audit(sb, ctx.workspace_id, ctx.user_id, "reconcile:confirm", body.document_transaction_id, {
        "candidate_id": body.candidate_id, "source_kind": candidate["source_kind"],
        "source_id": candidate["source_id"], "confidence": float(candidate["score"]),
    })

    return {"ok": True}


@router.post("/reconcile/categorize")
async def reconcile_categorize(body: CategorizeBody, ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    _ensure_txn_in_workspace(sb, ctx.workspace_id, body.document_transaction_id)
    _ensure_not_already_resolved(sb, ctx.workspace_id, body.document_transaction_id)

    coa = (
        sb.from_("chart_of_accounts")
        .select("id")
        .eq("id", body.category_id)
        .eq("workspace_id", ctx.workspace_id)
        .single()
        .execute()
    ).data
    if not coa:
        raise HTTPException(404, "Category not found")

    try:
        sb.from_("reconciliation_categorizations").insert({
            "workspace_id": ctx.workspace_id,
            "document_transaction_id": body.document_transaction_id,
            "category_id": body.category_id,
            "notes": body.notes,
            "resolved_by_user_id": ctx.user_id,
        }).execute()
    except Exception as e:
        err = str(e).lower()
        if "duplicate" in err or "unique" in err or "23505" in err:
            raise HTTPException(409, "Transaction already categorized")
        raise

    sb.from_("reconciliation_candidates").delete().eq(
        "workspace_id", ctx.workspace_id
    ).eq("document_transaction_id", body.document_transaction_id).execute()

    _audit(sb, ctx.workspace_id, ctx.user_id, "reconcile:categorize", body.document_transaction_id, {
        "category_id": body.category_id, "notes": body.notes,
    })

    return {"ok": True}


@router.post("/reconcile/flag")
async def reconcile_flag(body: FlagBody, ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    _ensure_txn_in_workspace(sb, ctx.workspace_id, body.document_transaction_id)
    _ensure_not_already_resolved(sb, ctx.workspace_id, body.document_transaction_id)

    try:
        sb.from_("reconciliation_flags").insert({
            "workspace_id": ctx.workspace_id,
            "document_transaction_id": body.document_transaction_id,
            "reason": body.reason,
            "flagged_by_user_id": ctx.user_id,
        }).execute()
    except Exception as e:
        err = str(e).lower()
        if "duplicate" in err or "unique" in err or "23505" in err:
            raise HTTPException(409, "Transaction already flagged")
        raise

    sb.from_("reconciliation_candidates").delete().eq(
        "workspace_id", ctx.workspace_id
    ).eq("document_transaction_id", body.document_transaction_id).execute()

    _audit(sb, ctx.workspace_id, ctx.user_id, "reconcile:flag", body.document_transaction_id, {
        "reason": body.reason,
    })

    return {"ok": True}


@router.get("/reconcile/chart-of-accounts")
async def reconcile_chart_of_accounts(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    rows = (
        sb.from_("chart_of_accounts")
        .select("id, code, name, kind")
        .eq("workspace_id", ctx.workspace_id)
        .order("code", desc=False)
        .execute()
    ).data or []
    return rows
