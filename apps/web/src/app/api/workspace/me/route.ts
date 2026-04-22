import { NextResponse } from 'next/server'
import { getWorkspaceContext } from '@/lib/workspace'

export async function GET() {
  try {
    const ctx = await getWorkspaceContext()
    return NextResponse.json(ctx)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 })
  }
}
