import './src/sentry'
import { Sentry } from './src/sentry'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { loadContext, decide, type DecisionResult, type RoutingContext } from './src/decide'
import { writeUsage } from './src/meter'
import { errorResponse, safeMessage, type ErrorKind } from './src/errors'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const OPENAI_BASE = 'https://api.openai.com/v1'
const UPSTREAM_TIMEOUT_MS = 25_000
const CONTEXT_TIMEOUT_MS = 2_000

function sendError(res: VercelResponse, kind: ErrorKind, request_id: string, detail?: Record<string, unknown>) {
  const { status, body } = errorResponse(kind, safeMessage(kind), request_id, detail)
  res.status(status).setHeader('content-type', 'application/json').send(JSON.stringify(body))
}

async function auditLog(workspace_id: string, kind: string, request_id: string) {
  try {
    await supabase.from('audit_log').insert({ workspace_id, actor_user_id: null, action: `routing:${kind}`, target_kind: 'routing_request', target_id: request_id, details: { kind, request_id } })
  } catch {}
}

async function bestEffortUsage(fields: Parameters<typeof writeUsage>[0]) {
  try { await writeUsage(fields) } catch (err) { console.error("WRITE_USAGE_FAILED", JSON.stringify(err)) }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const request_id = crypto.randomUUID()
  const startedAt = Date.now()
  let workspaceId = ''
  let tokenId = ''

  try {
    console.log("ENG_0 handler_entry", { request_id, method: req.method, url: req.url })

    // Auth
    const authHeader = (req.headers['authorization'] ?? '') as string
    if (!authHeader.startsWith('Bearer anvx_live_')) {
      sendError(res, 'authentication_failed', request_id)
      return
    }

    const token = authHeader.slice(7)
    const tokenHash = createHash('sha256').update(token).digest('hex')

    const { data: tokenRow, error: tokenErr } = await supabase
      .from('anvx_api_tokens')
      .select('id, workspace_id')
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .single()

    if (tokenErr || !tokenRow) {
      sendError(res, 'authentication_failed', request_id)
      return
    }

    workspaceId = tokenRow.workspace_id as string
    tokenId = tokenRow.id as string
    supabase.from('anvx_api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', tokenId).then(() => {})

    Sentry.setTag('workspace_id', workspaceId)
    Sentry.setTag('request_id', request_id)

    console.log("ENG_1 auth_complete", { request_id, workspaceId })

    // Parse body
    let body: Record<string, unknown>
    try {
      body = req.body as Record<string, unknown>
      if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    } catch {
      sendError(res, 'malformed_request', request_id)
      await auditLog(workspaceId, 'malformed_request', request_id)
      return
    }

    const requestedModel = (body?.model as string) ?? 'gpt-4o'
    const projectTag = (req.headers['x-anvx-project'] as string) ?? undefined
    const userHint = (req.headers['x-anvx-user'] as string) ?? undefined

    // Load routing context with 2s timeout
    let ctx: RoutingContext | null = null
    let dec: DecisionResult
    const usageBase = { request_id, workspace_id: workspaceId, token_id: tokenId, model_requested: requestedModel, provider: 'openai', project_tag: projectTag ?? null, user_hint: userHint ?? null }

    try {
      ctx = await Promise.race([
        loadContext(workspaceId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('context_timeout')), CONTEXT_TIMEOUT_MS)),
      ])
    } catch (ctxErr: any) {
      console.error("ENG_CTX_FAIL", { request_id, workspaceId, error: ctxErr?.message })

      // Check fail mode
      const { data: closedRow } = await supabase.from('budget_policies').select('id').eq('workspace_id', workspaceId).eq('fail_mode', 'closed').eq('enabled', true).limit(1).single()

      if (closedRow) {
        await bestEffortUsage({ ...usageBase, model_routed: requestedModel, tokens_in: 0, tokens_out: 0, decision: 'failed_closed', shadow_suggestion: null, reasoning: 'Context load failed — fail-closed policy active.', policy_triggered: null, upstream_latency_ms: 0, total_latency_ms: Date.now() - startedAt })
        await auditLog(workspaceId, 'anvx_unavailable', request_id)
        sendError(res, 'anvx_unavailable', request_id, { error_stage: 'context_load' })
        return
      }

      // fail-open
      ctx = null
    }

    if (!ctx) {
      dec = { decision: 'failed_open', model_routed: requestedModel, provider_routed: 'openai', reasoning: 'Context load failed — failed open.', policy_triggered_id: null, shadow_suggestion: null }
    } else {
      console.log("ENG_2 context_loaded", { request_id, routing_mode: ctx.routing_mode })
      const messagesStr = body?.messages ? JSON.stringify(body.messages) : ''
      const tokensInEstimate = Math.ceil(messagesStr.length / 4)
      const maxTokens = (body?.max_tokens as number) ?? 1024

      dec = await decide(ctx, { workspace_id: workspaceId, model_requested: requestedModel, tokens_in_estimate: tokensInEstimate, max_tokens: maxTokens, project_tag: projectTag, user_hint: userHint }, {})
    }

    console.log("ENG_3 decision", { request_id, decision: dec.decision, model_routed: dec.model_routed, policy: dec.policy_triggered_id })

    // Blocked
    if (dec.decision === 'blocked') {
      const totalLatencyMs = Date.now() - startedAt
      await bestEffortUsage({ ...usageBase, model_routed: dec.model_routed, tokens_in: 0, tokens_out: 0, decision: dec.decision, shadow_suggestion: dec.shadow_suggestion, reasoning: dec.reasoning, policy_triggered: dec.policy_triggered_id, upstream_latency_ms: 0, total_latency_ms: totalLatencyMs })
      await auditLog(workspaceId, 'policy_exceeded', request_id)

      if (ctx?.routing_mode === 'copilot' && dec.policy_triggered_id) {
        await supabase.from('copilot_approvals').upsert({ workspace_id: workspaceId, kind: 'pause_requested', policy_id: dec.policy_triggered_id, status: 'pending' }, { onConflict: 'workspace_id,policy_id', ignoreDuplicates: true })
      }

      const blockedBody = { ...(dec.blocked_body ?? {}), error: 'policy_exceeded', request_id }
      res.status(dec.blocked_http_status ?? 429).setHeader('content-type', 'application/json').send(JSON.stringify(blockedBody))
      return
    }

    // Upstream
    const upstreamModel = dec.decision === 'downgraded' ? dec.model_routed : requestedModel
    const upstreamBody = { ...body, model: upstreamModel, stream: false }

    const providerKey = process.env.ANVX_DEV_OPENAI_KEY ?? ''
    if (!providerKey) {
      sendError(res, 'anvx_unavailable', request_id, { error_stage: 'no_provider_key' })
      return
    }

    console.log("ENG_4 upstream_start", { request_id, model: upstreamModel })
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
        await bestEffortUsage({ ...usageBase, model_routed: upstreamModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', shadow_suggestion: null, reasoning: 'Upstream timeout.', policy_triggered: null, upstream_latency_ms: UPSTREAM_TIMEOUT_MS, total_latency_ms: Date.now() - startedAt })
        await auditLog(workspaceId, 'upstream_timeout', request_id)
        sendError(res, 'upstream_timeout', request_id, { provider: 'openai', model: upstreamModel })
        return
      }
      throw fetchErr
    }
    clearTimeout(timeout)

    const upstreamLatencyMs = Date.now() - startedAt
    console.log("ENG_5 upstream_done", { request_id, status: upstreamRes.status, upstream_ms: upstreamLatencyMs })

    // Upstream error mapping
    if (upstreamRes.status === 429) {
      const retryAfter = upstreamRes.headers.get('retry-after')
      await bestEffortUsage({ ...usageBase, model_routed: upstreamModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', shadow_suggestion: null, reasoning: 'Upstream rate limited.', policy_triggered: null, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: Date.now() - startedAt })
      await auditLog(workspaceId, 'upstream_rate_limit', request_id)
      sendError(res, 'upstream_rate_limit', request_id, { upstream_retry_after: retryAfter })
      return
    }

    if (upstreamRes.status >= 500) {
      await bestEffortUsage({ ...usageBase, model_routed: upstreamModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', shadow_suggestion: null, reasoning: `Upstream ${upstreamRes.status}.`, policy_triggered: null, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: Date.now() - startedAt })
      await auditLog(workspaceId, 'upstream_error', request_id)
      sendError(res, 'upstream_error', request_id, { upstream_status: upstreamRes.status })
      return
    }

    // Success path
    const upstreamText = await upstreamRes.text()
    console.log("ENG_6 response_ready", { request_id, bodyLen: upstreamText.length })

    let tokensIn = 0
    let tokensOut = 0
    try {
      const p = JSON.parse(upstreamText)
      tokensIn = p?.usage?.prompt_tokens ?? 0
      tokensOut = p?.usage?.completion_tokens ?? 0
    } catch {}
    console.log("PARSED_USAGE", { request_id, tokensIn, tokensOut })

    const totalLatencyMs = Date.now() - startedAt
    await bestEffortUsage({ ...usageBase, model_routed: dec.model_routed, tokens_in: tokensIn, tokens_out: tokensOut, decision: dec.decision, shadow_suggestion: dec.shadow_suggestion, reasoning: dec.reasoning, policy_triggered: dec.policy_triggered_id, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: totalLatencyMs })

    res.status(upstreamRes.status).setHeader('content-type', 'application/json').send(upstreamText)
  } catch (err: any) {
    console.error("ENG_CRASH", { request_id, error: err?.message, stack: err?.stack })
    if (workspaceId) await auditLog(workspaceId, 'anvx_unavailable', request_id)
    if (!res.headersSent) {
      sendError(res, 'anvx_unavailable', request_id, { error_stage: 'unhandled' })
    }
  }
}
