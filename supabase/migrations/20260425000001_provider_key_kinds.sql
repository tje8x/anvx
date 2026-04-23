-- Some connectors don't have an API key — they have a manifest or a CSV source.
alter table provider_keys
	add column if not exists kind text not null default 'api_key'
		check (kind in ('api_key', 'manifest', 'csv_source'));

-- For manifest kind: envelope contains the manifest JSON directly (still encrypted).

-- For csv_source kind: envelope contains a minimal marker; actual CSV content goes into a new provider_csv_uploads table.

create table provider_csv_uploads (
	id uuid default gen_random_uuid() primary key,
	workspace_id uuid references workspaces(id) on delete cascade not null,
	provider_key_id uuid references provider_keys(id) on delete cascade not null,
	filename text not null,
	content_hash text not null,
	uploaded_by uuid references users(id) not null,
	uploaded_at timestamptz default now() not null
);

alter table provider_csv_uploads enable row level security;

create policy "provider_csv_uploads_select" on provider_csv_uploads
	for select using (workspace_id::text = auth.jwt()->>'workspace_id');

create policy "provider_csv_uploads_no_user_write" on provider_csv_uploads
	for all using (false) with check (false);