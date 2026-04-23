import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type RoutingContext = {
  workspaceId: string
  dailySpendCents: number
  monthlySpendCents: number
  hourlyBaselineCents: number
  modelRoutingRules: Record<string, unknown>[]
  budgetPolicies: Record<string, unknown>[]
}

// Per-instance cache with 30s TTL
let cache: { key: string; data: RoutingContext; ts: number } | null = null
const CACHE_TTL_MS = 30_000

export async function loadRoutingContext(workspaceId: string): Promise<RoutingContext> {
  const now = Date.now()
  if (cache && cache.key === workspaceId && now - cache.ts < CACHE_TTL_MS) {
    return cache.data
  }

  const { data: usage } = await supabase.rpc('get_workspace_routing_context', { ws_id: workspaceId }).single() as { data: any }

  const ctx: RoutingContext = {
    workspaceId,
    dailySpendCents: usage?.daily_spend_cents ?? 0,
    monthlySpendCents: usage?.monthly_spend_cents ?? 0,
    hourlyBaselineCents: usage?.hourly_baseline_cents ?? 0,
    modelRoutingRules: usage?.model_routing_rules ?? [],
    budgetPolicies: usage?.budget_policies ?? [],
  }

  cache = { key: workspaceId, data: ctx, ts: now }
  return ctx
}

export function clearContextCache() {
  cache = null
}
