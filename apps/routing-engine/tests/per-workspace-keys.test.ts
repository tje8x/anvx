import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Test env ──────────────────────────────────────────────────────────────
process.env.SUPABASE_URL = 'https://fake.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake_key'
// Stable 32-byte master key (filled with 0x01) so encrypt/decrypt round-trips
// inside the test process. Real production keys live in Vercel envs.
process.env.ANVX_MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64')

const WORKSPACE_ID = '11111111-2222-3333-4444-555555555555'
const ANTHROPIC_PLAINTEXT = 'sk-ant-test-PLAINTEXT-anthropic-12345'
const OPENAI_PLAINTEXT = 'sk-test-PLAINTEXT-openai-67890'
const COHERE_PLAINTEXT = 'co-PLAINTEXT-cohere-abcde'

// ─── Supabase mock ────────────────────────────────────────────────────────
// Lets each test set what `provider_keys` and the RPC return.
type SupaState = {
  providerKeyRows: Array<{ provider: string; envelope: string }>
  rpcData: any
  rpcError: any
}
const supaState: SupaState = {
  providerKeyRows: [],
  rpcData: { routing_mode: 'observer', policies: [], rules: [], period_spend: { day_cents: 0, month_cents: 0, hourly_baseline_cents: 0 } },
  rpcError: null,
}

vi.mock('@supabase/supabase-js', () => {
  return {
    createClient: () => ({
      from: (table: string) => {
        if (table === 'provider_keys') {
          // .select('provider, envelope').eq('workspace_id', x).is('deleted_at', null) is awaited as a thenable
          const result = { data: supaState.providerKeyRows, error: null }
          const chain: any = {}
          chain.select = () => chain
          chain.eq = () => chain
          chain.is = () => chain
          chain.then = (onFulfilled: (v: any) => any) => Promise.resolve(result).then(onFulfilled)
          return chain
        }
        return { insert: () => ({ then: (cb: Function) => { cb(); return { catch: () => {} } } }) }
      },
      rpc: () => Promise.resolve({ data: supaState.rpcData, error: supaState.rpcError }),
    }),
  }
})

import { encryptProviderKey } from '../api/src/crypto'
import { _clearContextCache, loadContext, type RoutingContext } from '../api/src/decide'
import { resolveProviderKey } from '../api/src/keys'
import { buildUpstreamRequest } from '../api/src/upstream'

function makeCtxWithKeys(keys: Partial<Record<string, string>>): RoutingContext {
  return {
    routing_mode: 'observer',
    policies: [],
    rules: [],
    period_spend: { day_cents: 0, month_cents: 0, hourly_baseline_cents: 0 },
    providerKeys: keys as any,
  }
}

describe('loadContext populates providerKeys from provider_keys', () => {
  beforeEach(() => {
    _clearContextCache()
    supaState.providerKeyRows = []
    supaState.rpcError = null
  })

  it('builds a per-provider envelope map from the DB rows', async () => {
    supaState.providerKeyRows = [
      { provider: 'anthropic', envelope: encryptProviderKey(ANTHROPIC_PLAINTEXT, WORKSPACE_ID) },
      { provider: 'openai', envelope: encryptProviderKey(OPENAI_PLAINTEXT, WORKSPACE_ID) },
    ]
    const ctx = await loadContext(WORKSPACE_ID)
    expect(ctx).not.toBeNull()
    expect(Object.keys(ctx!.providerKeys ?? {}).sort()).toEqual(['anthropic', 'openai'])
    // Envelopes are opaque to context; decrypt happens later, in keys.ts.
    expect(typeof ctx!.providerKeys!.anthropic).toBe('string')
  })

  it('returns an empty providerKeys map when no rows', async () => {
    supaState.providerKeyRows = []
    _clearContextCache()
    const ctx = await loadContext(WORKSPACE_ID)
    expect(ctx).not.toBeNull()
    expect(ctx!.providerKeys).toEqual({})
  })
})

