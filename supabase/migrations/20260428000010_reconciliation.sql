create table vendor_aliases (
    provider text not null,
    alias text not null,
    primary key (provider, alias)
);

insert into vendor_aliases (provider, alias) values
    ('openai', 'OPENAI'),
    ('openai', 'OPEN AI'),
    ('anthropic', 'ANTHROPIC'),
    ('anthropic', 'ANTHROPIC PBC'),
    ('google_cloud', 'GOOGLE*GSUITE'),
    ('google_cloud', 'GOOGLE CLOUD'),
    ('google_cloud', 'GOOGLE*GEMINI'),
    ('aws', 'AMAZON WEB SERVICES'),
    ('aws', 'AWS AMAZON'),
    ('aws', 'AWS'),
    ('vercel', 'VERCEL INC'),
    ('vercel', 'VERCEL'),
    ('stripe', 'STRIPE'),
    ('stripe', 'STRIPE*'),
    ('notion', 'NOTION LABS'),
    ('linear', 'LINEAR.APP'),
    ('github', 'GITHUB'),
    ('sentry', 'FUNCTIONAL SOFTWARE'),
    ('sentry', 'SENTRY'),
    ('posthog', 'POSTHOG'),
    ('resend', 'RESEND.COM')
on conflict do nothing;

create table reconciliation_matches (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    document_transaction_id uuid references document_transactions(id) on delete cascade not null,
    source_kind text not null check (source_kind in ('routing', 'connector', 'manual')),
    source_id uuid,
    confidence numeric(5,2) not null,
    auto boolean not null default true,
    resolved_by_user_id uuid references users(id),
    created_at timestamptz default now() not null,
    unique (document_transaction_id)
);

create index rm_workspace on reconciliation_matches(workspace_id);

create table reconciliation_candidates (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    document_transaction_id uuid references document_transactions(id) on delete cascade not null,
    source_kind text not null,
    source_id uuid not null,
    score numeric(5,2) not null,
    created_at timestamptz default now() not null
);

create index rc_workspace_txn on reconciliation_candidates(workspace_id, document_transaction_id);

alter table reconciliation_matches enable row level security;
alter table reconciliation_candidates enable row level security;

create policy "rm_select_own" on reconciliation_matches for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "rm_no_user_write" on reconciliation_matches for all using (false) with check (false);

create policy "rc_select_own" on reconciliation_candidates for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "rc_no_user_write" on reconciliation_candidates for all using (false) with check (false);