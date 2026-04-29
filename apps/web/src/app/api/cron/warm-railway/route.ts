import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

/**
 * Vercel Cron — pings Railway's /healthz to keep the FastAPI container warm
 * and avoid cold-start penalty on the next user request.
 *
 * Auth: Vercel signs cron requests with x-vercel-cron header automatically;
 * we accept those, plus an explicit CRON_SECRET fallback for manual triggers.
 */
export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get('x-vercel-cron') !== null
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!isVercelCron && (!secret || provided !== secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const target = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
  const url = `${target.replace(/\/+$/, '')}/healthz`

  const startedAt = Date.now()
  try {
    const res = await fetch(url, { cache: 'no-store' })
    const ms = Date.now() - startedAt
    return NextResponse.json({
      ok: res.ok,
      target: url,
      status: res.status,
      latency_ms: ms,
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        target: url,
        error: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - startedAt,
      },
      { status: 502 },
    )
  }
}
