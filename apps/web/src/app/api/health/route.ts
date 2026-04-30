import { NextResponse } from 'next/server'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const COMMIT_SHA = (
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
  'dev'
).slice(0, 7)

const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=5',
  'Content-Type': 'application/json',
}

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: 'web',
      ts: new Date().toISOString(),
      version: COMMIT_SHA,
    },
    { headers: CACHE_HEADERS },
  )
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
export async function OPTIONS() { return methodNotAllowed() }

function methodNotAllowed() {
  return NextResponse.json(
    { ok: false, error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'GET' } },
  )
}
