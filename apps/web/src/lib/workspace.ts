/* eslint-disable @typescript-eslint/no-explicit-any */

import { auth } from '@clerk/nextjs/server'
import { getSupabaseForRequest } from './supabase'

export type Role = 'owner' | 'admin' | 'member'
export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 }

export type WorkspaceContext = {
  workspaceId: string        // DB workspaces.id (uuid)
  workspaceName: string
  role: Role
  userId: string            // DB users.id (uuid)
  clerkUserId: string
  clerkOrgId: string
}

/**
 * Resolves the current request to a WorkspaceContext.
 * Throws if not signed in or no org selected.
 * Role comes from workspace_members, never from Clerk metadata.
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth()
  if (!clerkUserId) throw new Error('Not signed in')
  if (!clerkOrgId) throw new Error('No organization selected')

  const supabase = await getSupabaseForRequest()
  const { data, error } = await supabase
    .from('workspace_members')
    .select(`
      role,
      users!inner(id, clerk_user_id),
      workspaces!inner(id, name, clerk_org_id)
    `)
    .eq('users.clerk_user_id', clerkUserId)
    .eq('workspaces.clerk_org_id', clerkOrgId)
    .single()

  if (error || !data) throw new Error('Not a member of this workspace')

  return {
    workspaceId: (data.workspaces as any).id,
    workspaceName: (data.workspaces as any).name,
    role: data.role as Role,
    userId: (data.users as any).id,
    clerkUserId,
    clerkOrgId,
  }
}

/**
 * Throws 403 if the caller's role is below minRole.
 * Use in API routes and server components that mutate data.
 */
export async function requireRole(minRole: Role): Promise<WorkspaceContext> {
  const ctx = await getWorkspaceContext()
  if (ROLE_RANK[ctx.role] < ROLE_RANK[minRole]) {
    const e = new Error(`Requires role >= ${minRole}, have ${ctx.role}`)
    ;(e as any).status = 403
    throw e
  }
  return ctx
}
