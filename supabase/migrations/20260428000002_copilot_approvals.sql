create table copilot_approvals (
	id uuid default gen_random_uuid() primary key,
	workspace_id uuid references workspaces(id) on delete cascade not null,
	kind text not null check (kind in ('pause_requested', 'threshold_crossed', 'circuit_breaker_fired')),
	policy_id uuid references budget_policies(id) on delete set null,
	context jsonb not null,
	created_at timestamptz default now() not null,
	user_response text check (user_response in ('approved', 'overridden', 'expired')),
	override_reason text,
	responded_by_user_id uuid references users(id),
	responded_at timestamptz
);

create index ca_unresponded on copilot_approvals(workspace_id) where user_response is null;

alter table copilot_approvals enable row level security;
create policy "ca_select_own" on copilot_approvals for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "ca_update_own" on copilot_approvals for update using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "ca_no_insert" on copilot_approvals for insert with check (false);