import { createClient } from '@supabase/supabase-js'

export async function openIncident(
  workspace_id: string,
  trigger_kind: 'circuit_breaker_fired' | 'anomaly_critical' | 'manual',
  trigger_details: Record<string, unknown>,
  scope_provider?: string | null,
  scope_project_tag?: string | null,
): Promise<{ id: string } | null> {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  try {
    const { data, error } = await sb.from('incidents').insert({
      workspace_id, scope_provider: scope_provider ?? null, scope_project_tag: scope_project_tag ?? null, trigger_kind, trigger_details,
    }).select('id').single()
    if (error) { if (String(error.message).includes('unique')) return null; throw error }
    return { id: data.id }
  } catch (err) { console.error({ workspace_id, err: String(err) }, 'incident.open.failed'); return null }
}
