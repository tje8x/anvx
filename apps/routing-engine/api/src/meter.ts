import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (!_sb) {
    _sb = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )
  }
  return _sb
}

type PriceRow = { input: number; output: number; cachedAt: number }
const priceCache = new Map<string, PriceRow>()
const PRICE_CACHE_MS = 5 * 60 * 1000

async function priceFor(provider: string, model: string): Promise<{ input: number; output: number }> {
  const key = `${provider}/${model}`
  const hit = priceCache.get(key)
  if (hit && Date.now() - hit.cachedAt < PRICE_CACHE_MS) return { input: hit.input, output: hit.output }

  const { data } = await sb()
    .from('models')
    .select('input_price_per_mtok_cents, output_price_per_mtok_cents')
    .eq('provider', provider).eq('model', model).maybeSingle()

  const FALLBACK: Record<string, { input: number; output: number }> = {
    'gpt-4o': { input: 250, output: 1000 },
    'gpt-4o-mini': { input: 15, output: 60 },
    'gpt-4o-mini-2024-07-18': { input: 15, output: 60 },
    'gpt-4.1': { input: 200, output: 800 },
    'gpt-4.1-mini': { input: 40, output: 160 },
    'gpt-4.1-nano': { input: 10, output: 40 },
  }
  const fb = FALLBACK[model] ?? { input: 300, output: 1500 }
  const row: PriceRow = {
    input: data?.input_price_per_mtok_cents || fb.input,
    output: data?.output_price_per_mtok_cents || fb.output,
    cachedAt: Date.now(),
  }
  priceCache.set(key, row)
  return { input: row.input, output: row.output }
}

export type MeterInput = {
  request_id: string
  workspace_id: string
  token_id: string
  model_requested: string
  model_routed: string
  provider: string
  tokens_in: number
  tokens_out: number
  decision: 'passthrough'|'rerouted'|'blocked'|'downgraded'|'failed_open'|'failed_closed'
  observer_suggestion?: unknown
  policy_triggered?: string | null
  reasoning?: string
  upstream_latency_ms: number
  total_latency_ms: number
  project_tag?: string | null
  user_hint?: string | null
}

export async function writeUsage(input: MeterInput): Promise<void> {
  const price = await priceFor(input.provider, input.model_routed)
  const rawCost = (input.tokens_in * price.input + input.tokens_out * price.output) / 1_000_000
  const provider_cost_cents = (input.tokens_in > 0 || input.tokens_out > 0) ? Math.max(1, Math.ceil(rawCost)) : 0
  const markup_bps = parseInt(process.env.ROUTING_MARKUP_BPS ?? '0', 10)
  const markup_cents = Math.floor((provider_cost_cents * markup_bps) / 10_000)

  // Build row matching exact routing_usage_records schema
  // total_cost_cents is GENERATED ALWAYS — do NOT include it
  const row = {
    request_id: input.request_id,
    workspace_id: input.workspace_id,
    token_id: input.token_id,
    model_requested: input.model_requested,
    model_routed: input.model_routed,
    provider: input.provider,
    tokens_in: input.tokens_in,
    tokens_out: input.tokens_out,
    provider_cost_cents,
    markup_cents,
    decision: input.decision,
    observer_suggestion: input.observer_suggestion ?? null,
    policy_triggered: input.policy_triggered ?? null,
    reasoning: input.reasoning ?? null,
    upstream_latency_ms: input.upstream_latency_ms,
    total_latency_ms: input.total_latency_ms,
    project_tag: input.project_tag ?? null,
    user_hint: input.user_hint ?? null,
  }

  try {
    const { error } = await sb().from('routing_usage_records').insert(row)
    if (error) throw error
  } catch (err) {
    console.error("meter.write.failed", JSON.stringify(err))
    console.error("meter.write.row", JSON.stringify({ ...row, observer_suggestion: '[redacted]' }))
  }
}
