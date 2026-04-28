import { describe, it, expect } from 'vitest'
import { decide, type RoutingContext } from '../api/src/decide'

function makeCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    routing_mode: 'copilot',
    policies: [],
    rules: [],
    period_spend: { day_cents: 0, month_cents: 0, hourly_baseline_cents: 100 },
    ...overrides,
  }
}

const baseReq = {
  workspace_id: 'ws-1',
  model_requested: 'gpt-4o',
  tokens_in_estimate: 500,
  max_tokens: 1024,
  project_tag: undefined,
  user_hint: undefined,
}

const pausePolicy = {
  id: 'pol-1', name: 'Daily cap', action: 'pause',
  scope_provider: null, scope_project_tag: null, scope_user_hint: null,
  daily_limit_cents: 1000, monthly_limit_cents: null,
  per_request_limit_cents: null, circuit_breaker_multiplier: null,
}

const alertPolicy = {
  id: 'pol-2', name: 'Alert cap', action: 'alert_only',
  scope_provider: null, scope_project_tag: null, scope_user_hint: null,
  daily_limit_cents: 500, monthly_limit_cents: null,
  per_request_limit_cents: null, circuit_breaker_multiplier: null,
}

const perReqPausePolicy = {
  id: 'pol-3', name: 'Per-req cap', action: 'pause',
  scope_provider: null, scope_project_tag: null, scope_user_hint: null,
  daily_limit_cents: null, monthly_limit_cents: null,
  per_request_limit_cents: 1, circuit_breaker_multiplier: null,
}

const downgradePolicy = {
  id: 'pol-4', name: 'Downgrade cap', action: 'downgrade',
  scope_provider: null, scope_project_tag: null, scope_user_hint: null,
  daily_limit_cents: 500, monthly_limit_cents: null,
  per_request_limit_cents: null, circuit_breaker_multiplier: null,
}

const multiModelRule = {
  id: 'rule-1', name: 'Code gen',
  approved_models: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
  quality_priority: 80, cost_priority: 20, enabled: true,
}

const scopedPolicy = {
  id: 'pol-5', name: 'Anthropic only', action: 'pause',
  scope_provider: 'anthropic', scope_project_tag: null, scope_user_hint: null,
  daily_limit_cents: 100, monthly_limit_cents: null,
  per_request_limit_cents: null, circuit_breaker_multiplier: null,
}

describe('decide()', () => {
  it('observer mode always returns passthrough with observer_suggestion', async () => {
    const ctx = makeCtx({ routing_mode: 'observer', policies: [pausePolicy], period_spend: { day_cents: 9999, month_cents: 9999, hourly_baseline_cents: 100 } })
    const dec = await decide(ctx, baseReq, {})
    expect(dec.decision).toBe('passthrough')
    expect(dec.observer_suggestion).not.toBeNull()
    expect(dec.observer_suggestion.applicable_policy_ids).toContain('pol-1')
  })

  it('copilot + per_request_limit exceeded + pause → blocked 429', async () => {
    const ctx = makeCtx({ policies: [perReqPausePolicy] })
    const dec = await decide(ctx, baseReq, {})
    expect(dec.decision).toBe('blocked')
    expect(dec.blocked_http_status).toBe(429)
    expect(dec.policy_triggered_id).toBe('pol-3')
    expect((dec.blocked_body as any)?.error).toBe('policy_exceeded')
  })

  it('copilot + daily_limit exceeded + alert_only → passthrough with policy_triggered_id', async () => {
    const ctx = makeCtx({ policies: [alertPolicy], period_spend: { day_cents: 600, month_cents: 0, hourly_baseline_cents: 100 } })
    const dec = await decide(ctx, baseReq, {})
    expect(dec.decision).toBe('passthrough')
    expect(dec.policy_triggered_id).toBe('pol-2')
    expect(dec.reasoning).toContain('alert_only')
  })

  it('copilot + daily_limit exceeded + downgrade + matching rule → downgraded', async () => {
    const ctx = makeCtx({ policies: [downgradePolicy], rules: [multiModelRule], period_spend: { day_cents: 600, month_cents: 0, hourly_baseline_cents: 100 } })
    const dec = await decide(ctx, baseReq, {})
    expect(dec.decision).toBe('downgraded')
    expect(dec.model_routed).toBe('gpt-4o-mini')
    expect(dec.model_routed).not.toBe('gpt-4o')
    expect(dec.policy_triggered_id).toBe('pol-4')
    expect(dec.reasoning).toContain('Downgraded')
  })

  it('copilot + daily_limit exceeded + downgrade + NO matching rule → passthrough fallback', async () => {
    const ctx = makeCtx({ policies: [downgradePolicy], rules: [], period_spend: { day_cents: 600, month_cents: 0, hourly_baseline_cents: 100 } })
    const dec = await decide(ctx, baseReq, {})
    expect(dec.decision).toBe('passthrough')
    expect(dec.policy_triggered_id).toBe('pol-4')
    expect(dec.reasoning).toContain('No matching multi-model rule')
    expect(dec.reasoning).toContain('passthrough')
  })

  it('policy with scope_provider mismatch is skipped', async () => {
    const ctx = makeCtx({ policies: [scopedPolicy], period_spend: { day_cents: 9999, month_cents: 9999, hourly_baseline_cents: 100 } })
    // Request is for openai/gpt-4o, but policy scopes to anthropic
    const dec = await decide(ctx, baseReq, {})
    expect(dec.decision).toBe('passthrough')
    expect(dec.policy_triggered_id).toBeNull()
    expect(dec.reasoning).toContain('No matching policy')
  })

  it('autopilot behaves identically to copilot for enforcement', async () => {
    const ctx = makeCtx({ routing_mode: 'autopilot', policies: [perReqPausePolicy] })
    const dec = await decide(ctx, baseReq, {})
    expect(dec.decision).toBe('blocked')
    expect(dec.blocked_http_status).toBe(429)
    expect(dec.policy_triggered_id).toBe('pol-3')
  })
})
