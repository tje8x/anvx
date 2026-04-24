import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { loadContext, decide, type DecisionResult } from './src/decide'
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
    const projectTag = (req.headers['x-anvx-project'] as string) ?? undefined
    const userHint = (req.headers['x-anvx-user'] as string) ?? undefined

    // Load routing context
    const ctx = await loadContext(workspaceId)
    let dec: DecisionResult

    if (!ctx) {
      console.log("ENG_CTX_FAIL", { request_id, workspaceId })
      dec = {
        decision: 'failed_open', model_routed: requestedModel, provider_routed: 'openai',
        reasoning: 'Context load failed — failed open.', policy_triggered_id: null, shadow_suggestion: null,
      }
    } else {
      console.log("ENG_2 context_loaded", { request_id, routing_mode: ctx.routing_mode })

      // Estimate tokens from messages
      const messagesStr = body?.messages ? JSON.stringify(body.messages) : ''
      const tokensInEstimate = Math.ceil(messagesStr.length / 4)
      const maxTokens = (body?.max_tokens as number) ?? 1024

      dec = await decide(ctx, {
        workspace_id: workspaceId,
        model_requested: requestedModel,
        tokens_in_estimate: tokensInEstimate,
        max_tokens: maxTokens,
        project_tag: projectTag,
        user_hint: userHint,
      }, {})
    }

    console.log("ENG_3 decision", { request_id, decision: dec.decision, model_routed: dec.model_routed, policy: dec.policy_triggered_id })

    // If blocked: respond immediately, record usage, do NOT call upstream
    if (dec.decision === 'blocked') {
      const totalLatencyMs = Date.now() - startedAt
      const blockedBody = { ...(dec.blocked_body ?? { error: 'policy_exceeded' }), request_id }

      try {
        await writeUsage({
          request_id, workspace_id: workspaceId, token_id: tokenId,
          model_requested: requestedModel, model_routed: dec.model_routed, provider: dec.provider_routed,
          tokens_in: 0, tokens_out: 0, decision: dec.decision,
          shadow_suggestion: dec.shadow_suggestion, reasoning: dec.reasoning,
          policy_triggered: dec.policy_triggered_id, upstream_latency_ms: 0, total_latency_ms: totalLatencyMs,
          project_tag: projectTag ?? null, user_hint: userHint ?? null,
        })
      } catch (err) {
        console.error("WRITE_USAGE_FAILED_BLOCKED", JSON.stringify(err))
      }

      // Copilot mode: upsert a pending approval row
      if (ctx?.routing_mode === 'copilot' && dec.policy_triggered_id) {
        await supabase.from('copilot_approvals').upsert({
          workspace_id: workspaceId, kind: 'pause_requested',
          policy_id: dec.policy_triggered_id, status: 'pending',
        }, { onConflict: 'workspace_id,policy_id', ignoreDuplicates: true })
      }

      res.status(dec.blocked_http_status ?? 429).setHeader('content-type', 'application/json').send(JSON.stringify(blockedBody))
      return
    }

    // If downgraded: use the routed model for upstream
    const upstreamModel = dec.decision === 'downgraded' ? dec.model_routed : requestedModel
    const upstreamBody = { ...body, model: upstreamModel, stream: false }

    // Resolve provider key — direct env var, skip decrypt
    const providerKey = process.env.ANVX_DEV_OPENAI_KEY ?? ''
    console.log("ENG_4 key_resolved", { request_id, keyLen: providerKey.length })

    if (!providerKey) {
      res.status(502).json({ error: 'configuration', message: 'No provider API key available' })
      return
    }

    // Forward to upstream
    console.log("ENG_5 upstream_start", { request_id, model: upstreamModel })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

    let upstreamRes: Response
    try {
      upstreamRes = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${providerKey}` },
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
    console.log("ENG_6 upstream_done", { request_id, status: upstreamRes.status, upstream_ms: upstreamLatencyMs })

    // Read upstream body
    const upstreamText = await upstreamRes.text()
    console.log("ENG_7 response_ready", { request_id, bodyLen: upstreamText.length })

    // Parse usage from upstream response
    let tokensIn = 0
    let tokensOut = 0
    try {
      const p = JSON.parse(upstreamText)
      tokensIn = p?.usage?.prompt_tokens ?? 0
      tokensOut = p?.usage?.completion_tokens ?? 0
    } catch {}
    console.log("PARSED_USAGE", { request_id, tokensIn, tokensOut })

    // Await usage recording before sending response (Vercel kills process after res.send)
    const totalLatencyMs = Date.now() - startedAt
    try {
      await writeUsage({
        request_id, workspace_id: workspaceId, token_id: tokenId,
        model_requested: requestedModel, model_routed: dec.model_routed, provider: dec.provider_routed,
        tokens_in: tokensIn, tokens_out: tokensOut, decision: dec.decision,
        shadow_suggestion: dec.shadow_suggestion, reasoning: dec.reasoning,
        policy_triggered: dec.policy_triggered_id, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: totalLatencyMs,
        project_tag: projectTag ?? null, user_hint: userHint ?? null,
      })
    } catch (err) {
      console.error("WRITE_USAGE_FAILED", JSON.stringify(err))
    }

    // Return response to client
    res.status(upstreamRes.status).setHeader('content-type', 'application/json').send(upstreamText)
  } catch (err: any) {
    console.error("ENG_CRASH", { request_id, error: err?.message, stack: err?.stack })
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal', message: err?.message ?? 'unknown error' })
    }
  }
}
