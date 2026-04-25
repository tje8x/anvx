create table packs (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    kind text not null check (kind in ('close_pack', 'ai_audit_pack', 'audit_trail_export')),
    period_start date not null,
    period_end date not null,
    status text not null check (status in ('requested', 'generating', 'ready', 'failed', 'delivered')),
    storage_path text,
    error_message text,
    price_cents int not null,
    stripe_checkout_session_id text,
    stripe_payment_intent_id text,
    requested_by_user_id uuid references users(id) not null,
    created_at timestamptz default now() not null,
    ready_at timestamptz,
    delivered_to_email text
);

create index packs_workspace_kind_period on packs(workspace_id, kind, period_end desc);
create index packs_status_pending on packs(status) where status in ('requested', 'generating');

alter table packs enable row level security;

create policy "packs_select_own" on packs for select using (workspace_id::text = auth.jwt()->>'workspace_id');
create policy "packs_no_user_write" on packs for all using (false) with check (false);

create table pack_prices (
    id uuid default gen_random_uuid() primary key,
    workspace_id uuid references workspaces(id) on delete cascade,
    kind text not null,
    price_cents int not null,
    effective_from timestamptz default now(),
    note text
);

create unique index pack_prices_active on pack_prices (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), kind);

insert into pack_prices (workspace_id, kind, price_cents, note) values
    (null, 'close_pack', 4900, 'monthly close pack'),
    (null, 'ai_audit_pack', 14900, 'quarterly AI audit pack'),
    (null, 'audit_trail_export', 0, 'free audit trail export');

alter table pack_prices enable row level security;

create policy "pack_prices_no_user_access" on pack_prices for all using (false) with check (false);