create table chart_of_accounts (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    code text not null,
    name text not null,
    kind text not null check (kind in ('revenue', 'cogs', 'opex', 'other')),
    created_at timestamptz default now() not null,
    unique (workspace_id, code)
);

create table reconciliation_categorizations (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    document_transaction_id uuid references document_transactions(id) on delete
    cascade not null unique,
    category_id uuid references chart_of_accounts(id) not null,
    notes text,
    resolved_by_user_id uuid references users(id) not null,
    created_at timestamptz default now() not null
);

create table reconciliation_flags (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    document_transaction_id uuid references document_transactions(id) on delete
    cascade not null unique,
    reason text not null,
    flagged_by_user_id uuid references users(id) not null,
    created_at timestamptz default now() not null,
    resolved_at timestamptz,
    resolved_notes text
);

alter table chart_of_accounts enable row level security;
alter table reconciliation_categorizations enable row level security;
alter table reconciliation_flags enable row level security;
create policy "coa_select_own" on chart_of_accounts for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "coa_no_write" on chart_of_accounts for all using (false) with check (false);
create policy "rcat_select_own" on reconciliation_categorizations for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "rcat_no_write" on reconciliation_categorizations for all using (false) with check (false);
create policy "rflag_select_own" on reconciliation_flags for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "rflag_no_write" on reconciliation_flags for all using (false) with check (false);