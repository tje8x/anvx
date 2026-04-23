create table shadow_recommendations (
	id uuid default gen_random_uuid() primary key,
	workspace_id uuid references workspaces(id) on delete cascade not null,
	kind text not null check (kind in ('routing_opportunity', 'budget_protection')),
	payload jsonb not null,
	estimated_value_cents int not null default 0,
	surfaced_at timestamptz default now() not null,
	user_response text check (user_response in ('accepted','dismissed','expired')),
	responded_at timestamptz,
	responded_by_user_id uuid references users(id)
);

create index sr_workspace_unresponded on shadow_recommendations(workspace_id) where user_response is null;

alter table shadow_recommendations enable row level security;

create policy "sr_select_own" on shadow_recommendations
	for select using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "sr_update_own" on shadow_recommendations
	for update using (workspace_id::text = auth.jwt()->>'workspace_id');