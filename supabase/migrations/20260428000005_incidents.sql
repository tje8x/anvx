create table incidents (
  id uuid default gen_random_uuid() primary key,
  workspace_id uuid references workspaces(id) on delete cascade not null,
  scope_provider text,
  scope_project_tag text,
  trigger_kind text not null check (trigger_kind in ('circuit_breaker_fired', 'anomaly_critical', 'manual')),
  trigger_details jsonb not null,
  status text not null check (status in ('active', 'resolved')) default 'active',
  opened_at timestamptz default now() not null,
  resumed_at timestamptz,
  resumed_by_user_id uuid references users(id)
);

create index incidents_workspace_active on incidents(workspace_id) where status = 'active';

-- One active incident per (workspace, scope) — prevents duplicates

create unique index incidents_one_active_per_scope on incidents
  (workspace_id, coalesce(scope_provider, ''), coalesce(scope_project_tag, ''))
  where status = 'active';

alter table incidents enable row level security;
create policy "incidents_select_own" on incidents for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "incidents_update_own" on incidents for update using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "incidents_no_insert" on incidents for insert with check (false);