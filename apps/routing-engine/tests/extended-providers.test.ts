import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  resolveProvider,
  translateRequestToProvider,
  translateResponseToOpenAI,
  translateToCohere,
  translateFromCohere,
} from '../api/src/providers'
import { buildUpstreamRequest, forwardToUpstream } from '../api/src/upstream'

describe('resolveProvider — extended providers', () => {
  it.each([
    ['command-r-plus', 'cohere', 'command-r-plus'],
    ['command-light', 'cohere', 'command-light'],
    ['cohere/command-r-plus', 'cohere', 'command-r-plus'],
    ['together/meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    ['fireworks/firefunction-v2', 'fireworks', 'firefunction-v2'],
    ['accounts/fireworks/models/llama-v3p1-70b-instruct', 'fireworks', 'accounts/fireworks/models/llama-v3p1-70b-instruct'],
    ['replicate/meta/llama-3-70b-instruct', 'replicate', 'meta/llama-3-70b-instruct'],
    // HF-org-style names with no explicit prefix → Together heuristic.
    ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    ['mistralai/Mixtral-8x7B-Instruct-v0.1', 'together', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
  ])('routes %s → %s (%s)', (input, provider, model) => {
    const r = resolveProvider(input)
    expect(r.provider).toBe(provider)
    expect(r.model).toBe(model)
    expect(r.fallback).toBe(false)
  })

  it('unknown plain model → fallback to openai with warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = resolveProvider('mistral-large-2409')
    expect(r.provider).toBe('openai')
    expect(r.fallback).toBe(true)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toMatch(/falling back to openai/i)
    warnSpy.mockRestore()
  })
})

describe('Cohere translation', () => {
  it('builds an OpenAI-shaped messages body for /v2/chat', () => {
    const body = translateToCohere({
      model: 'command-r-plus',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 256,
      temperature: 0.4,
    })
    expect((body.messages as any[])[0]).toEqual({ role: 'system', content: 'Be concise.' })
    expect(body.max_tokens).toBe(256)
    expect(body.temperature).toBe(0.4)
  })

  it('translates Cohere v2 response → OpenAI choices/usage shape', () => {
    const out = translateFromCohere(
      {
        id: 'co-1',
        finish_reason: 'COMPLETE',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        usage: { tokens: { input_tokens: 7, output_tokens: 3 } },
      },
      'command-r-plus',
    )
    expect((out.choices as any[])[0].message.content).toBe('hello')
    expect((out.choices as any[])[0].finish_reason).toBe('stop')
    expect((out.usage as any).prompt_tokens).toBe(7)
    expect((out.usage as any).completion_tokens).toBe(3)
  })
})

describe('buildUpstreamRequest — extended providers', () => {
  it('Cohere → /v2/chat with Bearer auth', () => {
    const out = buildUpstreamRequest({
      provider: 'cohere',
      model: 'command-r-plus',
      openaiBody: { model: 'command-r-plus', messages: [{ role: 'user', content: 'x' }] },
      providerKey: 'co-test',
    })
    expect(out.url).toBe('https://api.cohere.com/v2/chat')
    expect(out.headers['Authorization']).toBe('Bearer co-test')
    expect((out.body as any).model).toBe('command-r-plus')
  })

  it('Together (with prefix stripped) → /v1/chat/completions', () => {
    const r = resolveProvider('together/meta-llama/Llama-3.3-70B-Instruct-Turbo')
    const out = buildUpstreamRequest({
      provider: r.provider,
      model: r.model,
      openaiBody: { model: r.model, messages: [{ role: 'user', content: 'hi' }] },
      providerKey: 'tg-test',
    })
    expect(out.url).toBe('https://api.together.xyz/v1/chat/completions')
    expect(out.headers['Authorization']).toBe('Bearer tg-test')
    expect((out.body as any).model).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo')
    expect((out.body as any).stream).toBe(false)
  })

  it('Fireworks → /inference/v1/chat/completions', () => {
    const out = buildUpstreamRequest({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
      openaiBody: {
        model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
        messages: [{ role: 'user', content: 'hi' }],
      },
      providerKey: 'fw-test',
    })
    expect(out.url).toBe('https://api.fireworks.ai/inference/v1/chat/completions')
    expect(out.headers['Authorization']).toBe('Bearer fw-test')
    expect((out.body as any).model).toBe('accounts/fireworks/models/llama-v3p1-70b-instruct')
  })
})

describe('Replicate sync wrapper', () => {
  const origFetch = globalThis.fetch
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    // @ts-expect-error global override for test
    globalThis.fetch = mockFetch
    // Speed up the polling loop deterministically.
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = origFetch
  })

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('creates prediction, polls until succeeded, returns final body', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(201, { id: 'pred_1', status: 'starting' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'pred_1', status: 'processing' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'pred_1', status: 'succeeded', output: ['Hello ', 'world'] }))

    const promise = forwardToUpstream({
      provider: 'replicate',
      model: 'meta/llama-3-70b-instruct',
      openaiBody: {
        model: 'meta/llama-3-70b-instruct',
        messages: [{ role: 'user', content: 'hi' }],
      },
      providerKey: 'r8_test',
    })

    // Drain the poll waits.
    await vi.advanceTimersByTimeAsync(1_100)
    await vi.advanceTimersByTimeAsync(1_100)

    const result = await promise
    expect(result.status).toBe(200)

    // Verify the create call carried the "Token <key>" header (NOT "Bearer").
    const [createUrl, createOpts] = mockFetch.mock.calls[0]
    expect(String(createUrl)).toContain('/predictions')
    expect(createOpts.headers['Authorization']).toBe('Token r8_test')

    // Verify the poll URL uses the prediction id.
    const [pollUrl] = mockFetch.mock.calls[1]
    expect(String(pollUrl)).toContain('/predictions/pred_1')

    // Final translated body has the joined output.
    const translated = translateResponseToOpenAI('replicate', 'meta/llama-3-70b-instruct', JSON.parse(result.rawText))
    expect((translated.choices as any[])[0].message.content).toBe('Hello world')
  })

  it('returns 502 when prediction fails', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(201, { id: 'pred_2', status: 'starting' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'pred_2', status: 'failed', error: 'oom' }))

    const promise = forwardToUpstream({
      provider: 'replicate',
      model: 'meta/llama-3-70b-instruct',
      openaiBody: {
        model: 'meta/llama-3-70b-instruct',
        messages: [{ role: 'user', content: 'hi' }],
      },
      providerKey: 'r8_test',
    })
    await vi.advanceTimersByTimeAsync(1_100)
    const result = await promise
    expect(result.status).toBe(502)
  })
})

describe('translateRequestToProvider dispatcher', () => {
  it('Together passes through OpenAI-shaped body with stream forced off', () => {
    const out = translateRequestToProvider('together', {
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    })
    expect(out.stream).toBe(false)
    expect((out.messages as any[])[0]).toEqual({ role: 'user', content: 'x' })
  })

  it('Fireworks behaves the same as Together (passthrough)', () => {
    const out = translateRequestToProvider('fireworks', {
      model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect((out.messages as any[])[0]).toEqual({ role: 'user', content: 'x' })
  })

  it('Replicate produces input/prompt structure (not OpenAI messages)', () => {
    const out = translateRequestToProvider('replicate', {
      model: 'meta/llama-3-70b-instruct',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
      max_tokens: 100,
    })
    expect((out as any).input.prompt).toMatch(/User: hello/)
    expect((out as any).input.system_prompt).toBe('be brief')
    expect((out as any).input.max_new_tokens).toBe(100)
  })
})
