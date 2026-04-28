import { NextRequest, NextResponse } from 'next/server'
import { clerkClient } from '@clerk/nextjs/server'
import { getSupabaseServiceRole } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * One-shot backfill: enumerate all Clerk users + organizations + memberships
 * and upsert them into Supabase. Safe to re-run — every write is idempotent.
 *
 * Auth: shared secret via x-internal-secret header (env: INTERNAL_SECRET).
 *
 * Trigger:
 *   curl -X POST https://anvx.io/api/internal/seed-from-clerk \
 *     -H "x-internal-secret: $INTERNAL_SECRET"
 */
export async function POST(req: NextRequest) {
  const secret = process.env.INTERNAL_SECRET
  const provided = req.headers.get('x-internal-secret')
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sb = getSupabaseServiceRole()
  const cc = await clerkClient()
  const summary = {
    users_seeded: 0,
    workspaces_seeded: 0,
    members_seeded: 0,
    errors: [] as string[],
  }

  // 1. Users
  let offset = 0
  while (true) {
    const page = await cc.users.getUserList({ limit: 100, offset })
    for (const u of page.data) {
      const email = u.emailAddresses?.[0]?.emailAddress ?? ''
      const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ') || null
      const res = await sb.from('users').upsert(
        {
          clerk_user_id: u.id,
          email,
          display_name: displayName,
          avatar_url: u.imageUrl ?? null,
        },
        { onConflict: 'clerk_user_id' },
      )
      if (res.error) summary.errors.push(`user ${u.id}: ${res.error.message}`)
      else summary.users_seeded++
    }
    if (page.data.length < 100) break
    offset += 100
  }

  // 2. Organizations + memberships
  offset = 0
  while (true) {
    const page = await cc.organizations.getOrganizationList({ limit: 100, offset })
    for (const o of page.data) {
      const memberships = await cc.organizations.getOrganizationMembershipList({
        organizationId: o.id,
        limit: 100,
      })

      const ownerClerkId =
        o.createdBy ??
        memberships.data.find((m) => m.role === 'org:admin')?.publicUserData?.userId ??
        memberships.data[0]?.publicUserData?.userId

      if (!ownerClerkId) {
        summary.errors.push(`org ${o.id}: no owner candidate`)
        continue
      }

      const ownerLookup = await sb
        .from('users')
        .select('id')
        .eq('clerk_user_id', ownerClerkId)
        .maybeSingle()
      if (ownerLookup.error) {
        summary.errors.push(`org ${o.id} owner lookup: ${ownerLookup.error.message}`)
        continue
      }
      if (!ownerLookup.data) {
        summary.errors.push(`org ${o.id}: owner ${ownerClerkId} not in users`)
        continue
      }
      const ownerId = ownerLookup.data.id as string

      const slug = (o.name ?? 'workspace').toLowerCase().replace(/\s+/g, '-')
      const wsRes = await sb
        .from('workspaces')
        .upsert(
          { clerk_org_id: o.id, name: o.name, slug, owner_user_id: ownerId },
          { onConflict: 'clerk_org_id' },
        )
        .select('id')
        .single()
      if (wsRes.error || !wsRes.data) {
        summary.errors.push(`workspace ${o.id}: ${wsRes.error?.message ?? 'no row'}`)
        continue
      }
      const wsId = wsRes.data.id as string
      summary.workspaces_seeded++

      for (const m of memberships.data) {
        const cuid = m.publicUserData?.userId
        if (!cuid) continue
        const userLookup = await sb
          .from('users')
          .select('id')
          .eq('clerk_user_id', cuid)
          .maybeSingle()
        if (userLookup.error || !userLookup.data) {
          summary.errors.push(`member ${cuid}@${o.id} not in users`)
          continue
        }
        const memberId = userLookup.data.id as string
        const role =
          memberId === ownerId
            ? 'owner'
            : m.role === 'org:admin'
              ? 'admin'
              : 'member'

        const memRes = await sb.from('workspace_members').upsert(
          { workspace_id: wsId, user_id: memberId, role },
          { onConflict: 'workspace_id,user_id' },
        )
        if (memRes.error) summary.errors.push(`member ${cuid}@${o.id}: ${memRes.error.message}`)
        else summary.members_seeded++
      }
    }
    if (page.data.length < 100) break
    offset += 100
  }

  return NextResponse.json({ ok: true, ...summary })
}
