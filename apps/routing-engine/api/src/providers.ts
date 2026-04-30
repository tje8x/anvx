/**
 * Provider routing + request/response translation.
 *
 * Clients always speak OpenAI Chat Completions over the wire (that's the
 * universal SDK shape). The engine routes to the right provider based on the
 * `model` field, translates the body to the provider's native format, and
 * translates the response back to OpenAI format so the client SDK is none the
 * wiser. New providers go in here, not in route.ts.
 */

export type Provider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'cohere'
  | 'together'
  | 'fireworks'
  | 'replicate'

export type ProviderResolution = {
  provider: Provider
  /** Model name with any "provider/" prefix stripped, ready to send upstream. */
  model: string
  /** True if we fell back to OpenAI without a positive prefix match. */
  fallback: boolean
}

const ANTHROPIC_KEYWORD_PREFIXES = ['claude-']
const OPENAI_KEYWORD_PREFIXES = ['gpt-', 'o1-', 'o3-', 'o4-']
const GOOGLE_KEYWORD_PREFIXES = ['gemini-']
const COHERE_KEYWORD_PREFIXES = ['command-']

// Explicit provider-prefixed names. The matched prefix is stripped from the
// canonical model name before being sent upstream.
const EXPLICIT_PROVIDER_PREFIXES: Array<{ prefix: string; provider: Provider; strip: boolean }> = [
  { prefix: 'anthropic/', provider: 'anthropic', strip: true },
  { prefix: 'openai/', provider: 'openai', strip: true },
  { prefix: 'google/', provider: 'google', strip: true },
  { prefix: 'claude/', provider: 'anthropic', strip: true },
  { prefix: 'cohere/', provider: 'cohere', strip: true },
  { prefix: 'together/', provider: 'together', strip: true },
  { prefix: 'fireworks/', provider: 'fireworks', strip: true },
  { prefix: 'replicate/', provider: 'replicate', strip: true },
  // Fireworks SDKs commonly use "accounts/fireworks/models/<x>" — keep the full path
  // as the model name; Fireworks' own API expects this shape.
  { prefix: 'accounts/fireworks/', provider: 'fireworks', strip: false },
]

/** Choose provider + canonical upstream model name from the user-facing model id. */
export function resolveProvider(rawModel: string): ProviderResolution {
  const model = (rawModel ?? '').trim()
  if (!model) {
    return { provider: 'openai', model: 'gpt-4o', fallback: true }
  }

  for (const ent of EXPLICIT_PROVIDER_PREFIXES) {
    if (model.startsWith(ent.prefix)) {
      return {
        provider: ent.provider,
        model: ent.strip ? model.slice(ent.prefix.length) : model,
        fallback: false,
      }
    }
  }

  for (const p of COHERE_KEYWORD_PREFIXES) {
    if (model.startsWith(p)) return { provider: 'cohere', model, fallback: false }
  }
  for (const p of ANTHROPIC_KEYWORD_PREFIXES) {
    if (model.startsWith(p)) return { provider: 'anthropic', model, fallback: false }
  }
  for (const p of OPENAI_KEYWORD_PREFIXES) {
    if (model.startsWith(p)) return { provider: 'openai', model, fallback: false }
  }
  for (const p of GOOGLE_KEYWORD_PREFIXES) {
    if (model.startsWith(p)) return { provider: 'google', model, fallback: false }
  }

  // Heuristic: HF-org-style names like "meta-llama/Llama-3.3-70B-Instruct-Turbo"
  // are nearly always Together inference targets. Explicit "google/" / "openai/" /
  // etc. prefixes have already been claimed above, so anything still containing
  // a "/" lands here.
  if (model.includes('/')) {
    return { provider: 'together', model, fallback: false }
  }

  console.warn(`[providers] unknown model "${model}" — falling back to openai`)
  return { provider: 'openai', model, fallback: true }
}

