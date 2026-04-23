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
const CONTEXT_TIMEOUT_MS = 5_000

function defaultContext(workspaceId: string): RoutingContext {
  return {
    workspaceId,
    dailySpendCents: 0,
    monthlySpendCents: 0,
    hourlyBaselineCents: 0,
    modelRoutingRules: [],
    budgetPolicies: [],
  }
}

export async function loadRoutingContext(workspaceId: string): Promise<RoutingContext> {
  const now = Date.now()
  if (cache && cache.key === workspaceId && now - cache.ts < CACHE_TTL_MS) {
    return cache.data
  }

  // F: 5-second timeout on RPC call — fall back to empty context instead of hanging
  const rpcPromise = supabase.rpc('get_workspace_routing_context', { ws_id: workspaceId }).single() as unknown as Promise<{ data: any }>

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Context RPC timed out')), CONTEXT_TIMEOUT_MS)
  )

  let usage: any
  try {
    const result = await Promise.race([rpcPromise, timeoutPromise])
    usage = result.data
  } catch (err: any) {
    console.error("CTX_TIMEOUT", { workspaceId, error: err?.message })
    const fallback = defaultContext(workspaceId)
    cache = { key: workspaceId, data: fallback, ts: now }
    return fallback
  }

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
