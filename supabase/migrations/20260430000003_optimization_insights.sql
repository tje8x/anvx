create table if not exists optimization_insights (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    type text not null check (type in ('model_tier', 'seat_utilization', 'provider_comparison', 'routing_gap', 'cost_trajectory')),
    title text not null,
    impact text not null,
    impact_cents integer not null,
    description text not null,
    provider text,
    action_type text not null,
    action_label text,
    action_payload jsonb,
    dismissed_at timestamptz,
    added_to_pack_at timestamptz,
    generated_at timestamptz default now(),
    expires_at timestamptz default now() + interval '30 days'
);

alter table optimization_insights enable row level security;

drop policy if exists "workspace isolation" on optimization_insights;
create policy "workspace isolation" on optimization_insights
    using (workspace_id = current_setting('app.workspace_id')::uuid);

create index if not exists idx_optimization_insights_workspace
    on optimization_insights(workspace_id, generated_at desc)
    where dismissed_at is null;
