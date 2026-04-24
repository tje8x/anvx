create table anomalies (
  id uuid default gen_random_uuid() primary key,
  workspace_id uuid references workspaces(id) on delete cascade not null,
  kind text not null check (kind in ('recursive_loop', 'pricing_change', 'leaked_key', 'budget_trajectory')),
  severity text not null check (severity in ('info', 'warn', 'critical')),
  payload jsonb not null,
  detected_at timestamptz default now() not null,
  acknowledged_at timestamptz,
  acknowledged_by_user_id uuid references users(id)
);

create index anomalies_recent on anomalies(workspace_id, kind, detected_at desc);

alter table anomalies enable row level security;
create policy "anomalies_select_own" on anomalies for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "anomalies_update_own" on anomalies for update using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "anomalies_no_insert" on anomalies for insert with check (false);