// ─── OpenAI request shape (what the client sends) ──────────────────────────

type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool'
type OpenAIMessage = {
  role: OpenAIRole | string
  content: string | Array<{ type: string; text?: string }> | null
  name?: string
}
export type OpenAIChatBody = {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  stream?: boolean
  [key: string]: unknown
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function messageTextContent(msg: OpenAIMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && typeof p === 'object' && 'text' in p && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('')
  }
  return ''
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

export function translateToAnthropic(body: OpenAIChatBody): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : []

  const systemParts: string[] = []
  const otherMessages: { role: 'user' | 'assistant'; content: string }[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(messageTextContent(m))
      continue
    }
    if (m.role === 'user' || m.role === 'assistant') {
      otherMessages.push({ role: m.role, content: messageTextContent(m) })
    }
    // 'tool' / unknown roles are dropped — Anthropic doesn't accept the OpenAI tool message shape.
  }

  const out: Record<string, unknown> = {
    model: body.model,
    messages: otherMessages,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 1024,
  }
  if (systemParts.length > 0) out.system = systemParts.join('\n\n')
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (typeof body.stop === 'string') out.stop_sequences = [body.stop]
  else if (Array.isArray(body.stop)) out.stop_sequences = body.stop
  return out
}

export function translateFromAnthropic(
  resp: Record<string, unknown>,
  modelHint: string,
): Record<string, unknown> {
  // Anthropic error bodies look like:
  //   { type: 'error', error: { type: 'invalid_request_error', message: '...' } }
  // Surface them in OpenAI's error envelope instead of fabricating a 200-shape
  // body with empty choices, which is how naive translation produced "successful"
  // responses paired with HTTP 4xx status codes.
  if (resp && resp.type === 'error' && resp.error && typeof resp.error === 'object') {
    const err = resp.error as Record<string, unknown>
    return {
      error: {
        message: typeof err.message === 'string' ? err.message : 'Upstream error',
        type: 'upstream_error',
        code: typeof err.type === 'string' ? err.type : null,
      },
    }
  }
  const content = Array.isArray(resp.content) ? (resp.content as Array<Record<string, unknown>>) : []
  const text = content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('')

  const usage = (resp.usage as Record<string, unknown> | undefined) ?? {}
  const promptTokens = Number(usage.input_tokens ?? 0) || 0
  const completionTokens = Number(usage.output_tokens ?? 0) || 0

  const stopReason = typeof resp.stop_reason === 'string' ? resp.stop_reason : null
  const finishReason =
    stopReason === 'end_turn' ? 'stop'
      : stopReason === 'max_tokens' ? 'length'
      : stopReason === 'stop_sequence' ? 'stop'
      : 'stop'

  return {
    id: typeof resp.id === 'string' ? resp.id : `chatcmpl-${cryptoLikeId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof resp.model === 'string' ? resp.model : modelHint,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

// ─── Google (Gemini) ───────────────────────────────────────────────────────

export function translateToGoogle(body: OpenAIChatBody): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : []

  const systemParts: string[] = []
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(messageTextContent(m))
      continue
    }
    const role = m.role === 'assistant' ? 'model' : 'user'
    const text = messageTextContent(m)
    if (!text) continue
    contents.push({ role, parts: [{ text }] })
  }

  const generationConfig: Record<string, unknown> = {}
  if (typeof body.max_tokens === 'number') generationConfig.maxOutputTokens = body.max_tokens
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p
  if (typeof body.stop === 'string') generationConfig.stopSequences = [body.stop]
  else if (Array.isArray(body.stop)) generationConfig.stopSequences = body.stop

  const out: Record<string, unknown> = { contents }
  if (systemParts.length > 0) {
    out.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }
  }
  if (Object.keys(generationConfig).length > 0) out.generationConfig = generationConfig
  return out
}

export function translateFromGoogle(
  resp: Record<string, unknown>,
  modelHint: string,
): Record<string, unknown> {
  // Google error bodies look like:
  //   { error: { code: 404, message: 'models/foo is not found...', status: 'NOT_FOUND' } }
  // Without this guard the rest of the translator returns choices=[{content:""}]
  // because there's no `candidates` array, which produced an HTTP 4xx response
  // with a 200-shaped body — confusing for clients.
  if (resp && resp.error && typeof resp.error === 'object') {
    const err = resp.error as Record<string, unknown>
    return {
      error: {
        message: typeof err.message === 'string' ? err.message : 'Upstream error',
        type: 'upstream_error',
        code: typeof err.code === 'number' ? err.code : (typeof err.status === 'string' ? err.status : null),
      },
    }
  }
  const candidates = Array.isArray(resp.candidates) ? (resp.candidates as Array<Record<string, unknown>>) : []
  const first = candidates[0] ?? {}
  const content = (first.content as Record<string, unknown> | undefined) ?? {}
  const parts = Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : []
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')

  const meta = (resp.usageMetadata as Record<string, unknown> | undefined) ?? {}
  const promptTokens = Number(meta.promptTokenCount ?? 0) || 0
  const completionTokens = Number(meta.candidatesTokenCount ?? 0) || 0
  const totalTokens = Number(meta.totalTokenCount ?? promptTokens + completionTokens) || 0

  const finishRaw = typeof first.finishReason === 'string' ? first.finishReason : 'STOP'
  const finishReason =
    finishRaw === 'STOP' ? 'stop'
      : finishRaw === 'MAX_TOKENS' ? 'length'
      : finishRaw === 'SAFETY' ? 'content_filter'
      : finishRaw === 'RECITATION' ? 'content_filter'
      : 'stop'

  return {
    id: `chatcmpl-${cryptoLikeId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelHint,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
  }
}

// ─── Cohere v2 ─────────────────────────────────────────────────────────────

export function translateToCohere(body: OpenAIChatBody): Record<string, unknown> {
  // Cohere v2 /chat is OpenAI-shaped: { model, messages: [{role, content}], ... }.
  // We only need to flatten array-content into strings and pass through the rest.
  const messages = Array.isArray(body.messages) ? body.messages : []
  const cohereMessages = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: messageTextContent(m),
  }))

  const out: Record<string, unknown> = {
    model: body.model,
    messages: cohereMessages,
  }
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.p = body.top_p
  if (typeof body.stop === 'string') out.stop_sequences = [body.stop]
  else if (Array.isArray(body.stop)) out.stop_sequences = body.stop
  return out
}

