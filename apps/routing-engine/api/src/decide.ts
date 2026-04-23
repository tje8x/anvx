import type { RoutingContext } from './context'

export type Decision = {
  action: 'passthrough'
  requestedModel: string
  suggestedModel: string | null
  reason: string | null
}

export function decide(ctx: RoutingContext, requestedModel: string): Decision {
  // Shadow mode (default): always passthrough, populate suggestion for logging
  let suggestedModel: string | null = null
  let reason: string | null = null

  // Simple heuristic: if using a frontier model, suggest the mini variant
  const downgradeCandidates: Record<string, string> = {
    'gpt-4o': 'gpt-4o-mini',
    'gpt-4.1': 'gpt-4.1-mini',
    'claude-sonnet-4': 'claude-haiku-4',
    'claude-3.5-sonnet': 'claude-3.5-haiku',
  }

  if (requestedModel in downgradeCandidates) {
    suggestedModel = downgradeCandidates[requestedModel]
    reason = `Shadow suggestion: ${requestedModel} could be routed to ${suggestedModel} for simpler tasks`
  }

  return { action: 'passthrough', requestedModel, suggestedModel, reason }
}
