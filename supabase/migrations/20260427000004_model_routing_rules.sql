create table model_routing_rules (
	id uuid default gen_random_uuid() primary key,
	workspace_id uuid references workspaces(id) on delete cascade not null,
	name text not null,
	description text,
	approved_models text[] not null,
	quality_priority int not null check (quality_priority between 0 and 100),
	cost_priority int not null check (cost_priority between 0 and 100),
	enabled boolean default true,
	created_by_user_id uuid references users(id) not null,
	created_at timestamptz default now() not null,
	updated_at timestamptz default now() not null,
	check (quality_priority + cost_priority = 100),
	check (array_length(approved_models, 1) >= 1),
	unique (workspace_id, name)
);

create index mrr_workspace_enabled on model_routing_rules(workspace_id) where enabled = true;

alter table model_routing_rules enable row level security;

create policy "mrr_select_own" on model_routing_rules
	for select using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "mrr_no_user_write" on model_routing_rules
	for all using (false) with check (false);