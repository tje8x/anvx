import type { Provider, OpenAIChatBody } from './providers'
import { translateRequestToProvider } from './providers'

const OPENAI_BASE = 'https://api.openai.com/v1'
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const COHERE_BASE = 'https://api.cohere.com/v2'
const TOGETHER_BASE = 'https://api.together.xyz/v1'
const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1'
const REPLICATE_BASE = 'https://api.replicate.com/v1'

const ANTHROPIC_VERSION = '2023-06-01'
const UPSTREAM_TIMEOUT_MS = 25_000

const REPLICATE_POLL_INTERVAL_MS = 1_000
const REPLICATE_OVERALL_TIMEOUT_MS = 60_000

function resolveUpstreamBase(defaultBase: string): string {
  const mockBase = process.env.MOCK_UPSTREAM_BASE
  if (!mockBase) return defaultBase

  const isProd = process.env.NODE_ENV === 'production'
  const explicitlyAllowed = process.env.ALLOW_MOCK_UPSTREAM === '1'
  if (isProd && !explicitlyAllowed) {
    console.error(
      `[upstream] IGNORING MOCK_UPSTREAM_BASE in production (NODE_ENV=production, ALLOW_MOCK_UPSTREAM!=1). Set ALLOW_MOCK_UPSTREAM=1 to force.`,
    )
    return defaultBase
  }
  return mockBase
}

const OPENAI_BASE_RESOLVED = resolveUpstreamBase(OPENAI_BASE)
const ANTHROPIC_BASE_RESOLVED = resolveUpstreamBase(ANTHROPIC_BASE)
const GOOGLE_BASE_RESOLVED = resolveUpstreamBase(GOOGLE_BASE)
const COHERE_BASE_RESOLVED = resolveUpstreamBase(COHERE_BASE)
const TOGETHER_BASE_RESOLVED = resolveUpstreamBase(TOGETHER_BASE)
const FIREWORKS_BASE_RESOLVED = resolveUpstreamBase(FIREWORKS_BASE)
const REPLICATE_BASE_RESOLVED = resolveUpstreamBase(REPLICATE_BASE)

if (OPENAI_BASE_RESOLVED !== OPENAI_BASE) {
  console.warn(
    `[upstream] ⚠ MOCK_UPSTREAM_BASE active → ${OPENAI_BASE_RESOLVED} (NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}, ALLOW_MOCK_UPSTREAM=${process.env.ALLOW_MOCK_UPSTREAM ?? 'unset'}). Real provider calls are disabled.`,
  )
}

export type UpstreamCall = {
  provider: Provider
  /** Upstream model name (already prefix-stripped for non-fireworks). */
  model: string
  /** Original OpenAI-format body from the client (post-decision). */
  openaiBody: OpenAIChatBody
  /** Provider-native API key — DECRYPTED PLAINTEXT. Never log. */
  providerKey: string
  /** When true, request streaming (SSE) from upstream and skip JSON-buffering. */
  stream?: boolean
}

const STREAM_TIMEOUT_MS = 120_000

export type UpstreamResult = {
  status: number
  /** Raw response text from upstream (untranslated, but already parseable as the provider's response format). */
  rawText: string
  /** Latency-relevant headers (retry-after) for error mapping. */
  headers: Headers
}

function ensureKey(call: UpstreamCall) {
  if (typeof call.providerKey !== 'string' || call.providerKey.length === 0) {
    throw new Error(`providerKey is empty for provider=${call.provider} — refusing to send unauthenticated upstream request`)
  }
}

/**
 * Forward the (already routed) request to the chosen provider. Returns the raw
 * upstream response — caller is responsible for translating the body back to
 * OpenAI format via `translateResponseToOpenAI` from ./providers.
 */
export async function forwardToUpstream(call: UpstreamCall): Promise<UpstreamResult> {
  ensureKey(call)
  if (call.provider === 'replicate') return forwardToReplicate(call)

  const { url, headers, body } = buildUpstreamRequest(call)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    return { status: res.status, rawText: text, headers: res.headers }
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error(`Upstream request timed out after ${UPSTREAM_TIMEOUT_MS}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export function buildUpstreamRequest(call: UpstreamCall): {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  const { provider, model, openaiBody, providerKey, stream = false } = call
  const translated = translateRequestToProvider(provider, openaiBody)

  if (provider === 'anthropic') {
    translated.model = model
    if (stream) translated.stream = true
    return {
      url: `${ANTHROPIC_BASE_RESOLVED}/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': providerKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(stream ? { 'accept': 'text/event-stream' } : {}),
      },
      body: translated,
    }
  }

  if (provider === 'google') {
    // Google uses a different endpoint for streaming; ?alt=sse normalizes the
    // chunk format to standard SSE so our parser handles it.
    const path = stream
      ? `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
      : `/models/${encodeURIComponent(model)}:generateContent`
    return {
      url: `${GOOGLE_BASE_RESOLVED}${path}`,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': providerKey,
      },
      body: translated,
    }
  }

  if (provider === 'cohere') {
    translated.model = model
    // Cohere streaming is supported but we treat the cohere streaming format as
    // an open TODO; for now upstream is buffered even when client asked for stream.
    return {
      url: `${COHERE_BASE_RESOLVED}/chat`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerKey}`,
      },
      body: translated,
    }
  }

  if (provider === 'together') {
    translated.model = model
    translated.stream = stream
    if (stream) {
      translated.stream_options = { include_usage: true }
    }
    return {
      url: `${TOGETHER_BASE_RESOLVED}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerKey}`,
      },
      body: translated,
    }
  }

  if (provider === 'fireworks') {
    translated.model = model
    translated.stream = stream
    if (stream) {
      translated.stream_options = { include_usage: true }
    }
    return {
      url: `${FIREWORKS_BASE_RESOLVED}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerKey}`,
      },
      body: translated,
    }
  }

  // OpenAI default
  translated.model = model
  translated.stream = stream
  if (stream) {
    // Required for the engine to capture token counts from the SSE stream.
    translated.stream_options = { include_usage: true }
  }
  return {
    url: `${OPENAI_BASE_RESOLVED}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${providerKey}`,
    },
    body: translated,
  }
}

