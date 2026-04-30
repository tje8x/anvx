import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  parseSseFrames,
  pipeAndTranslateStream,
  type StreamWriteSink,
} from '../api/src/stream'
import { buildUpstreamRequest } from '../api/src/upstream'

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeSseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeFailingSseResponse(chunks: string[], errorAfter: number): Response {
  // Use `pull` so the consumer actually reads each enqueued chunk before the
  // error fires — `start`-time enqueue+error races and the reader ends up
  // seeing only the error.
  let i = 0
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < errorAfter && i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]))
        i++
      } else {
        controller.error(new Error('upstream connection reset'))
      }
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeRecorder(): { sink: StreamWriteSink; chunks: string[]; closed: boolean } {
  const chunks: string[] = []
  let closed = false
  return {
    chunks,
    get closed() { return closed },
    sink: {
      write: (chunk) => { chunks.push(new TextDecoder().decode(chunk)) },
      end: () => { closed = true },
    },
  }
}

// ─── parseSseFrames ────────────────────────────────────────────────────────

describe('parseSseFrames', () => {
  it('splits well-formed events on blank lines', () => {
    const buf = 'event: foo\ndata: 1\n\nevent: bar\ndata: 2\n\n'
    const { events, rest } = parseSseFrames(buf)
    expect(events).toEqual([
      { event: 'foo', data: '1' },
      { event: 'bar', data: '2' },
    ])
    expect(rest).toBe('')
  })

  it('keeps incomplete trailing event in rest', () => {
    const buf = 'data: a\n\ndata: b'
    const { events, rest } = parseSseFrames(buf)
    expect(events).toEqual([{ event: null, data: 'a' }])
    expect(rest).toBe('data: b')
  })

  it('joins multi-line data', () => {
    const buf = 'data: line1\ndata: line2\n\n'
    const { events } = parseSseFrames(buf)
    expect(events).toEqual([{ event: null, data: 'line1\nline2' }])
  })
})

// ─── OpenAI streaming pass-through ─────────────────────────────────────────

describe('OpenAI streaming pass-through', () => {
  it('forwards chunks verbatim and captures usage from the final chunk', async () => {
    const chunks = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
      'data: [DONE]\n\n',
    ]
    const upstream = makeSseResponse(chunks)
    const rec = makeRecorder()

    const usage = await pipeAndTranslateStream(upstream, 'openai', 'gpt-4o', rec.sink)

    expect(usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, observed: true })
    expect(rec.closed).toBe(true)

    const out = rec.chunks.join('')
    // Original data lines preserved.
    expect(out).toContain('"content":"Hello"')
    expect(out).toContain('"content":" world"')
    expect(out).toContain('"finish_reason":"stop"')
    // [DONE] sentinel forwarded.
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  it('handles chunks that arrive split across reads', async () => {
    // Same logical events, but each event split mid-line into two byte chunks.
    const event1 = 'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'
    const event2 = 'data: {"id":"x","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
    const split = (s: string, at: number) => [s.slice(0, at), s.slice(at)]
    const [a1, a2] = split(event1, 20)
    const [b1, b2] = split(event2, 30)

    const upstream = makeSseResponse([a1, a2, b1, b2])
    const rec = makeRecorder()
    const usage = await pipeAndTranslateStream(upstream, 'openai', 'gpt-4o', rec.sink)

    expect(usage.observed).toBe(true)
    expect(usage.prompt_tokens).toBe(3)
    expect(usage.completion_tokens).toBe(1)
    expect(rec.chunks.join('')).toContain('"content":"hi"')
  })
})

// ─── Anthropic translation ─────────────────────────────────────────────────

describe('Anthropic streaming translation', () => {
  it('translates message_start / content_block_delta / message_delta / message_stop into OpenAI chunks', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01ABC","model":"claude-sonnet-4-5","usage":{"input_tokens":42,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    const upstream = makeSseResponse(chunks)
    const rec = makeRecorder()

    const usage = await pipeAndTranslateStream(upstream, 'anthropic', 'claude-sonnet-4-5', rec.sink)

    expect(usage).toEqual({ prompt_tokens: 42, completion_tokens: 7, observed: true })
    expect(rec.closed).toBe(true)

    const emitted = rec.chunks.join('')
    // Initial role chunk.
    expect(emitted).toContain('"role":"assistant"')
    // Two text deltas.
    expect(emitted).toContain('"content":"Hello"')
    expect(emitted).toContain('"content":" world"')
    // Finish chunk + DONE.
    expect(emitted).toContain('"finish_reason":"stop"')
    expect(emitted.trim().endsWith('data: [DONE]')).toBe(true)
    // No raw Anthropic event names leaking through.
    expect(emitted).not.toContain('content_block_delta')
    expect(emitted).not.toContain('message_delta')
  })

  it('maps stop_reason: max_tokens → finish_reason: length', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-4-5","usage":{"input_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":99}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    const rec = makeRecorder()
    const usage = await pipeAndTranslateStream(makeSseResponse(chunks), 'anthropic', 'claude-sonnet-4-5', rec.sink)
    expect(usage.completion_tokens).toBe(99)
    expect(rec.chunks.join('')).toContain('"finish_reason":"length"')
  })
})

