import './src/sentry'
import { Sentry } from './src/sentry'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { loadContext, decide, type DecisionResult, type RoutingContext } from './src/decide'
import { writeUsage } from './src/meter'
import { errorResponse, safeMessage, type ErrorKind } from './src/errors'
import { forwardToUpstream, openUpstreamStream, cancelStreamTimeout, type UpstreamResult } from './src/upstream'
import {
  resolveProvider,
  translateResponseToOpenAI,
  type OpenAIChatBody,
} from './src/providers'
import { resolveProviderKey } from './src/keys'
import { getBootstrapStatus } from './src/bootstrap'
import { pipeAndTranslateStream, type StreamWriteSink } from './src/stream'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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

    // Bootstrap check — refuse to handle requests if the master encryption key
    // isn't usable. We can't decrypt provider keys without it, so every request
    // would fail anyway; failing fast with a clear status keeps the symptom honest.
    const boot = getBootstrapStatus()
    if (!boot.ok) {
      sendError(res, 'anvx_unavailable', request_id, { error_stage: 'bootstrap', reason: boot.reason })
      return
    }

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
    let body: OpenAIChatBody
    try {
      const raw = req.body
      if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
      body = raw as OpenAIChatBody
    } catch {
      sendError(res, 'malformed_request', request_id)
      await auditLog(workspaceId, 'malformed_request', request_id)
      return
    }

    const requestedRawModel = (body?.model as string) ?? 'gpt-4o'
    const projectTag = (req.headers['x-anvx-project'] as string) ?? undefined
    const userHint = (req.headers['x-anvx-user'] as string) ?? undefined

    // Resolve provider from the model name. Done up-front so usage rows record
    // the right provider even when context-load or upstream fails.
    const requestedResolution = resolveProvider(requestedRawModel)
    const requestedProvider = requestedResolution.provider

    // Load routing context with 2s timeout
    let ctx: RoutingContext | null = null
    let dec: DecisionResult
    const usageBase = {
      request_id,
      workspace_id: workspaceId,
      token_id: tokenId,
      model_requested: requestedRawModel,
      provider: requestedProvider,
      project_tag: projectTag ?? null,
      user_hint: userHint ?? null,
    }

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
        await bestEffortUsage({ ...usageBase, model_routed: requestedRawModel, tokens_in: 0, tokens_out: 0, decision: 'failed_closed', observer_suggestion: null, reasoning: 'Context load failed — fail-closed policy active.', policy_triggered: null, upstream_latency_ms: 0, total_latency_ms: Date.now() - startedAt })
        await auditLog(workspaceId, 'anvx_unavailable', request_id)
        sendError(res, 'anvx_unavailable', request_id, { error_stage: 'context_load' })
        return
      }

      // fail-open
      ctx = null
    }

    if (!ctx) {
      dec = { decision: 'failed_open', model_routed: requestedRawModel, provider_routed: requestedProvider, reasoning: 'Context load failed — failed open.', policy_triggered_id: null, observer_suggestion: null }
    } else {
      console.log("ENG_2 context_loaded", { request_id, routing_mode: ctx.routing_mode })
      const messagesStr = body?.messages ? JSON.stringify(body.messages) : ''
      const tokensInEstimate = Math.ceil(messagesStr.length / 4)
      const maxTokens = (body?.max_tokens as number) ?? 1024

      dec = await decide(ctx, { workspace_id: workspaceId, model_requested: requestedRawModel, tokens_in_estimate: tokensInEstimate, max_tokens: maxTokens, project_tag: projectTag, user_hint: userHint }, {})
    }

    console.log("ENG_3 decision", { request_id, decision: dec.decision, model_routed: dec.model_routed, policy: dec.policy_triggered_id })

    // Blocked
    if (dec.decision === 'blocked') {
      const totalLatencyMs = Date.now() - startedAt
      await bestEffortUsage({ ...usageBase, model_routed: dec.model_routed, tokens_in: 0, tokens_out: 0, decision: dec.decision, observer_suggestion: dec.observer_suggestion, reasoning: dec.reasoning, policy_triggered: dec.policy_triggered_id, upstream_latency_ms: 0, total_latency_ms: totalLatencyMs })
      await auditLog(workspaceId, 'policy_exceeded', request_id)

      if (ctx?.routing_mode === 'copilot' && dec.policy_triggered_id) {
        await supabase.from('copilot_approvals').upsert({ workspace_id: workspaceId, kind: 'pause_requested', policy_id: dec.policy_triggered_id, status: 'pending' }, { onConflict: 'workspace_id,policy_id', ignoreDuplicates: true })
      }

      const blockedBody = { ...(dec.blocked_body ?? {}), error: 'policy_exceeded', request_id }
      res.status(dec.blocked_http_status ?? 429).setHeader('content-type', 'application/json').send(JSON.stringify(blockedBody))
      return
    }

    // Resolve provider for the *routed* model — a downgrade may switch providers
    // (e.g. claude-opus-4 → claude-haiku-4-5 stays Anthropic; gpt-4o → claude-haiku
    // would cross provider boundaries).
    const routedRawModel = dec.decision === 'downgraded' ? dec.model_routed : requestedRawModel
    const routedResolution = resolveProvider(routedRawModel)
    const routedProvider = routedResolution.provider
    const routedModel = routedResolution.model

    const keyRes = resolveProviderKey(routedProvider, ctx, workspaceId)
    if (!keyRes.ok) {
      // No workspace-connected key for this provider, no dev-fallback either —
      // surface a 400 with a clear remediation path. This must be a 4xx (the
      // request is well-formed; it's the workspace config that's incomplete),
      // not a 5xx, so client retry logic doesn't loop on it.
      const totalLatencyMs = Date.now() - startedAt
      await bestEffortUsage({ ...usageBase, model_routed: routedRawModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', observer_suggestion: null, reasoning: 'No provider key connected for routed provider.', policy_triggered: null, upstream_latency_ms: 0, total_latency_ms: totalLatencyMs })
      await auditLog(workspaceId, 'no_provider_key_connected', request_id)
      const body = {
        error: 'no_provider_key_connected',
        message: `No ${routedProvider} API key connected for this workspace. Connect at https://anvx.io/settings/connections.`,
        request_id,
      }
      res.status(400).setHeader('content-type', 'application/json').send(JSON.stringify(body))
      return
    }
    const providerKey = keyRes.key

    // Streaming is opt-in via the client's `stream:true`. Cohere + Replicate
    // don't support our stream proxy yet, so we transparently fall back to the
    // buffered path for those providers. The client still gets the right
    // response — just all-at-once instead of token-by-token.
    const clientWantsStream = body?.stream === true
    const streamingPath =
      clientWantsStream && routedProvider !== 'replicate' && routedProvider !== 'cohere'

    // The body we forward upstream uses the user's original messages but pinned
    // to the routed model. `stream` flag is set per-path below.
    const upstreamOpenAIBody: OpenAIChatBody = { ...body, model: routedModel, stream: streamingPath }

    console.log("ENG_4 upstream_start", { request_id, provider: routedProvider, model: routedModel, stream: streamingPath })

    if (streamingPath) {
      let upstreamResp: Response
      try {
        upstreamResp = await openUpstreamStream({
          provider: routedProvider,
          model: routedModel,
          openaiBody: upstreamOpenAIBody,
          providerKey,
          stream: true,
        })
      } catch (fetchErr: any) {
        const isTimeout = typeof fetchErr?.message === 'string' && fetchErr.message.includes('timed out')
        if (isTimeout) {
          await bestEffortUsage({ ...usageBase, model_routed: routedRawModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', observer_suggestion: null, reasoning: 'Upstream stream timeout.', policy_triggered: null, upstream_latency_ms: Date.now() - startedAt, total_latency_ms: Date.now() - startedAt })
          await auditLog(workspaceId, 'upstream_timeout', request_id)
          sendError(res, 'upstream_timeout', request_id, { provider: routedProvider, model: routedModel })
          return
        }
        throw fetchErr
      }

      const upstreamLatencyMs = Date.now() - startedAt

      // Non-2xx → consume the body as JSON error and surface like the buffered path.
      if (upstreamResp.status === 429 || upstreamResp.status >= 500 || upstreamResp.status >= 400) {
        const errText = await upstreamResp.text().catch(() => '')
        cancelStreamTimeout(upstreamResp)
        if (upstreamResp.status === 429) {
          const retryAfter = upstreamResp.headers.get('retry-after')
          await bestEffortUsage({ ...usageBase, model_routed: routedRawModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', observer_suggestion: null, reasoning: 'Upstream rate limited.', policy_triggered: null, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: Date.now() - startedAt })
          await auditLog(workspaceId, 'upstream_rate_limit', request_id)
          sendError(res, 'upstream_rate_limit', request_id, { upstream_retry_after: retryAfter, provider: routedProvider })
          return
        }
        if (upstreamResp.status >= 500) {
          await bestEffortUsage({ ...usageBase, model_routed: routedRawModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', observer_suggestion: null, reasoning: `Upstream ${upstreamResp.status}.`, policy_triggered: null, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: Date.now() - startedAt })
          await auditLog(workspaceId, 'upstream_error', request_id)
          sendError(res, 'upstream_error', request_id, { upstream_status: upstreamResp.status, provider: routedProvider })
          return
        }
        // 4xx other than 429 — pass through the upstream error body, translated minimally.
        res.status(upstreamResp.status).setHeader('content-type', 'application/json').send(errText || JSON.stringify({ error: 'upstream_error', request_id }))
        return
      }

      // SSE response headers. Disable buffering on intermediaries (nginx, etc.)
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-cache, no-transform')
      res.setHeader('connection', 'keep-alive')
      res.setHeader('x-accel-buffering', 'no')

      const sink: StreamWriteSink = {
        write: (chunk) => { res.write(Buffer.from(chunk)) },
        end: () => { res.end() },
        flush: () => { /* node http auto-flushes on write */ },
      }

      // If the client disconnects mid-stream, the connection is gone — there's
      // no point trying to res.end() (it would no-op) and no point keeping the
      // function alive on the response side. We still want the meter row, so
      // we record clientAborted and let the success path write usage with the
      // partial counts before bailing.
      let clientAborted = false
      req.on('close', () => {
        if (!res.writableEnded) clientAborted = true
      })

      let usage = { prompt_tokens: 0, completion_tokens: 0, observed: false }
      let streamFailed = false
      try {
        // endOnFinish: false — we own the sink lifecycle. The meter row MUST
        // be written before res.end() because Vercel's serverless runtime can
        // kill the function once res.end() fires; meter writes after that
        // point may be lost.
        usage = await pipeAndTranslateStream(upstreamResp, routedProvider, routedRawModel, sink, { endOnFinish: false })
      } catch (streamErr: any) {
        streamFailed = true
        console.error("ENG_STREAM_ERROR", { request_id, provider: routedProvider, error: streamErr?.message })
        await auditLog(workspaceId, 'upstream_error', request_id)
      } finally {
        cancelStreamTimeout(upstreamResp)
      }

      // Order matters here:
      //   1. pipe stream content (already done above)
      //   2. await the meter write
      //   3. THEN end the response
      // Reversing 2 and 3 lets Vercel kill the function before the Supabase
      // insert completes, which is the bug this refactor fixes.
      const totalLatencyMs = Date.now() - startedAt
      await bestEffortUsage({
        ...usageBase,
        model_routed: dec.model_routed,
        tokens_in: usage.prompt_tokens,
        tokens_out: usage.completion_tokens,
        decision: dec.decision,
        observer_suggestion: dec.observer_suggestion,
        reasoning: clientAborted ? 'Client aborted stream.' : streamFailed ? 'Stream errored mid-flight.' : dec.reasoning,
        policy_triggered: dec.policy_triggered_id,
        upstream_latency_ms: upstreamLatencyMs,
        total_latency_ms: totalLatencyMs,
      })

      console.log("ENG_6 stream_done", { request_id, provider: routedProvider, tokens_in: usage.prompt_tokens, tokens_out: usage.completion_tokens, observed: usage.observed, aborted: clientAborted, failed: streamFailed })

      // Close the response only after the meter row is durable. If the client
      // already disconnected, res.end() is a no-op and we just return. We
      // always close the sink (even on error) so any client still listening
      // sees a clean termination instead of a hung connection.
      if (!clientAborted) {
        try { sink.end() } catch { /* sink already ended */ }
      }
      return
    }


    let upstreamRes: UpstreamResult
    try {
      upstreamRes = await forwardToUpstream({
        provider: routedProvider,
        model: routedModel,
        openaiBody: upstreamOpenAIBody,
        providerKey,
      })
    } catch (fetchErr: any) {
      const isTimeout = typeof fetchErr?.message === 'string' && fetchErr.message.includes('timed out')
      if (isTimeout) {
        console.error("ENG_ERR upstream_timeout", { request_id, provider: routedProvider })
        await bestEffortUsage({ ...usageBase, model_routed: routedRawModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', observer_suggestion: null, reasoning: 'Upstream timeout.', policy_triggered: null, upstream_latency_ms: Date.now() - startedAt, total_latency_ms: Date.now() - startedAt })
        await auditLog(workspaceId, 'upstream_timeout', request_id)
        sendError(res, 'upstream_timeout', request_id, { provider: routedProvider, model: routedModel })
        return
      }
      throw fetchErr
    }

    const upstreamLatencyMs = Date.now() - startedAt
    console.log("ENG_5 upstream_done", { request_id, status: upstreamRes.status, upstream_ms: upstreamLatencyMs })

    // Upstream error mapping (status codes are reasonably consistent across providers)
    if (upstreamRes.status === 429) {
      const retryAfter = upstreamRes.headers.get('retry-after')
      await bestEffortUsage({ ...usageBase, model_routed: routedRawModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', observer_suggestion: null, reasoning: 'Upstream rate limited.', policy_triggered: null, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: Date.now() - startedAt })
      await auditLog(workspaceId, 'upstream_rate_limit', request_id)
      sendError(res, 'upstream_rate_limit', request_id, { upstream_retry_after: retryAfter, provider: routedProvider })
      return
    }

    if (upstreamRes.status >= 500) {
      await bestEffortUsage({ ...usageBase, model_routed: routedRawModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', observer_suggestion: null, reasoning: `Upstream ${upstreamRes.status}.`, policy_triggered: null, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: Date.now() - startedAt })
      await auditLog(workspaceId, 'upstream_error', request_id)
      sendError(res, 'upstream_error', request_id, { upstream_status: upstreamRes.status, provider: routedProvider })
      return
    }

    // Success path — translate provider-native response to OpenAI format so
    // the client SDK works unchanged.
    let translated: Record<string, unknown>
    let tokensIn = 0
    let tokensOut = 0
    try {
      const parsed = JSON.parse(upstreamRes.rawText) as Record<string, unknown>
      translated = translateResponseToOpenAI(routedProvider, routedRawModel, parsed)
      const usage = (translated.usage as Record<string, unknown> | undefined) ?? {}
      tokensIn = Number(usage.prompt_tokens ?? 0) || 0
      tokensOut = Number(usage.completion_tokens ?? 0) || 0
    } catch (parseErr) {
      console.error("ENG_TRANSLATE_FAIL", { request_id, provider: routedProvider, error: (parseErr as Error)?.message })
      // If we can't parse a successful upstream body something is genuinely
      // wrong — surface as a 5xx rather than feeding garbage to the client.
      await bestEffortUsage({ ...usageBase, model_routed: routedRawModel, tokens_in: 0, tokens_out: 0, decision: 'failed_open', observer_suggestion: null, reasoning: 'Upstream response not parseable.', policy_triggered: null, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: Date.now() - startedAt })
      sendError(res, 'upstream_error', request_id, { upstream_status: upstreamRes.status, provider: routedProvider, reason: 'parse_failed' })
      return
    }

    console.log("PARSED_USAGE", { request_id, tokensIn, tokensOut, provider: routedProvider })

    const totalLatencyMs = Date.now() - startedAt
    await bestEffortUsage({ ...usageBase, model_routed: dec.model_routed, tokens_in: tokensIn, tokens_out: tokensOut, decision: dec.decision, observer_suggestion: dec.observer_suggestion, reasoning: dec.reasoning, policy_triggered: dec.policy_triggered_id, upstream_latency_ms: upstreamLatencyMs, total_latency_ms: totalLatencyMs })

    res.status(upstreamRes.status).setHeader('content-type', 'application/json').send(JSON.stringify(translated))
  } catch (err: any) {
    console.error("ENG_CRASH", { request_id, error: err?.message, stack: err?.stack })
    if (workspaceId) await auditLog(workspaceId, 'anvx_unavailable', request_id)
    if (!res.headersSent) {
      sendError(res, 'anvx_unavailable', request_id, { error_stage: 'unhandled' })
    }
  }
}
