-- Append-only audit log for sensitive actions.
create table audit_log (
  id uuid default gen_random_uuid() primary key,
  workspace_id uuid references workspaces(id) on delete cascade not null,
  actor_user_id uuid references users(id),
  action text not null,
  target_kind text,
  target_id text,
  ip inet,
  user_agent text,
  details jsonb default '{}'::jsonb,
  created_at timestamptz default now() not null
);

create index audit_log_workspace_created on audit_log(workspace_id, created_at desc);
create index audit_log_action on audit_log(action);

alter table audit_log enable row level security;

create policy "audit_log_select_own_workspace" on audit_log
  for select using (
    workspace_id::text = auth.jwt()->>'workspace_id'
    and (auth.jwt()->>'workspace_role') in ('owner','admin')
  );

create policy "audit_log_no_user_insert" on audit_log for insert with check (false);

create or replace function audit_log_immutable() returns trigger as $$
begin raise exception 'audit_log is append-only'; end; $$ language plpgsql;

create trigger audit_log_no_update before update on audit_log
  for each row execute function audit_log_immutable();

create trigger audit_log_no_delete before delete on audit_log
  for each row execute function audit_log_immutable();
