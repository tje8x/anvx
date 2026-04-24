CREATE OR REPLACE FUNCTION workspace_routing_context(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'routing_mode', (
      SELECT routing_mode FROM workspaces WHERE id = p_workspace_id
    ),
    'policies', COALESCE(
      (SELECT jsonb_agg(to_jsonb(bp) ORDER BY bp.created_at)
       FROM budget_policies bp
       WHERE bp.workspace_id = p_workspace_id AND bp.enabled = true),
      '[]'::jsonb
    ),
    'rules', COALESCE(
      (SELECT jsonb_agg(to_jsonb(mrr) ORDER BY mrr.created_at)
       FROM model_routing_rules mrr
       WHERE mrr.workspace_id = p_workspace_id AND mrr.enabled = true),
      '[]'::jsonb
    ),
    'period_spend', jsonb_build_object(
      'day_cents', COALESCE(
        (SELECT sum(total_cost_cents)::int FROM routing_usage_records
         WHERE workspace_id = p_workspace_id
         AND created_at >= date_trunc('day', now())), 0),
      'month_cents', COALESCE(
        (SELECT sum(total_cost_cents)::int FROM routing_usage_records
         WHERE workspace_id = p_workspace_id
         AND created_at >= date_trunc('month', now())), 0),
      'hourly_baseline_cents', COALESCE(
        (SELECT (sum(total_cost_cents) / 24 / 7)::int FROM routing_usage_records
         WHERE workspace_id = p_workspace_id
         AND created_at >= now() - interval '7 days'), 0)
    )
  );
$$;