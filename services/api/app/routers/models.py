from collections import defaultdict

from fastapi import APIRouter, Depends

from ..auth import WorkspaceContext, require_role
from ..db import sb_service

router = APIRouter()


@router.get("/models")
async def list_models(ctx: WorkspaceContext = Depends(require_role("member"))):
    sb = sb_service()
    result = sb.from_("models").select("provider, model, pool_hint, input_price_per_mtok_cents, output_price_per_mtok_cents").order("provider").order("model").execute()
    rows = result.data or []

    grouped: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        grouped[r["provider"]].append({"model": r["model"], "pool_hint": r["pool_hint"], "input_cents": r["input_price_per_mtok_cents"], "output_cents": r["output_price_per_mtok_cents"]})

    return [{"provider": provider, "models": models} for provider, models in grouped.items()]