/**
 * Open a streaming connection to the upstream and return the raw `Response`
 * with body still attached. Caller is responsible for piping (and timing out)
 * the body. The 120s budget covers slow chat completions but won't sit on a
 * dead connection forever.
 *
 * Streaming is not supported for Replicate (predictions are async) or Cohere
 * (different SSE shape, TODO). Callers should fall back to `forwardToUpstream`.
 */
export async function openUpstreamStream(call: UpstreamCall): Promise<Response> {
  ensureKey(call)
  if (call.provider === 'replicate' || call.provider === 'cohere') {
    throw new Error(`streaming not supported for provider=${call.provider}`)
  }
  const { url, headers, body } = buildUpstreamRequest({ ...call, stream: true })
  const controller = new AbortController()
  // Stream timeout is enforced by the caller via AbortController on the underlying
  // fetch; we expose an aborter so route.ts can tear down on disconnect.
  const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    // We deliberately do NOT clear the timeout here — it must keep running
    // until the body is consumed. Caller calls `cancelStreamTimeout(res)` if
    // they want to release it sooner.
    ;(res as any).__cancelTimeout = () => clearTimeout(timeout)
    return res
  } catch (err: unknown) {
    clearTimeout(timeout)
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error(`Upstream stream timed out after ${STREAM_TIMEOUT_MS}ms`)
    }
    throw err
  }
}

export function cancelStreamTimeout(res: Response): void {
  const fn = (res as any).__cancelTimeout
  if (typeof fn === 'function') fn()
}

// ─── Replicate sync wrapper ────────────────────────────────────────────────
//
// Replicate's predictions API is asynchronous: POST creates a prediction with
// status='starting' and we have to poll GET /predictions/{id} until the status
// settles to 'succeeded'/'failed'/'canceled'. For v1 we expose this as a
// synchronous call with a 60s overall budget. Streaming + long-running async
// predictions are a future improvement — when we add SSE streaming we should
// switch to Replicate's `stream: true` mode and pipe the SSE through directly.
//
// `sleep` is split out to make tests deterministic via vi.useFakeTimers.
export function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function forwardToReplicate(call: UpstreamCall): Promise<UpstreamResult> {
  const { model, openaiBody, providerKey } = call
  const translated = translateRequestToProvider('replicate', openaiBody)
  // The dispatcher embeds the model name under __replicate_model; pull it out.
  const modelId = (translated.__replicate_model as string) ?? model
  delete (translated as Record<string, unknown>).__replicate_model

  const createBody: Record<string, unknown> = { ...translated, model: modelId }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Replicate uses "Token <key>", NOT "Bearer <key>".
    'Authorization': `Token ${providerKey}`,
  }

  // Step 1 — create the prediction.
  const startedAt = Date.now()
  const createRes = await fetch(`${REPLICATE_BASE_RESOLVED}/predictions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(createBody),
  })
  const createText = await createRes.text()
  if (createRes.status >= 400) {
    return { status: createRes.status, rawText: createText, headers: createRes.headers }
  }

  let prediction: Record<string, unknown>
  try {
    prediction = JSON.parse(createText) as Record<string, unknown>
  } catch {
    return { status: 502, rawText: createText, headers: createRes.headers }
  }

  // Step 2 — poll until terminal state or budget exhausted.
  while (true) {
    const status = typeof prediction.status === 'string' ? prediction.status : ''
    if (status === 'succeeded') {
      return { status: 200, rawText: JSON.stringify(prediction), headers: createRes.headers }
    }
    if (status === 'failed' || status === 'canceled') {
      return { status: 502, rawText: JSON.stringify(prediction), headers: createRes.headers }
    }

    if (Date.now() - startedAt > REPLICATE_OVERALL_TIMEOUT_MS) {
      throw new Error(`Upstream request timed out after ${REPLICATE_OVERALL_TIMEOUT_MS}ms`)
    }

    await _sleep(REPLICATE_POLL_INTERVAL_MS)

    const id = typeof prediction.id === 'string' ? prediction.id : ''
    if (!id) {
      return { status: 502, rawText: JSON.stringify(prediction), headers: createRes.headers }
    }
    const pollRes = await fetch(`${REPLICATE_BASE_RESOLVED}/predictions/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers,
    })
    const pollText = await pollRes.text()
    if (pollRes.status >= 400) {
      return { status: pollRes.status, rawText: pollText, headers: pollRes.headers }
    }
    try {
      prediction = JSON.parse(pollText) as Record<string, unknown>
    } catch {
      return { status: 502, rawText: pollText, headers: pollRes.headers }
    }
  }
}

export const UPSTREAM_TIMEOUT_MS_EXPORT = UPSTREAM_TIMEOUT_MS
