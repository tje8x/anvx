import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { getSupabaseServiceRole } from '@/lib/supabase'

export const runtime = 'nodejs'

/**
 * Internal lookup hit by middleware to gate dashboard access on onboarding state.
 *
 * Returns `{step: 1..6}`. `6` means "let the user through" — fully onboarded.
 * Anything else (including a missing workspace, missing onboarding_state row,
 * or a Supabase lookup error) returns `1` so the middleware redirects the user
 * to /onboarding/workspace. Fail-closed: a transient blip should NOT slip a
 * not-yet-onboarded user past the gate.
 */
export async function GET() {
  const { userId, orgId } = await auth()
  if (!userId || !orgId) {
    // No active session/org — fail closed so middleware bounces to onboarding.
    return NextResponse.json({ step: 1 })
  }

  try {
    const sb = getSupabaseServiceRole()

    const { data: ws } = await sb
      .from('workspaces')
      .select('id')
      .eq('clerk_org_id', orgId)
      .maybeSingle()

    if (!ws) return NextResponse.json({ step: 1 })

    const { data: state } = await sb
      .from('onboarding_state')
      .select('current_step')
      .eq('workspace_id', ws.id)
      .maybeSingle()

    if (!state) return NextResponse.json({ step: 1 })

    const step = Number(state.current_step)
    return NextResponse.json({
      step: Number.isFinite(step) && step >= 1 && step <= 6 ? step : 1,
    })
  } catch (err) {
    console.error('[onboarding-step] lookup failed', err)
    return NextResponse.json({ step: 1 })
  }
}
