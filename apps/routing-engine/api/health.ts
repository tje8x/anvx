import './src/sentry'
import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * GET /v1/_ping (rewritten by vercel.json from /api/health).
 *
 * Pure in-memory response — no DB, no upstream calls. Target p95 < 10ms.
 * Cache-Control lets ALBs / load-balancers coalesce ping floods.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    res.status(405).json({ ok: false, error: 'method_not_allowed' })
    return
  }
  res.setHeader('Cache-Control', 'public, max-age=5')
  res.setHeader('Content-Type', 'application/json')
  res.status(200).json({
    ok: true,
    service: 'routing',
    ts: new Date().toISOString(),
  })
}