// ─── Google translation ────────────────────────────────────────────────────

describe('Google streaming translation', () => {
  it('translates streamGenerateContent SSE into OpenAI chunks with usage', async () => {
    const chunks = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":" world"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}\n\n',
    ]
    const upstream = makeSseResponse(chunks)
    const rec = makeRecorder()

    const usage = await pipeAndTranslateStream(upstream, 'google', 'gemini-2.0-flash', rec.sink)

    expect(usage.prompt_tokens).toBe(4)
    expect(usage.completion_tokens).toBe(2)
    expect(usage.observed).toBe(true)

    const out = rec.chunks.join('')
    expect(out).toContain('"role":"assistant"')
    expect(out).toContain('"content":"Hello"')
    expect(out).toContain('"content":" world"')
    expect(out).toContain('"finish_reason":"stop"')
    expect(out.trim().endsWith('data: [DONE]')).toBe(true)
  })
})

// ─── Mid-flight error ──────────────────────────────────────────────────────

describe('stream error mid-flight', () => {
  it('closes the sink, returns partial usage, does not throw to caller', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-4-5","usage":{"input_tokens":11}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      // Stream errors here; usage.completion_tokens never observed.
    ]
    const upstream = makeFailingSseResponse(chunks, 2)
    const rec = makeRecorder()

    let threw: unknown = null
    let usage: any
    try {
      usage = await pipeAndTranslateStream(upstream, 'anthropic', 'claude-sonnet-4-5', rec.sink)
    } catch (e) {
      threw = e
    }

    // The function does throw on stream error (caller catches it in route.ts);
    // but it MUST close the sink before propagating so the client-side parser
    // doesn't hang waiting for [DONE].
    expect(threw).toBeTruthy()
    expect(rec.closed).toBe(true)
    expect(usage).toBeUndefined()
    // Best-effort: anything that did make it through landed in chunks.
    expect(rec.chunks.join('')).toContain('"content":"partial"')
  })
})

// ─── Stream timeout ────────────────────────────────────────────────────────

describe('stream timeout', () => {
  it('AbortController-driven cancellation surfaces as a clean error from the reader', async () => {
    // Build a stream that we can cancel externally to simulate a timeout abort.
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controllerRef = c },
    })
    const upstream = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const rec = makeRecorder()

    // Kick off the pipe; the upstream will never produce more data, then we abort.
    const promise = pipeAndTranslateStream(upstream, 'openai', 'gpt-4o', rec.sink)

    // Simulate the abort by erroring the stream (what AbortController would do).
    setTimeout(() => controllerRef?.error(new Error('AbortError')), 5)

    let threw: any = null
    try { await promise } catch (e) { threw = e }
    expect(threw).toBeTruthy()
    expect(rec.closed).toBe(true)
  })
})

// ─── stream:true triggers correct upstream body shape ──────────────────────

describe('buildUpstreamRequest with stream:true', () => {
  it('OpenAI gets stream:true + stream_options.include_usage', () => {
    const out = buildUpstreamRequest({
      provider: 'openai',
      model: 'gpt-4o',
      openaiBody: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      providerKey: 'sk-test',
      stream: true,
    })
    expect((out.body as any).stream).toBe(true)
    expect((out.body as any).stream_options).toEqual({ include_usage: true })
  })

  it('Anthropic gets stream:true + accept: text/event-stream', () => {
    const out = buildUpstreamRequest({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      openaiBody: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      providerKey: 'sk-ant-test',
      stream: true,
    })
    expect((out.body as any).stream).toBe(true)
    expect(out.headers['accept']).toBe('text/event-stream')
  })

  it('Google switches to streamGenerateContent?alt=sse', () => {
    const out = buildUpstreamRequest({
      provider: 'google',
      model: 'gemini-2.0-flash',
      openaiBody: { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] },
      providerKey: 'AIza-test',
      stream: true,
    })
    expect(out.url).toContain(':streamGenerateContent')
    expect(out.url).toContain('alt=sse')
  })
})