export function translateFromCohere(
  resp: Record<string, unknown>,
  modelHint: string,
): Record<string, unknown> {
  // Cohere v2: { id, finish_reason, message: { role, content: [{type:'text', text}] }, usage: { tokens: { input_tokens, output_tokens } } }
  const message = (resp.message as Record<string, unknown> | undefined) ?? {}
  const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []
  const text = content
    .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('')

  const usage = (resp.usage as Record<string, unknown> | undefined) ?? {}
  // Cohere reports either at top level or nested under tokens/billed_units.
  const tokens = (usage.tokens as Record<string, unknown> | undefined) ?? {}
  const promptTokens = Number(usage.input_tokens ?? tokens.input_tokens ?? 0) || 0
  const completionTokens = Number(usage.output_tokens ?? tokens.output_tokens ?? 0) || 0

  const finishRaw = typeof resp.finish_reason === 'string' ? resp.finish_reason : 'COMPLETE'
  const finishReason =
    finishRaw === 'COMPLETE' || finishRaw === 'STOP_SEQUENCE' ? 'stop'
      : finishRaw === 'MAX_TOKENS' ? 'length'
      : finishRaw === 'ERROR_LIMIT' ? 'length'
      : 'stop'

  return {
    id: typeof resp.id === 'string' ? resp.id : `chatcmpl-${cryptoLikeId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelHint,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

// ─── Together / Fireworks (OpenAI-compatible passthrough) ──────────────────

export function translateToOpenAICompatible(body: OpenAIChatBody): Record<string, unknown> {
  const out = { ...body }
  // Together / Fireworks accept the OpenAI /chat/completions shape directly.
  // We force stream=false because the engine never streams upstream today.
  out.stream = false
  return out
}

// ─── Replicate (predictions API + sync polling) ────────────────────────────

export function translateToReplicateInput(body: OpenAIChatBody): {
  predictionBody: Record<string, unknown>
  /** Replicate model identifier — typically owner/name or owner/name:version. */
  model: string
} {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const systemParts: string[] = []
  const promptParts: string[] = []
  for (const m of messages) {
    const text = messageTextContent(m)
    if (m.role === 'system') systemParts.push(text)
    else if (m.role === 'assistant') promptParts.push(`Assistant: ${text}`)
    else promptParts.push(`User: ${text}`)
  }
  promptParts.push('Assistant:')

  const input: Record<string, unknown> = { prompt: promptParts.join('\n') }
  if (systemParts.length > 0) input.system_prompt = systemParts.join('\n\n')
  if (typeof body.max_tokens === 'number') input.max_new_tokens = body.max_tokens
  if (typeof body.temperature === 'number') input.temperature = body.temperature
  if (typeof body.top_p === 'number') input.top_p = body.top_p

  return {
    predictionBody: { input },
    model: body.model,
  }
}

export function translateFromReplicate(
  prediction: Record<string, unknown>,
  modelHint: string,
): Record<string, unknown> {
  // Replicate predictions return `output` as either a string or an array of
  // strings (token chunks). Normalize to a single string.
  const rawOutput = prediction.output
  const text = Array.isArray(rawOutput)
    ? rawOutput.map((c) => (typeof c === 'string' ? c : '')).join('')
    : typeof rawOutput === 'string' ? rawOutput : ''

  const metrics = (prediction.metrics as Record<string, unknown> | undefined) ?? {}
  const promptTokens = Number(metrics.input_token_count ?? 0) || 0
  const completionTokens = Number(metrics.output_token_count ?? 0) || 0

  return {
    id: typeof prediction.id === 'string' ? `chatcmpl-${prediction.id}` : `chatcmpl-${cryptoLikeId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelHint,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: prediction.status === 'succeeded' ? 'stop' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

// ─── Dispatchers ───────────────────────────────────────────────────────────

export function translateRequestToProvider(
  provider: Provider,
  body: OpenAIChatBody,
): Record<string, unknown> {
  if (provider === 'anthropic') return translateToAnthropic(body)
  if (provider === 'google') return translateToGoogle(body)
  if (provider === 'cohere') return translateToCohere(body)
  if (provider === 'together' || provider === 'fireworks') return translateToOpenAICompatible(body)
  if (provider === 'replicate') {
    // Replicate's flow is special — caller must use the prediction API,
    // not POST a chat body. We return the prediction body and let upstream.ts
    // orchestrate. Embed the model so the caller has both pieces.
    const { predictionBody, model } = translateToReplicateInput(body)
    return { ...predictionBody, __replicate_model: model }
  }
  return { ...body }
}

export function translateResponseToOpenAI(
  provider: Provider,
  modelHint: string,
  providerJson: Record<string, unknown>,
): Record<string, unknown> {
  if (provider === 'anthropic') return translateFromAnthropic(providerJson, modelHint)
  if (provider === 'google') return translateFromGoogle(providerJson, modelHint)
  if (provider === 'cohere') return translateFromCohere(providerJson, modelHint)
  if (provider === 'replicate') return translateFromReplicate(providerJson, modelHint)
  // OpenAI / Together / Fireworks already speak OpenAI on the wire.
  return providerJson
}

function cryptoLikeId(): string {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12)
}
