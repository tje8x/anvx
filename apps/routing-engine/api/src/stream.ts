/**
 * SSE streaming proxy + per-provider translation.
 *
 * The engine speaks OpenAI Chat Completions on its public surface, so every
 * upstream stream gets normalized into OpenAI's SSE shape:
 *
 *   data: { id, object: 'chat.completion.chunk', choices: [{ delta, index, finish_reason? }] }\n\n
 *   ...
 *   data: [DONE]\n\n
 *
 * For OpenAI-compatible upstreams (OpenAI, Together, Fireworks) we pass the
 * SSE through verbatim. For Anthropic and Google we translate event-by-event.
 *
 * Token counts come from the final upstream event:
 *  - OpenAI: last `data:` chunk before [DONE] has `usage` when stream_options.include_usage is set.
 *  - Anthropic: `message_start` carries `usage.input_tokens`; `message_delta` carries `usage.output_tokens`.
 *  - Google: each chunk may have `usageMetadata`; the last one wins.
 *
 * The proxy buffers nothing user-visible — chunks are written to the client
 * immediately. We only retain enough state to compute the meter row at end-of-stream.
 */

import type { Provider } from './providers'

export type StreamUsage = {
  prompt_tokens: number
  completion_tokens: number
  /** True if usage was reported by upstream; false when we never saw it. */
  observed: boolean
}

export type StreamWriteSink = {
  write: (chunk: Uint8Array) => void
  end: () => void
  /** Best-effort flush hint (Node http response). */
  flush?: () => void
}

const ENCODER = new TextEncoder()

function encode(line: string): Uint8Array {
  return ENCODER.encode(line)
}

function sseData(payload: unknown): Uint8Array {
  return encode(`data: ${JSON.stringify(payload)}\n\n`)
}

function sseDone(): Uint8Array {
  return encode('data: [DONE]\n\n')
}

function safeJsonParse(s: string): any | null {
  try { return JSON.parse(s) } catch { return null }
}

/**
 * Parse a chunk of SSE bytes into discrete events. Returns the parsed events
 * plus any leftover bytes that didn't terminate in a blank line yet (caller
 * concatenates with the next chunk).
 */
export function parseSseFrames(buffer: string): { events: { event: string | null; data: string }[]; rest: string } {
  const events: { event: string | null; data: string }[] = []
  let rest = buffer
  while (true) {
    const sep = rest.indexOf('\n\n')
    if (sep === -1) break
    const raw = rest.slice(0, sep)
    rest = rest.slice(sep + 2)
    let event: string | null = null
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) continue
    events.push({ event, data: dataLines.join('\n') })
  }
  return { events, rest }
}

/**
 * Pipe a streaming Response body to the client sink, translating per-provider
 * events into OpenAI-format SSE chunks. Returns the captured usage when the
 * stream completes (or the best-effort partial usage if it errored mid-flight).
 */
