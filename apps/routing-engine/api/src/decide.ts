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

export type RoutingContext = {
  routing_mode: 'observer' | 'copilot' | 'autopilot'
  policies: any[]
  rules: any[]
  period_spend: { day_cents: number; month_cents: number; hourly_baseline_cents: number }
  active_incidents: any[]
}

export type DecisionResult = {
  decision: 'passthrough' | 'rerouted' | 'blocked' | 'downgraded' | 'failed_open' | 'failed_closed'
  model_routed: string
  provider_routed: string
  reasoning: string
  policy_triggered_id: string | null
  observer_suggestion: any | null
  blocked_http_status?: number
  blocked_body?: object
}

const ctxCache = new Map<string, { ctx: RoutingContext; expiresAt: number }>()

export async function loadContext(workspace_id: string): Promise<RoutingContext | null> {
  const hit = ctxCache.get(workspace_id)
  if (hit && Date.now() < hit.expiresAt) return hit.ctx
  const { data, error } = await sb().rpc('workspace_routing_context', { p_workspace_id: workspace_id })
  if (error || !data) return null
  const ctx = data as RoutingContext
  ctxCache.set(workspace_id, { ctx, expiresAt: Date.now() + 5000 })
  return ctx
}

function estimateRequestCents(
  tokens_in: number, max_tokens: number, model: string,
  prices: Record<string, { input: number; output: number }>
): number {
  const p = prices[model] ?? { input: 300, output: 1500 }
  return Math.ceil((tokens_in * p.input + max_tokens * p.output) / 1_000_000)
}

function scopeMatches(policy: any, provider: string, project_tag?: string, user_hint?: string): boolean {
  if (policy.scope_provider && policy.scope_provider !== provider) return false
  if (policy.scope_project_tag && policy.scope_project_tag !== project_tag) return false
  if (policy.scope_user_hint && policy.scope_user_hint !== user_hint) return false
  return true
}

function incidentMatches(inc: any, provider: string, project_tag?: string): boolean {
  if (inc.scope_provider && inc.scope_provider !== provider) return false
  if (inc.scope_project_tag && inc.scope_project_tag !== project_tag) return false
  return true
}

function secondsUntilReset(policy: any): number {
  if (policy.daily_limit_cents) {
    const now = new Date()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    return Math.round((midnight.getTime() - now.getTime()) / 1000)
  }
  return 3600
}

function applyAction(
  ctx: RoutingContext, policy: any,
  info: { reason: string; provider: string; model: string }
): DecisionResult {
  const base = {
    policy_triggered_id: policy.id,
    reasoning: `Policy '${policy.name}' triggered: ${info.reason}. Action=${policy.action}.`,
    observer_suggestion: null,
  }
  if (policy.action === 'alert_only') {
    return { ...base, decision: 'passthrough', model_routed: info.model, provider_routed: info.provider }
  }
  if (policy.action === 'pause') {
    return {
      ...base, decision: 'blocked', model_routed: info.model, provider_routed: info.provider,
      blocked_http_status: 429,
      blocked_body: {
        error: 'policy_exceeded',
        message: base.reasoning,
        policy_id: policy.id,
        retry_after_seconds: secondsUntilReset(policy),
      },
    }
  }
  if (policy.action === 'downgrade') {
    const rule = ctx.rules.find(r =>
      (r.approved_models?.length ?? 0) >= 2 &&
      r.approved_models.some((m: string) => m.endsWith('/' + info.model))
    )
    if (!rule) {
      return { ...base, decision: 'passthrough', model_routed: info.model, provider_routed: info.provider,
        reasoning: base.reasoning + ' No matching multi-model rule — fell back to passthrough.' }
    }
    const cheapest = rule.approved_models.find((m: string) => !m.endsWith('/' + info.model)) ?? info.model
    const [np, nm] = cheapest.includes('/') ? cheapest.split('/', 2) : [info.provider, cheapest]
    return {
      ...base, decision: 'downgraded', model_routed: nm, provider_routed: np,
      reasoning: base.reasoning + ` Downgraded ${info.model} → ${nm} via rule '${rule.name}'.`,
    }
  }
  return { ...base, decision: 'passthrough', model_routed: info.model, provider_routed: info.provider }
}

