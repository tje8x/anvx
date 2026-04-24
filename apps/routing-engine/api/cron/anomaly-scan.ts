
import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET}`
  if (auth !== expected) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const base = process.env.API_INTERNAL_URL
  if (!base) return res.status(500).json({ error: 'API_INTERNAL_URL not set' })
  const resp = await fetch(`${base}/api/v2/jobs/anomaly-scan`, {
    method: 'POST',
    headers: { 'x-cron-secret': process.env.CRON_SECRET! },
  })
  const body = await resp.json()
  return res.status(resp.status).json(body)
}
