import { createClient, SupabaseClient } from '@supabase/supabase-js'
import pino from 'pino'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

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

  const row: PriceRow = {
    input: data?.input_price_per_mtok_cents ?? 0,
    output: data?.output_price_per_mtok_cents ?? 0,
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
  shadow_suggestion?: unknown
  policy_triggered?: string | null
  reasoning?: string
  upstream_latency_ms: number
  total_latency_ms: number
  project_tag?: string | null
  user_hint?: string | null
}

export async function writeUsage(input: MeterInput): Promise<void> {
  const price = await priceFor(input.provider, input.model_routed)
  const provider_cost_cents = Math.round(
    (input.tokens_in * price.input + input.tokens_out * price.output) / 1_000_000
  )
  const markup_bps = parseInt(process.env.ROUTING_MARKUP_BPS ?? '0', 10)
  const markup_cents = Math.floor((provider_cost_cents * markup_bps) / 10_000)

  const row = { ...input, provider_cost_cents, markup_cents }
  try {
    const { error } = await sb().from('routing_usage_records').insert(row)
    if (error) throw error
  } catch {
    try {
      const { error } = await sb().from('routing_usage_records').insert(row)
      if (error) throw error
    } catch (err2) {
      log.error({ request_id: input.request_id, err: String(err2) }, 'meter.write.failed')
    }
  }
}
