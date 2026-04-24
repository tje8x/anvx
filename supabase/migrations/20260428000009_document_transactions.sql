create table document_transactions (
  id uuid default gen_random_uuid() primary key,
  document_id uuid references documents(id) on delete cascade not null,
  workspace_id uuid references workspaces(id) on delete cascade not null,
  row_index int not null,
  txn_date date not null,
  description text not null,
  amount_cents bigint not null,
  currency text not null default 'USD',
  counterparty text,
  reference text,
  raw jsonb not null,
  unique (document_id, row_index)
);

create index dt_workspace_date on document_transactions(workspace_id, txn_date desc);

alter table document_transactions enable row level security;

create policy "dt_select_own" on document_transactions for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "dt_no_user_write" on document_transactions for all using (false) with check (false);