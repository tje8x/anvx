import posthog from 'posthog-js'

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    capture_pageview: true,
    loaded: (p) => {
      if (process.env.NODE_ENV === 'development') p.opt_in_capturing()
    },
  })
}

export { posthog }

export type AnalyticsEvent =
  | { name: 'onboarding_step_completed'; props: { step: number; elapsed_seconds: number } }
  | { name: 'onboarding_step_skipped'; props: { step: number } }
  | { name: 'connector_connected'; props: { provider: string } }
  | { name: 'insight_viewed'; props: { insight_type: string } }
  | { name: 'policy_created'; props: { action: string; scope_kind: string } }
  | { name: 'routing_mode_changed'; props: { from: string; to: string } }
  | { name: 'routing_rule_created'; props: { models_count: number } }
  | { name: 'observer_recommendation_response'; props: { kind: string; response: string } }
  | { name: 'reconciliation_action'; props: { kind: 'confirm' | 'categorize' | 'flag' } }
  | { name: 'treasury_insights_shown'; props: { count: number } }
  | { name: 'treasury_insight_interest_click'; props: { insight_type: string; insight_id: string; projected_runway_impact: number } }
  | { name: 'treasury_insight_dismissed'; props: { insight_type: string; insight_id: string } }

export function capture<E extends AnalyticsEvent>(event: E['name'], props: E['props']): void {
  if (typeof window === 'undefined') return
  posthog.capture(event, props)
}
