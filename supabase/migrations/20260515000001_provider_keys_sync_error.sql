-- Track last sync outcome on provider_keys so the dashboard can show
-- "Sync failed — rotate key" inline instead of crashing on a 401/403/etc.
alter table provider_keys
  add column if not exists last_sync_at timestamptz,
  add column if not exists last_sync_error text;

create index if not exists provider_keys_last_sync_error_idx
  on provider_keys(workspace_id) where last_sync_error is not null;
