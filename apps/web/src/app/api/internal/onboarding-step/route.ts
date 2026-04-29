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
  console.log('[onboarding-step] auth resolved', { userId, orgId })

  if (!userId || !orgId) {
    console.log('[onboarding-step] no session/org — returning step 1', { userId, orgId })
    return NextResponse.json({ step: 1 })
  }

  try {
    const sb = getSupabaseServiceRole()

    const { data: ws, error: wsErr } = await sb
      .from('workspaces')
      .select('id')
      .eq('clerk_org_id', orgId)
      .maybeSingle()

    if (wsErr) {
      console.error('[onboarding-step] workspaces lookup error', { clerk_org_id: orgId, error: wsErr.message })
      return NextResponse.json({ step: 1 })
    }
    if (!ws) {
      console.log('[onboarding-step] workspace not found — returning step 1', {
        queried: { table: 'workspaces', clerk_org_id: orgId },
      })
      return NextResponse.json({ step: 1 })
    }
    console.log('[onboarding-step] workspace found', { workspace_id: ws.id, clerk_org_id: orgId })

    const { data: state, error: stErr } = await sb
      .from('onboarding_state')
      .select('current_step')
      .eq('workspace_id', ws.id)
      .maybeSingle()

    if (stErr) {
      console.error('[onboarding-step] onboarding_state lookup error', { workspace_id: ws.id, error: stErr.message })
      return NextResponse.json({ step: 1 })
    }
    if (!state) {
      console.log('[onboarding-step] onboarding_state not found — returning step 1', {
        queried: { table: 'onboarding_state', workspace_id: ws.id },
      })
      return NextResponse.json({ step: 1 })
    }
    console.log('[onboarding-step] onboarding_state found', { workspace_id: ws.id, current_step: state.current_step })

    const raw = Number(state.current_step)
    const step = Number.isFinite(raw) && raw >= 1 && raw <= 6 ? raw : 1
    console.log('[onboarding-step] returning step', { step, raw_current_step: state.current_step })
    return NextResponse.json({ step })
  } catch (err) {
    console.error('[onboarding-step] lookup failed', err)
    return NextResponse.json({ step: 1 })
  }
}