export async function decide(
  ctx: RoutingContext,
  req: { workspace_id: string; model_requested: string; tokens_in_estimate: number; max_tokens: number; project_tag?: string; user_hint?: string },
  prices: Record<string, { input: number; output: number }>
): Promise<DecisionResult> {
  const parts = req.model_requested.includes('/') ? req.model_requested.split('/', 2) : ['openai', req.model_requested]
  const provider = parts[0]
  const model = parts[1] ?? req.model_requested

  // Pre-policy: check for active incidents
  for (const inc of (ctx as any).active_incidents ?? []) {
    if (incidentMatches(inc, provider, req.project_tag)) {
      return {
        decision: 'blocked', model_routed: model, provider_routed: provider,
        policy_triggered_id: null, observer_suggestion: null,
        reasoning: `Incident ${inc.id} active (${inc.trigger_kind}) — routing paused.`,
        blocked_http_status: 503,
        blocked_body: {
          error: 'routing_paused',
          message: `Routing is paused due to ${inc.trigger_kind.replace(/_/g, ' ')}. Resume from the Routing tab.`,
          incident_id: inc.id,
        },
      }
    }
  }

  const defaultPass: DecisionResult = {
    decision: 'passthrough', model_routed: model, provider_routed: provider,
    reasoning: 'No matching policy; passthrough.',
    policy_triggered_id: null, observer_suggestion: null,
  }

  if (ctx.routing_mode === 'observer') {
    const applicable = ctx.policies.filter(p => scopeMatches(p, provider, req.project_tag, req.user_hint))
    return {
      ...defaultPass,
      observer_suggestion: { applicable_policy_ids: applicable.map(p => p.id), would_simulate: true },
      reasoning: 'Observer mode — passthrough with simulated suggestion.',
    }
  }

  const estCents = estimateRequestCents(req.tokens_in_estimate, req.max_tokens, model, prices)

  console.log("DECIDE_DEBUG", { routing_mode: ctx.routing_mode, num_policies: ctx.policies.length, policies: ctx.policies.map(p => ({ name: p.name, scope_provider: p.scope_provider, action: p.action })), provider, model, estCents })

  for (const p of ctx.policies) {
    if (!scopeMatches(p, provider, req.project_tag, req.user_hint)) continue
    if (p.per_request_limit_cents && estCents > p.per_request_limit_cents) {
      return applyAction(ctx, p, { reason: `per_request_limit ${p.per_request_limit_cents}c, est ${estCents}c`, provider, model })
    }
    if (p.daily_limit_cents && (ctx.period_spend.day_cents + estCents) > p.daily_limit_cents) {
      return applyAction(ctx, p, { reason: `daily_limit ${p.daily_limit_cents}c, current ${ctx.period_spend.day_cents}c + est ${estCents}c`, provider, model })
    }
    if (p.monthly_limit_cents && (ctx.period_spend.month_cents + estCents) > p.monthly_limit_cents) {
      return applyAction(ctx, p, { reason: `monthly_limit ${p.monthly_limit_cents}c, current ${ctx.period_spend.month_cents}c + est ${estCents}c`, provider, model })
    }
    if (p.circuit_breaker_multiplier) {
      const cap = ctx.period_spend.hourly_baseline_cents * Number(p.circuit_breaker_multiplier)
      if (ctx.period_spend.day_cents > cap) {
        return applyAction(ctx, p, { reason: `circuit_breaker ${p.circuit_breaker_multiplier}x of baseline ${ctx.period_spend.hourly_baseline_cents}c`, provider, model })
      }
    }
  }
  return defaultPass
}
