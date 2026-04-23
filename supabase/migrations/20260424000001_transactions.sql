create table transactions (
	id uuid default gen_random_uuid() primary key,
	workspace_id uuid references workspaces(id) on delete cascade not null,
	provider text not null,
	provider_key_id uuid references provider_keys(id) on delete set null,
	direction text not null check (direction in ('in', 'out')),
	counterparty text,
	amount_cents bigint not null,
	currency text not null default 'usd',
	ts timestamptz not null,
	category_hint text,
	source text not null default 'connector' check (source in ('connector', 'document')),
	match_group_id uuid,
	raw jsonb,
	synced_at timestamptz default now() not null,
	unique(workspace_id, provider, ts, amount_cents, counterparty)
);

alter table transactions enable row level security;

create policy "transactions_select" on transactions
	for select using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "transactions_no_user_write" on transactions
	for all using (false) with check (false);

create index transactions_workspace_ts on transactions(workspace_id, ts desc);
create index transactions_unmatched on transactions(workspace_id, match_group_id)
	where match_group_id is null;
