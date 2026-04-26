create table if not exists workspace_invitations (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    email text not null,
    role text not null check (role in ('admin', 'member', 'viewer', 'accountant_viewer')),
    invited_by uuid references users(id) not null,
    status text default 'pending' check (status in ('pending', 'accepted', 'expired')),
    created_at timestamptz default now(),
    expires_at timestamptz default now() + interval '7 days'
);

create index if not exists workspace_invitations_workspace
  on workspace_invitations(workspace_id, status);

alter table workspace_invitations enable row level security;
create policy "wi_select_own" on workspace_invitations for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "wi_no_user_write" on workspace_invitations for all using (false) with check (false);
