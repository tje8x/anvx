import { createClient } from '@supabase/supabase-js'
import type { Decision } from './decide'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export function recordUsage(workspaceId: string, tokenId: string, decision: Decision, durationMs: number): void {
  // Fire-and-forget — do not block the response
  supabase
    .from('routing_usage_records')
    .insert({
      workspace_id: workspaceId,
      token_id: tokenId,
      requested_model: decision.requestedModel,
      routed_model: decision.requestedModel, // shadow mode: always same
      shadow_suggestion: decision.suggestedModel,
      shadow_reason: decision.reason,
      action: decision.action,
      duration_ms: durationMs,
    })
    .then(() => {})
}
