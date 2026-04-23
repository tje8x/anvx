create table anvx_api_tokens (
	id uuid default gen_random_uuid() primary key,
	workspace_id uuid references workspaces(id) on delete cascade not null,
	token_hash text not null unique, 			-- sha256(hex) of the plaintext token
	token_prefix text not null, 				-- 'anvx_live_' + first 8 chars after prefix, for display
	label text,
	created_by_user_id uuid references users(id) not null,
	created_at timestamptz default now() not null,
	last_used_at timestamptz,
	revoked_at timestamptz
);

create index anvx_api_tokens_workspace on anvx_api_tokens(workspace_id) where revoked_at is null;
create index anvx_api_tokens_hash_active on anvx_api_tokens(token_hash) where revoked_at is null;

alter table anvx_api_tokens enable row level security;

create policy "anvx_api_tokens_select_own_workspace" on anvx_api_tokens
	for select using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "anvx_api_tokens_no_user_write" on anvx_api_tokens
	for all using (false) with check (false);