create table provider_keys (
  id uuid default gen_random_uuid() primary key,
  workspace_id uuid references workspaces(id) on delete cascade not null,
  provider text not null,
  label text not null,
  envelope jsonb not null,
  last_used_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz default now() not null,
  created_by uuid references users(id) not null,
  unique(workspace_id, provider, label)
);

alter table provider_keys enable row level security;

create policy "provider_keys_select" on provider_keys
  for select using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "provider_keys_insert" on provider_keys
  for insert with check (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "provider_keys_update" on provider_keys
  for update using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "provider_keys_delete" on provider_keys
  for delete using (workspace_id::text = auth.jwt()->>'workspace_id');

create index provider_keys_workspace on provider_keys(workspace_id) where deleted_at is null;