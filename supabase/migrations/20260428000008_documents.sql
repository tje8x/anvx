create table documents (
  id uuid default gen_random_uuid() primary key,
  workspace_id uuid references workspaces(id) on delete cascade not null,
  storage_path text not null,
  file_name text not null,
  file_kind text not null check (file_kind in ('bank_csv','bank_pdf','cc_csv','cc_pdf','invoice_pdf','other')),
  file_size_bytes bigint not null,
  content_hash text not null,
  parsed_rows_count int,
  status text not null check (status in ('uploaded','parsing','parsed','error','removed')),
  error_message text,
  uploaded_by_user_id uuid references users(id) not null,
  created_at timestamptz default now() not null,
  removed_at timestamptz
);

create unique index documents_workspace_hash_active on documents(workspace_id, content_hash)
where removed_at is null;

create index documents_workspace_status on documents(workspace_id, status);

alter table documents enable row level security;
create policy "documents_select_own" on documents for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "documents_no_user_write" on documents for all using (false) with check (false);