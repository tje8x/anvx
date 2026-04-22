create table usage_records (
  id uuid default gen_random_uuid() primary key,
  workspace_id uuid references workspaces(id) on delete cascade not null,
  provider text not null,
  provider_key_id uuid references provider_keys(id) on delete set null,
  model text,
  input_tokens bigint,
  output_tokens bigint,
  total_cost_cents_usd bigint not null,
  currency text not null default 'usd',
  ts timestamptz not null,
  raw jsonb,
  synced_at timestamptz default now() not null,
  unique(workspace_id, provider, ts, model)
);

alter table usage_records enable row level security;

create policy "usage_records_select" on usage_records
  for select using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "usage_records_no_user_write" on usage_records
  for all using (false) with check (false);

create index usage_records_workspace_ts on usage_records(workspace_id, ts desc);