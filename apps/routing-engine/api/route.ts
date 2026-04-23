import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { loadRoutingContext } from './src/context'
import { decide } from './src/decide'
import { writeUsage } from './src/meter'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const OPENAI_BASE = 'https://api.openai.com/v1'
const UPSTREAM_TIMEOUT_MS = 25_000

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const request_id = crypto.randomUUID()
  const startedAt = Date.now()

  try {
    // Auth
    console.log("ENG_0 handler_entry", { request_id, method: req.method, url: req.url })
    const authHeader = (req.headers['authorization'] ?? '') as string
    if (!authHeader.startsWith('Bearer anvx_live_')) {
      res.status(401).json({ error: 'Missing or malformed bearer token' })
      return
    }

    const token = authHeader.slice(7)
    const tokenHash = createHash('sha256').update(token).digest('hex')

    console.log("AUTH_START", { request_id })
    const { data: tokenRow, error: tokenErr } = await supabase
      .from('anvx_api_tokens')
      .select('id, workspace_id')
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .single()

    console.log("AUTH_DB_DONE", { request_id, hasData: !!tokenRow, error: tokenErr?.message })
    if (tokenErr || !tokenRow) {
      res.status(401).json({ error: 'Invalid or revoked token' })
      return
    }

    const workspaceId = tokenRow.workspace_id as string
    const tokenId = tokenRow.id as string

    // Update last_used_at — fire and forget
    supabase.from('anvx_api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', tokenId).then(() => {})

    console.log("ENG_1 auth_complete", { request_id, workspaceId })

    // Parse body
    const body = req.body as Record<string, unknown>
    const requestedModel = (body?.model as string) ?? 'gpt-4o'
    const isStream = body?.stream === true

    // Force non-streaming for now
    const upstreamBody = { ...body, stream: false }

    // Load routing context
    const ctx = await loadRoutingContext(workspaceId)
    console.log("ENG_2 context_loaded", { request_id })

    // Decide
    const decision = decide(ctx, requestedModel)

    // Resolve provider key — direct env var, skip decrypt
    const providerKey = process.env.ANVX_DEV_OPENAI_KEY ?? ''
    console.log("ENG_3 key_resolved", { request_id, keyLen: providerKey.length })

    if (!providerKey) {
      res.status(502).json({ error: 'configuration', message: 'No provider API key available' })
      return
    }

    // Forward to OpenAI
    console.log("ENG_4 upstream_start", { request_id })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

    let upstreamRes: Response
    try {
      upstreamRes = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerKey}`,
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      })
    } catch (fetchErr: any) {
      clearTimeout(timeout)
      if (fetchErr?.name === 'AbortError') {
        console.error("ENG_ERR upstream_timeout", { request_id })
        res.status(504).json({ error: 'upstream_timeout', message: 'OpenAI did not respond in time' })
        return
      }
      throw fetchErr
    }
    clearTimeout(timeout)

    const upstreamLatencyMs = Date.now() - startedAt
    console.log("ENG_5 upstream_done", { request_id, status: upstreamRes.status, upstream_ms: upstreamLatencyMs })

    // Read upstream body
    const upstreamText = await upstreamRes.text()
    console.log("ENG_6 response_ready", { request_id, bodyLen: upstreamText.length })

    // Fire-and-forget usage recording
    const totalLatencyMs = Date.now() - startedAt
    writeUsage({
      request_id,
      workspace_id: workspaceId,
      token_id: tokenId,
      model_requested: requestedModel,
      model_routed: requestedModel,
      provider: 'openai',
      tokens_in: 0,
      tokens_out: 0,
      decision: decision.action,
      shadow_suggestion: decision.suggestedModel,
      reasoning: decision.reason ?? undefined,
      upstream_latency_ms: upstreamLatencyMs,
      total_latency_ms: totalLatencyMs,
      project_tag: (req.headers['x-anvx-project'] as string) ?? null,
      user_hint: (req.headers['x-anvx-user'] as string) ?? null,
    }).catch(() => {})

    // Return response to client
    res.status(upstreamRes.status).setHeader('content-type', 'application/json').send(upstreamText)
  } catch (err: any) {
    console.error("ENG_CRASH", { request_id, error: err?.message, stack: err?.stack })
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal', message: err?.message ?? 'unknown error' })
    }
  }
}
