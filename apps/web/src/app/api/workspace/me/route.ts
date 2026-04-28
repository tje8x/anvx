import { NextResponse } from 'next/server'
import { getWorkspaceContext } from '@/lib/workspace'

export async function GET() {
  try {
    const ctx = await getWorkspaceContext()
    return NextResponse.json(ctx)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[workspace/me] resolve failed', msg)
    return NextResponse.json({ error: msg }, { status: 401 })
  }
}
