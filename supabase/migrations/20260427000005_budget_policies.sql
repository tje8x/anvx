create table budget_policies (
	id uuid default gen_random_uuid() primary key,
	workspace_id uuid references workspaces(id) on delete cascade not null,
	name text not null,

	scope_provider text,
	scope_project_tag text,
	scope_user_hint text,
	
	daily_limit_cents int,
	monthly_limit_cents int,
	per_request_limit_cents int,
	circuit_breaker_multiplier numeric(4,2),
	runway_alert_months numeric(4,2),
	
	alert_at_pcts int[] default array[80, 90],
	
	action text not null check (action in ('alert_only', 'downgrade', 'pause')),
	fail_mode text not null check (fail_mode in ('open', 'closed')) default 'open',
	
	enabled boolean default true,
	created_by_user_id uuid references users(id) not null,
	created_at timestamptz default now() not null,
	updated_at timestamptz default now() not null,
	
	unique (workspace_id, name),
	check (
		coalesce(daily_limit_cents, monthly_limit_cents, per_request_limit_cents) is not null
		or circuit_breaker_multiplier is not null
		or runway_alert_months is not null
	)
);

create index bp_workspace_enabled on budget_policies(workspace_id) where enabled = true;

alter table budget_policies enable row level security;

create policy "bp_select_own" on budget_policies
	for select using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "bp_no_user_write" on budget_policies
	for all using (false) with check (false);