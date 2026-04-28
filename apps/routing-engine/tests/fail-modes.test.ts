import { describe, it, expect, vi, beforeEach } from 'vitest'

// Env
process.env.SUPABASE_URL = 'https://fake.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake_key'
process.env.ANVX_DEV_OPENAI_KEY = 'sk-test-dev'

// Shared mock state
const state = {
  tokenLookup: null as any,
  contextResult: null as any,
  contextShouldTimeout: false,
  closedPolicyExists: false,
  upstreamStatus: 200,
  upstreamBody: '{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
  upstreamShouldTimeout: false,
}

vi.mock('@supabase/supabase-js', () => {
  const noop = { then: (cb: Function) => { cb?.(); return { catch: () => {} } } }
  return {
    createClient: () => ({
      from: (table: string) => {
        if (table === 'anvx_api_tokens') {
          return {
            select: () => ({ eq: () => ({ is: () => ({ single: () => Promise.resolve(state.tokenLookup ?? { data: null, error: { code: 'PGRST116' } }) }) }) }),
            update: () => ({ eq: () => noop }),
          }
        }
        if (table === 'budget_policies') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: () => ({ single: () => Promise.resolve(state.closedPolicyExists ? { data: { id: 'pol-1' }, error: null } : { data: null, error: null }) }) }) }) }) }),
          }
        }
        if (table === 'routing_usage_records') return { insert: () => Promise.resolve({ error: null }) }
        if (table === 'audit_log') return { insert: () => Promise.resolve({ error: null }) }
        if (table === 'models') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }
        return { insert: () => noop, select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }), upsert: () => noop }
      },
      rpc: () => ({
        single: () => {
          if (state.contextShouldTimeout) return new Promise(() => {}) // never resolves
          return Promise.resolve(state.contextResult ?? { data: { routing_mode: 'observer', policies: [], rules: [], period_spend: { day_cents: 0, month_cents: 0, hourly_baseline_cents: 100 } }, error: null })
        },
      }),
    }),
  }
})

vi.mock('../api/src/decide', async () => {
  const actual = await vi.importActual('../api/src/decide') as any
  return {
    ...actual,
    loadContext: async () => {
      if (state.contextShouldTimeout) {
        await new Promise((_, rej) => setTimeout(() => rej(new Error('context_timeout')), 50))
      }
      return state.contextResult?.data ?? { routing_mode: 'observer', policies: [], rules: [], period_spend: { day_cents: 0, month_cents: 0, hourly_baseline_cents: 100 } }
    },
  }
})

vi.mock('../api/src/meter', () => ({
  writeUsage: async () => {},
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import handler once — vitest module caching is fine since state is external
import handler from '../api/route'
import { errorResponse, safeMessage } from '../api/src/errors'

// Minimal VercelRequest/VercelResponse mocks
function makeReq(overrides: any = {}): any {
  return {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer anvx_live_testtoken1234567890abcdefgh', 'content-type': 'application/json', ...overrides.headers },
    body: 'body' in overrides ? overrides.body : { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 },
  }
}

function makeRes(): any {
  const r: any = { statusCode: 0, headers: {} as Record<string, string>, body: '', headersSent: false }
  r.status = (s: number) => { r.statusCode = s; return r }
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; return r }
  r.send = (b: string) => { r.body = b; r.headersSent = true; return r }
  r.json = (b: any) => { r.body = JSON.stringify(b); r.headersSent = true; return r }
  return r
}

describe('fail modes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tokenLookup = { data: { id: 'tok-1', workspace_id: 'ws-1' }, error: null }
    state.contextResult = { data: { routing_mode: 'observer', policies: [], rules: [], period_spend: { day_cents: 0, month_cents: 0, hourly_baseline_cents: 100 } }, error: null }
    state.contextShouldTimeout = false
    state.closedPolicyExists = false
    state.upstreamStatus = 200
    state.upstreamBody = '{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}'
    state.upstreamShouldTimeout = false
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(new Response(state.upstreamBody, { status: 200, headers: { 'content-type': 'application/json' } }))
  })

  it('context timeout + fail_mode=open → passthrough, decision=failed_open', async () => {
    state.contextShouldTimeout = true
    state.closedPolicyExists = false


    const req = makeReq()
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(200)
    expect(mockFetch).toHaveBeenCalled()
  })

  it('context timeout + fail_mode=closed → HTTP 503 anvx_unavailable', async () => {
    state.contextShouldTimeout = true
    state.closedPolicyExists = true


    const req = makeReq()
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('anvx_unavailable')
  })

  it('upstream 500 → HTTP 502 upstream_error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))


    const req = makeReq()
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('upstream_error')
    expect(body.detail?.upstream_status).toBe(500)
  })

  it('upstream timeout → HTTP 504 upstream_timeout', async () => {
    mockFetch.mockImplementationOnce(() => new Promise((_, rej) => setTimeout(() => { const e = new Error('aborted'); (e as any).name = 'AbortError'; rej(e) }, 50)))


    const req = makeReq()
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(504)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('upstream_timeout')
  })

  it('upstream 429 → HTTP 429 upstream_rate_limit', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Rate limited', { status: 429, headers: { 'retry-after': '30' } }))


    const req = makeReq()
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(429)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('upstream_rate_limit')
    expect(body.detail?.upstream_retry_after).toBe('30')
  })

  it('bad auth → HTTP 401 authentication_failed', async () => {

    const req = makeReq({ headers: { authorization: 'Bearer bad_token' } })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('authentication_failed')
  })

  it('malformed body → HTTP 400 malformed_request', async () => {

    const req = makeReq({ body: null })
    const res = makeRes()
    await handler(req, res)

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('malformed_request')
  })
})