describe('resolveProviderKey decrypts the right envelope', () => {
  it('Anthropic envelope → decrypted x-api-key', () => {
    const env = encryptProviderKey(ANTHROPIC_PLAINTEXT, WORKSPACE_ID)
    const ctx = makeCtxWithKeys({ anthropic: env })
    const r = resolveProviderKey('anthropic', ctx, WORKSPACE_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.key).toBe(ANTHROPIC_PLAINTEXT)
    expect(r.source).toBe('workspace')

    const built = buildUpstreamRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      openaiBody: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      providerKey: r.key,
    })
    expect(built.headers['x-api-key']).toBe(ANTHROPIC_PLAINTEXT)
    expect(built.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('OpenAI envelope → decrypted Bearer token', () => {
    const env = encryptProviderKey(OPENAI_PLAINTEXT, WORKSPACE_ID)
    const ctx = makeCtxWithKeys({ openai: env })
    const r = resolveProviderKey('openai', ctx, WORKSPACE_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')

    const built = buildUpstreamRequest({
      provider: 'openai',
      model: 'gpt-4o',
      openaiBody: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      providerKey: r.key,
    })
    expect(built.headers['Authorization']).toBe(`Bearer ${OPENAI_PLAINTEXT}`)
  })

  it('Cohere envelope → decrypted Bearer token at /v2/chat', () => {
    const env = encryptProviderKey(COHERE_PLAINTEXT, WORKSPACE_ID)
    const ctx = makeCtxWithKeys({ cohere: env })
    const r = resolveProviderKey('cohere', ctx, WORKSPACE_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')

    const built = buildUpstreamRequest({
      provider: 'cohere',
      model: 'command-r-plus',
      openaiBody: { model: 'command-r-plus', messages: [{ role: 'user', content: 'hi' }] },
      providerKey: r.key,
    })
    expect(built.url.endsWith('/chat')).toBe(true)
    expect(built.headers['Authorization']).toBe(`Bearer ${COHERE_PLAINTEXT}`)
  })

  it('Workspace requesting anthropic with only openai connected → no_key_connected', () => {
    const env = encryptProviderKey(OPENAI_PLAINTEXT, WORKSPACE_ID)
    const ctx = makeCtxWithKeys({ openai: env })
    const r = resolveProviderKey('anthropic', ctx, WORKSPACE_ID)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('no_key_connected')
  })

  it('Workspace with no connected keys at all → no_key_connected', () => {
    const ctx = makeCtxWithKeys({})
    const r = resolveProviderKey('anthropic', ctx, WORKSPACE_ID)
    expect(r.ok).toBe(false)
  })
})

describe('decrypted plaintext is never logged', () => {
  // vitest's spyOn return type is generic and varies between minor versions; using
  // `any` keeps the test resilient without losing the actual spy behavior at runtime.
  let logSpy: any
  let warnSpy: any
  let errSpy: any

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('plaintext key never appears in any console.* call across the full resolve+build pipeline', () => {
    const env = encryptProviderKey(ANTHROPIC_PLAINTEXT, WORKSPACE_ID)
    const ctx = makeCtxWithKeys({ anthropic: env })
    const r = resolveProviderKey('anthropic', ctx, WORKSPACE_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    buildUpstreamRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      openaiBody: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      providerKey: r.key,
    })

    const allCalls = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errSpy.mock.calls,
    ]
    const blob = JSON.stringify(allCalls)
    expect(blob).not.toContain(ANTHROPIC_PLAINTEXT)
    // Sanity: `PLAINTEXT` substring appears in the test constant; if it leaks it'd show up here.
    expect(blob).not.toMatch(/PLAINTEXT/i)
  })
})

describe('dev fallback toggle', () => {
  const origNodeEnv = process.env.NODE_ENV
  const origAllow = process.env.ALLOW_DEV_FALLBACK_KEYS
  const origDevKey = process.env.ANVX_DEV_ANTHROPIC_KEY

  afterEach(() => {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = origNodeEnv
    if (origAllow === undefined) delete process.env.ALLOW_DEV_FALLBACK_KEYS
    else process.env.ALLOW_DEV_FALLBACK_KEYS = origAllow
    if (origDevKey === undefined) delete process.env.ANVX_DEV_ANTHROPIC_KEY
    else process.env.ANVX_DEV_ANTHROPIC_KEY = origDevKey
  })

  it('NODE_ENV=development + ALLOW_DEV_FALLBACK_KEYS=1 → dev key returned with warning', () => {
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_DEV_FALLBACK_KEYS = '1'
    process.env.ANVX_DEV_ANTHROPIC_KEY = 'sk-ant-DEVFALLBACK-xxxx'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = resolveProviderKey('anthropic', makeCtxWithKeys({}), WORKSPACE_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.key).toBe('sk-ant-DEVFALLBACK-xxxx')
    expect(r.source).toBe('dev_fallback')
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toMatch(/TEST MODE ONLY/)

    warnSpy.mockRestore()
  })

  it('NODE_ENV=production + ALLOW_DEV_FALLBACK_KEYS=1 → production guard wins, no fallback', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_DEV_FALLBACK_KEYS = '1'
    process.env.ANVX_DEV_ANTHROPIC_KEY = 'sk-ant-DEVFALLBACK-xxxx'

    const r = resolveProviderKey('anthropic', makeCtxWithKeys({}), WORKSPACE_ID)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('no_key_connected')
  })

  it('NODE_ENV=development + ALLOW_DEV_FALLBACK_KEYS unset → no fallback', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.ALLOW_DEV_FALLBACK_KEYS
    process.env.ANVX_DEV_ANTHROPIC_KEY = 'sk-ant-DEVFALLBACK-xxxx'

    const r = resolveProviderKey('anthropic', makeCtxWithKeys({}), WORKSPACE_ID)
    expect(r.ok).toBe(false)
  })
})

describe('bootstrap config check', () => {
  const origMaster = process.env.ANVX_MASTER_ENCRYPTION_KEY

  afterEach(() => {
    if (origMaster === undefined) delete process.env.ANVX_MASTER_ENCRYPTION_KEY
    else process.env.ANVX_MASTER_ENCRYPTION_KEY = origMaster
  })

  it('flags ok when master key decodes to 32 bytes', async () => {
    process.env.ANVX_MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
    vi.resetModules()
    const mod = await import('../api/src/bootstrap.js')
    mod._resetBootstrapStatus()
    expect(mod.getBootstrapStatus().ok).toBe(true)
  })

  it('flags not-ok and logs fatal when ANVX_MASTER_ENCRYPTION_KEY missing', async () => {
    delete process.env.ANVX_MASTER_ENCRYPTION_KEY
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.resetModules()
    const mod = await import('../api/src/bootstrap.js')
    mod._resetBootstrapStatus()
    const status = mod.getBootstrapStatus()
    expect(status.ok).toBe(false)
    expect(status.reason).toMatch(/ANVX_MASTER_ENCRYPTION_KEY/)
    expect(errSpy).toHaveBeenCalled()
    expect(errSpy.mock.calls[0][0]).toMatch(/FATAL/)

    errSpy.mockRestore()
  })

  it('flags not-ok when master key is not 32 bytes', async () => {
    process.env.ANVX_MASTER_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64')
    vi.resetModules()
    const mod = await import('../api/src/bootstrap.js')
    mod._resetBootstrapStatus()
    const status = mod.getBootstrapStatus()
    expect(status.ok).toBe(false)
    expect(status.reason).toMatch(/32 bytes/)
  })
})