export async function pipeAndTranslateStream(
  upstream: Response,
  provider: Provider,
  modelHint: string,
  sink: StreamWriteSink,
  opts?: { onChunkBytes?: (n: number) => void },
): Promise<StreamUsage> {
  const usage: StreamUsage = { prompt_tokens: 0, completion_tokens: 0, observed: false }
  if (!upstream.body) {
    sink.end()
    return usage
  }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  // OpenAI/Together/Fireworks pass-through tracks usage from the last chunk.
  const passthrough = provider === 'openai' || provider === 'together' || provider === 'fireworks'

  // Anthropic translation state
  let anthropicChatId = ''
  let anthropicCreated = Math.floor(Date.now() / 1000)

  // Google translation state
  let googleChatId = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`
  let googleEmittedRole = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      buffer += text

      const { events, rest } = parseSseFrames(buffer)
      buffer = rest

      for (const ev of events) {
        if (passthrough) {
          // Forward verbatim. Capture usage from the last data chunk before [DONE].
          if (ev.data === '[DONE]') {
            sink.write(sseDone())
            opts?.onChunkBytes?.(11)
            continue
          }
          const parsed = safeJsonParse(ev.data)
          if (parsed && parsed.usage && typeof parsed.usage === 'object') {
            usage.prompt_tokens = Number(parsed.usage.prompt_tokens ?? usage.prompt_tokens) || usage.prompt_tokens
            usage.completion_tokens = Number(parsed.usage.completion_tokens ?? usage.completion_tokens) || usage.completion_tokens
            usage.observed = true
          }
          // Re-emit the raw SSE line (preserve event name if present).
          const out = (ev.event ? `event: ${ev.event}\n` : '') + `data: ${ev.data}\n\n`
          sink.write(encode(out))
          opts?.onChunkBytes?.(out.length)
          continue
        }

        if (provider === 'anthropic') {
          const parsed = safeJsonParse(ev.data)
          if (!parsed) continue
          const type = ev.event ?? parsed.type ?? ''

          if (type === 'message_start') {
            const msg = parsed.message ?? {}
            anthropicChatId = typeof msg.id === 'string' ? msg.id : `chatcmpl-${Math.random().toString(36).slice(2, 12)}`
            anthropicCreated = Math.floor(Date.now() / 1000)
            const inTok = Number(msg.usage?.input_tokens ?? 0) || 0
            if (inTok > 0) {
              usage.prompt_tokens = inTok
              usage.observed = true
            }
            const chunk = {
              id: anthropicChatId,
              object: 'chat.completion.chunk',
              created: anthropicCreated,
              model: typeof msg.model === 'string' ? msg.model : modelHint,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            }
            const bytes = sseData(chunk)
            sink.write(bytes)
            opts?.onChunkBytes?.(bytes.byteLength)
            continue
          }

          if (type === 'content_block_delta') {
            const delta = parsed.delta ?? {}
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              const chunk = {
                id: anthropicChatId,
                object: 'chat.completion.chunk',
                created: anthropicCreated,
                model: modelHint,
                choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
              }
              const bytes = sseData(chunk)
              sink.write(bytes)
              opts?.onChunkBytes?.(bytes.byteLength)
            }
            continue
          }

          if (type === 'message_delta') {
            const outTok = Number(parsed.usage?.output_tokens ?? 0) || 0
            if (outTok > 0) {
              usage.completion_tokens = outTok
              usage.observed = true
            }
            // Emit a finish chunk with the mapped finish_reason.
            const stopReason = typeof parsed.delta?.stop_reason === 'string' ? parsed.delta.stop_reason : null
            const finishReason =
              stopReason === 'end_turn' || stopReason === 'stop_sequence' ? 'stop'
                : stopReason === 'max_tokens' ? 'length'
                : 'stop'
            const chunk = {
              id: anthropicChatId,
              object: 'chat.completion.chunk',
              created: anthropicCreated,
              model: modelHint,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            }
            const bytes = sseData(chunk)
            sink.write(bytes)
            opts?.onChunkBytes?.(bytes.byteLength)
            continue
          }

          if (type === 'message_stop') {
            sink.write(sseDone())
            opts?.onChunkBytes?.(11)
            continue
          }
          // ping / content_block_start / content_block_stop are dropped.
          continue
        }

        if (provider === 'google') {
          const parsed = safeJsonParse(ev.data)
          if (!parsed) continue
          const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : []
          const first = candidates[0] ?? {}
          const parts = Array.isArray(first?.content?.parts) ? first.content.parts : []
          const text = parts
            .filter((p: any) => typeof p?.text === 'string')
            .map((p: any) => p.text as string)
            .join('')
          const finishRaw = typeof first?.finishReason === 'string' ? first.finishReason : null

          if (!googleEmittedRole) {
            const chunk = {
              id: googleChatId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelHint,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            }
            const bytes = sseData(chunk)
            sink.write(bytes)
            opts?.onChunkBytes?.(bytes.byteLength)
            googleEmittedRole = true
          }

          if (text) {
            const chunk = {
              id: googleChatId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelHint,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            }
            const bytes = sseData(chunk)
            sink.write(bytes)
            opts?.onChunkBytes?.(bytes.byteLength)
          }

          if (parsed.usageMetadata) {
            const meta = parsed.usageMetadata
            usage.prompt_tokens = Number(meta.promptTokenCount ?? usage.prompt_tokens) || usage.prompt_tokens
            usage.completion_tokens = Number(meta.candidatesTokenCount ?? usage.completion_tokens) || usage.completion_tokens
            usage.observed = true
          }

          if (finishRaw) {
            const finishReason =
              finishRaw === 'STOP' ? 'stop'
                : finishRaw === 'MAX_TOKENS' ? 'length'
                : finishRaw === 'SAFETY' || finishRaw === 'RECITATION' ? 'content_filter'
                : 'stop'
            const chunk = {
              id: googleChatId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelHint,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            }
            const bytes = sseData(chunk)
            sink.write(bytes)
            opts?.onChunkBytes?.(bytes.byteLength)
            sink.write(sseDone())
          }
          continue
        }
      }
    }
  } finally {
    try { sink.end() } catch { /* sink already ended */ }
  }

  return usage
}
