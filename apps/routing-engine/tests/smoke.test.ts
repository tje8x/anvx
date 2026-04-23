import { describe, it, expect, vi, beforeEach } from 'vitest'

// Set env vars before anything
process.env.SUPABASE_URL = 'https://fake.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake_key'
process.env.ANVX_DEV_OPENAI_KEY = 'sk-test-dev'

// Shared mock state
const state = {
  tokenLookup: null as { data: unknown; error: unknown } | null,
}

vi.mock('@supabase/supabase-js', () => {
  const noop = { then: (cb: Function) => { cb(); return { catch: () => {} } } }
  return {
    createClient: () => ({
      from: (table: string) => {
        if (table === 'tokens') {
          return {
            select: () => ({
              eq: () => ({
                is: () => ({
                  single: () => Promise.resolve(state.tokenLookup ?? { data: null, error: { code: 'PGRST116' } }),
                }),
              }),
            }),
            update: () => ({ eq: () => noop }),
          }
        }
        return { insert: () => noop }
      },
      rpc: () => ({
        single: () => Promise.resolve({ data: { daily_spend_cents: 0, monthly_spend_cents: 0, hourly_baseline_cents: 0, model_routing_rules: [], budget_policies: [] }, error: null }),
      }),
    }),
  }
})

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { Hono } from 'hono'
import { engine } from '../src/engine.js'
import { clearContextCache } from '../src/context.js'

const app = new Hono()
app.route('/v1', engine)

const VALID_TOKEN = 'anvx_live_testtoken1234567890abcdefghijklmnopq'

function makeRequest(token?: string, body?: Record<string, unknown>) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['authorization'] = `Bearer ${token}`
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }], stream: false }),
  })
}

describe('routing-engine', () => {
  beforeEach(() => {
    state.tokenLookup = null
    mockFetch.mockReset()
    clearContextCache()
  })

  it('returns 401 when no token provided', async () => {
    const res = await app.fetch(makeRequest())
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/missing/i)
  })

  it('returns 401 for malformed token (not anvx_live_ prefix)', async () => {
    const res = await app.fetch(makeRequest('some_random_token'))
    expect(res.status).toBe(401)
  })

  it('returns 401 for revoked token', async () => {
    state.tokenLookup = { data: null, error: { code: 'PGRST116' } }
    const res = await app.fetch(makeRequest(VALID_TOKEN))
    expect(res.status).toBe(401)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/invalid|revoked/i)
  })

  it('returns 401 for unknown token hash (different workspace)', async () => {
    state.tokenLookup = { data: null, error: { code: 'PGRST116' } }
    const otherToken = 'anvx_live_differentworkspacetoken123456789ab'
    const res = await app.fetch(makeRequest(otherToken))
    expect(res.status).toBe(401)
  })

  it('returns 200 with valid token and non-streaming response', async () => {
    state.tokenLookup = { data: { id: 'tok-1', workspace_id: 'ws-1' }, error: null }

    const upstreamBody = JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'hi' } }] })
    mockFetch.mockResolvedValueOnce(new Response(upstreamBody, { status: 200, headers: { 'content-type': 'application/json' } }))

    const res = await app.fetch(makeRequest(VALID_TOKEN))
    expect(res.status).toBe(200)
    const data = await res.json() as { choices: unknown[] }
    expect(data.choices).toBeDefined()
    expect(mockFetch).toHaveBeenCalledOnce()
  })
})
