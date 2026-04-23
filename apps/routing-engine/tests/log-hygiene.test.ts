import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Set env vars before anything
process.env.SUPABASE_URL = 'https://fake.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake_key'
process.env.ANVX_DEV_OPENAI_KEY = 'sk-secretkey1234567890abcdef'
process.env.ANVX_MASTER_ENCRYPTION_KEY = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE='

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
        return {
          insert: () => noop,
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
        }
      },
      rpc: () => ({
        single: () => Promise.resolve({ data: { daily_spend_cents: 0, monthly_spend_cents: 0, hourly_baseline_cents: 0, model_routing_rules: [], budget_policies: [] }, error: null }),
      }),
    }),
  }
})

vi.mock('pino', () => {
  return {
    default: () => ({
      info: (...args: unknown[]) => { (globalThis as any).__pinoCapture?.push(JSON.stringify(args)) },
      error: (...args: unknown[]) => { (globalThis as any).__pinoCapture?.push(JSON.stringify(args)) },
      warn: (...args: unknown[]) => { (globalThis as any).__pinoCapture?.push(JSON.stringify(args)) },
      debug: (...args: unknown[]) => { (globalThis as any).__pinoCapture?.push(JSON.stringify(args)) },
    }),
  }
})

vi.mock('../api/src/crypto', () => ({
  decryptProviderKey: () => 'sk-mocked-never-logged',
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { Hono } from 'hono'
import { engine } from '../api/src/engine'
import { clearContextCache } from '../api/src/context'

const app = new Hono()
app.route('/v1', engine)

const VALID_TOKEN = 'anvx_live_testtoken1234567890abcdefghijklmnopq'

describe('log hygiene', () => {
  let captured: string[]

  beforeEach(() => {
    captured = [];
    (globalThis as any).__pinoCapture = captured
    state.tokenLookup = { data: { id: 'tok-1', workspace_id: 'ws-1' }, error: null }
    mockFetch.mockReset()
    clearContextCache()
  })

  afterEach(() => {
    delete (globalThis as any).__pinoCapture
  })

  it('never emits api keys, tokens, or messages in logs', async () => {
    const secretMessages = [{ role: 'user', content: 'This is a secret message with SSN 123-45-6789' }]
    const upstreamBody = JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'response' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    mockFetch.mockResolvedValueOnce(new Response(upstreamBody, { status: 200, headers: { 'content-type': 'application/json' } }))

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: secretMessages, stream: false }),
    })

    await app.fetch(req)

    const blob = captured.join('\n')

    // Must not contain API keys
    expect(blob).not.toMatch(/sk-[a-zA-Z0-9]{10,}/)
    // Must not contain anvx tokens
    expect(blob).not.toMatch(/anvx_live_[a-zA-Z0-9]{10,}/)
    // Must not contain message content
    expect(blob).not.toMatch(/"messages":/)
    expect(blob).not.toMatch(/secret message/)
    expect(blob).not.toMatch(/123-45-6789/)
    // Must not contain authorization header
    expect(blob).not.toMatch(/"authorization":/)
    // Should contain request_id (proves logging happened)
    expect(blob).toMatch(/request_id/)
    expect(blob).toMatch(/request\.start/)
    expect(blob).toMatch(/request\.complete/)
  })
})
