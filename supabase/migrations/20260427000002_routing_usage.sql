create table routing_usage_records (
	id uuid default gen_random_uuid() primary key,
	workspace_id uuid references workspaces(id) on delete cascade not null,
	token_id uuid references anvx_api_tokens(id) not null,
	created_at timestamptz default now() not null,
	
	request_id text not null,
	model_requested text not null,
	model_routed text not null,
	provider text not null,
	
	tokens_in int,
	tokens_out int,
	provider_cost_cents int,
	markup_cents int default 0,
	total_cost_cents int generated always as (coalesce(provider_cost_cents,0) + coalesce(markup_cents,0)) stored,
	decision text not null check (decision in ('passthrough','rerouted','blocked','downgraded','failed_open','failed_closed')),
	shadow_suggestion jsonb,
	policy_triggered uuid,
	reasoning text,
	
	upstream_latency_ms int,
	total_latency_ms int,
	
	project_tag text,
	user_hint text
);

create index rur_workspace_created on routing_usage_records(workspace_id, created_at desc);
create index rur_decision on routing_usage_records(decision);

alter table routing_usage_records enable row level security;

create policy "rur_select_own_workspace" on routing_usage_records
	for select using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "rur_no_user_write" on routing_usage_records
	for all using (false) with check (false);