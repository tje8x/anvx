from supabase import create_client, Client

from .settings import settings


def sb_service() -> Client:
    """Service-role Supabase client. Bypasses RLS."""
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def sb_user(jwt_token: str) -> Client:
    """User-scoped Supabase client. Carries Clerk JWT so RLS applies."""
    return create_client(
        settings.supabase_url,
        settings.supabase_service_role_key,
        options={"headers": {"Authorization": f"Bearer {jwt_token}"}},
    )


async def resolve_workspace_member(
    clerk_user_id: str, clerk_org_id: str
) -> dict | None:
    """Look up workspace membership by Clerk IDs."""
    sb = sb_service()

    # Step 1: resolve clerk IDs to DB IDs
    user_res = sb.from_("users").select("id").eq("clerk_user_id", clerk_user_id).limit(1).execute()
    if not user_res.data:
        return None

    ws_res = sb.from_("workspaces").select("id").eq("clerk_org_id", clerk_org_id).limit(1).execute()
    if not ws_res.data:
        return None

    user_id = user_res.data[0]["id"]
    workspace_id = ws_res.data[0]["id"]

    # Step 2: check membership
    mem_res = (
        sb.from_("workspace_members")
        .select("role")
        .eq("user_id", user_id)
        .eq("workspace_id", workspace_id)
        .limit(1)
        .execute()
    )
    if not mem_res.data:
        return None

    return {
        "user_id": user_id,
        "workspace_id": workspace_id,
        "role": mem_res.data[0]["role"],
    }


async def resolve_single_workspace_for_user(clerk_user_id: str) -> dict | None:
    """If the user belongs to exactly one workspace, return its identifiers.

    Used as a fallback when the JWT does not carry an active organization id —
    the user has implicitly only one workspace they could be acting against.
    """
    sb = sb_service()
    user_res = (
        sb.from_("users").select("id").eq("clerk_user_id", clerk_user_id).limit(1).execute()
    )
    if not user_res.data:
        return None
    user_id = user_res.data[0]["id"]

    mem_res = (
        sb.from_("workspace_members")
        .select("role, workspace_id, workspaces!inner(clerk_org_id)")
        .eq("user_id", user_id)
        .execute()
    )
    rows = mem_res.data or []
    if len(rows) != 1:
        return None
    r = rows[0]
    return {
        "user_id": user_id,
        "workspace_id": r["workspace_id"],
        "role": r["role"],
        "clerk_org_id": r["workspaces"]["clerk_org_id"],
    }
