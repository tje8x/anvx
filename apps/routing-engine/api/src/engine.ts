import { Hono } from 'hono'
import { authMiddleware, type TokenInfo } from './auth'
import { loadRoutingContext } from './context'
import { decide } from './decide'
import { forwardToUpstream } from './upstream'
import { streamResponse } from './stream'
import { recordUsage } from './meter'
import { decryptProviderKey } from './crypto'

type Env = { Variables: { tokenInfo: TokenInfo } }

export const engine = new Hono<Env>()

engine.use('/*', authMiddleware)

engine.post('/chat/completions', async (c) => {
  const start = Date.now()
  const { workspaceId, tokenId } = c.get('tokenInfo')

  const body = await c.req.json() as Record<string, unknown>
  const requestedModel = (body.model as string) ?? 'gpt-4o'
  const isStream = body.stream === true

  // Load routing context (cached 30s per instance)
  const ctx = await loadRoutingContext(workspaceId)

  // Decide (shadow mode — always passthrough)
  const decision = decide(ctx, requestedModel)

  // Get provider key (stub: uses dev env var)
  const providerKey = decryptProviderKey(workspaceId, null)

  // Forward to upstream
  const upstreamRes = await forwardToUpstream(body, providerKey)

  // Record usage asynchronously
  const durationMs = Date.now() - start
  recordUsage(workspaceId, tokenId, decision, durationMs)

  if (isStream) {
    return streamResponse(upstreamRes)
  }

  // Non-streaming: buffer and return
  const responseBody = await upstreamRes.text()
  return new Response(responseBody, {
    status: upstreamRes.status,
    headers: { 'content-type': 'application/json' },
  })
})
