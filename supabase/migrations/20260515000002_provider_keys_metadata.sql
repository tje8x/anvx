-- Capability-aware key metadata stored alongside the encrypted envelope.
-- Shape: { tier: string, capabilities: string[], warnings?: string[] }.
alter table provider_keys
  add column if not exists key_metadata jsonb not null default '{}'::jsonb;

-- Backfill any pre-existing rows that came in before the default landed.
update provider_keys set key_metadata = '{}'::jsonb where key_metadata is null;
