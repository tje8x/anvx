create or replace function workspace_routing_context(p_workspace_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'routing_mode', (select routing_mode from workspaces where id = p_workspace_id),
    'policies', coalesce(
      (select jsonb_agg(to_jsonb(bp) order by bp.created_at)
       from budget_policies bp
       where bp.workspace_id = p_workspace_id and bp.enabled = true), '[]'::jsonb), 'rules', coalesce(
      (select jsonb_agg(to_jsonb(mrr) order by mrr.created_at)
       from model_routing_rules mrr
       where mrr.workspace_id = p_workspace_id and mrr.enabled = true), '[]'::jsonb),
    'period_spend', jsonb_build_object(
      'day_cents', coalesce(
        (select sum(total_cost_cents)::int from routing_usage_records
         where workspace_id = p_workspace_id and created_at >= date_trunc('day', now())), 0),
      'month_cents', coalesce(
        (select sum(total_cost_cents)::int from routing_usage_records
         where workspace_id = p_workspace_id and created_at >= date_trunc('month', now())), 0),
      'hourly_baseline_cents', coalesce(
        (select (sum(total_cost_cents) / 24 / 7)::int from routing_usage_records
         where workspace_id = p_workspace_id and created_at >= now() - interval '7 days'), 0)
    ),
    'active_incidents', coalesce(
      (select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'scope_provider', i.scope_provider,
        'scope_project_tag', i.scope_project_tag,
        'trigger_kind', i.trigger_kind,
        'opened_at', i.opened_at
      ))
      from incidents i
      where i.workspace_id = p_workspace_id and i.status = 'active'), '[]'::jsonb)
  );
$$;