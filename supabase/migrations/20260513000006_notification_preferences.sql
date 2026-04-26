create table if not exists notification_preferences (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    event_type text not null,
    email_enabled boolean default false,
    slack_enabled boolean default false,
    created_at timestamptz default now(),
    unique(workspace_id, event_type)
);

alter table notification_preferences enable row level security;
create policy "np_select_own" on notification_preferences for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "np_no_user_write" on notification_preferences for all using (false) with check (false);
