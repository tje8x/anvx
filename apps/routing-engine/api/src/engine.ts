import { Hono } from 'hono'
import pino from 'pino'
import { authMiddleware, type TokenInfo } from './auth'
import { loadRoutingContext } from './context'
import { decide } from './decide'
import { forwardToUpstream } from './upstream'
import { writeUsage } from './meter'
import { decryptProviderKey } from './crypto'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

type Env = { Variables: { tokenInfo: TokenInfo } }

export const engine = new Hono<Env>()

engine.use('/*', authMiddleware)

engine.post('/chat/completions', async (c) => {
  const request_id = crypto.randomUUID()
  const startedAt = Date.now()

  try {
    console.log("ENG_1 auth_complete", { request_id })
    const { workspaceId, tokenId } = c.get('tokenInfo')

    const body = await c.req.json() as Record<string, unknown>
    const requestedModel = (body.model as string) ?? 'gpt-4o'
    const isStream = body.stream === true

    // H: Force stream=false unless explicitly true
    if (!isStream) {
      body.stream = false
    }

    log.info({ request_id, workspace_id: workspaceId, model: requestedModel, stream: isStream }, 'request.start')

    // Load routing context (cached 30s per instance)
    const ctx = await loadRoutingContext(workspaceId)
    console.log("ENG_2 context_loaded", { request_id, workspaceId })

    // Decide (observer mode — always passthrough)
    const decision = decide(ctx, requestedModel)

    // Get provider key (stub: uses dev env var)
    let providerKey: string
    try {
      providerKey = decryptProviderKey(workspaceId, null as any)
    } catch {
      providerKey = process.env.ANVX_DEV_OPENAI_KEY ?? ""
    }
    console.log("ENG_3 key_resolved", { request_id, keyLen: providerKey.length })

    // G: Fail fast if no key
    if (!providerKey) {
      console.error("ENG_ERR no_provider_key", { request_id })
      return c.json({ error: 'configuration', message: 'No provider API key available' }, 502)
    }

    // Forward to upstream
    console.log("ENG_4 upstream_start", { request_id, stream: isStream })
    const upstreamStart = Date.now()
    const upstreamRes = await forwardToUpstream(body, providerKey)
    const upstreamLatencyMs = Date.now() - upstreamStart
    console.log("ENG_5 upstream_done", { request_id, status: upstreamRes.status, upstream_ms: upstreamLatencyMs })

    // Parse usage from response (non-streaming only for now)
    const tokensIn = 0
    const tokensOut = 0

    const totalLatencyMs = Date.now() - startedAt
    log.info({ request_id, status: upstreamRes.status, upstream_ms: upstreamLatencyMs, total_ms: totalLatencyMs }, 'request.complete')

    // Record usage — best effort, don't throw
    writeUsage({
      request_id,
      workspace_id: workspaceId,
      token_id: tokenId,
      model_requested: requestedModel,
      model_routed: requestedModel,
      provider: 'openai',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      decision: decision.action,
      observer_suggestion: decision.suggestedModel,
      reasoning: decision.reason ?? undefined,
      upstream_latency_ms: upstreamLatencyMs,
      total_latency_ms: totalLatencyMs,
      project_tag: c.req.header('x-anvx-project') ?? null,
      user_hint: c.req.header('x-anvx-user') ?? null,
    }).catch(() => {})

    if (isStream) {
      // B: Use c.body() instead of raw Response for streaming
      if (!upstreamRes.body) {
        console.log("ENG_6 stream_no_body", { request_id })
        return c.json({ error: 'upstream', message: 'Upstream returned no body' }, 502)
      }
      console.log("ENG_6 stream_response", { request_id })
      return c.body(upstreamRes.body, upstreamRes.status as any, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
    }

    // Non-streaming: buffer and return via c.json/c.body
    const responseBody = await upstreamRes.text()
    console.log("ENG_6 non_stream_response", { request_id, bodyLen: responseBody.length })
    return c.body(responseBody, upstreamRes.status as any, {
      'content-type': 'application/json',
    })
  } catch (err: any) {
    console.error("ENG_CRASH", { request_id, error: err?.message, stack: err?.stack })
    return c.json({ error: 'internal', message: err?.message ?? 'unknown error' }, 500)
  }
})

engine.all('*', (c) => {
  console.log("ENGINE_CATCH_ALL", c.req.method, c.req.path, c.req.url)
  return c.json({ error: 'not_found', path: c.req.path }, 404)
})
