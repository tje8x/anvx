-- Per-model usage breakdown.
--
-- Keeps a rolled-up view of token + cost data per (workspace, provider, model,
-- period_start). The connector sync upserts one row per model per day; the
-- Optimization tab queries this table to show the cost-mix histograms instead
-- of running large GROUP BY scans across `usage_records` on every page load.

create table provider_model_usage (
    id uuid default uuid_generate_v4() primary key,
    workspace_id uuid references workspaces(id) on delete cascade not null,
    provider text not null,
    model text not null,
    period_start date not null,
    period_end date not null,
    input_tokens bigint default 0,
    output_tokens bigint default 0,
    cache_read_tokens bigint default 0,
    cache_write_tokens bigint default 0,
    num_requests integer default 0,
    cost_cents integer default 0,
    created_at timestamptz default now(),
    unique(workspace_id, provider, model, period_start)
);

alter table provider_model_usage enable row level security;

create policy "workspace isolation" on provider_model_usage
    using (workspace_id = current_setting('app.workspace_id')::uuid);

create index idx_model_usage_workspace_period
    on provider_model_usage(workspace_id, period_start desc);
