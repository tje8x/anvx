import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { getSupabaseServiceRole } from '@/lib/supabase'

export const runtime = 'nodejs'

/**
 * Internal lookup hit by middleware to gate dashboard access on onboarding state.
 *
 * Returns `{step: 1..6}`. A response of `6` means "let the user through" —
 * either fully onboarded, or no row exists (workspaces created before the
 * onboarding flow shipped should be treated as already onboarded).
 *
 * Fails open: any lookup error returns `6` so a transient Supabase blip
 * doesn't gate users out of the dashboard.
 */
export async function GET() {
  const { userId, orgId } = await auth()
  if (!userId || !orgId) {
    // No active session/org — middleware shouldn't be calling us in that
    // case, but if it does, treat as "let through" since the dashboard
    // layout already handles auth/org redirects.
    return NextResponse.json({ step: 6 })
  }

  try {
    const sb = getSupabaseServiceRole()

    const { data: ws } = await sb
      .from('workspaces')
      .select('id')
      .eq('clerk_org_id', orgId)
      .maybeSingle()

    if (!ws) return NextResponse.json({ step: 6 })

    const { data: state } = await sb
      .from('onboarding_state')
      .select('current_step')
      .eq('workspace_id', ws.id)
      .maybeSingle()

    if (!state) return NextResponse.json({ step: 6 })

    const step = Number(state.current_step)
    return NextResponse.json({
      step: Number.isFinite(step) && step >= 1 && step <= 6 ? step : 6,
    })
  } catch (err) {
    console.error('[onboarding-step] lookup failed', err)
    return NextResponse.json({ step: 6 })
  }
}
