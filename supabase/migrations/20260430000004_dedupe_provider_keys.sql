-- One-shot cleanup of stale `provider_keys` rows that pre-date the
-- `key_metadata` column.
--
-- Background: before key_metadata existed, every connect/rotate flow inserted
-- a row with no tier or capabilities. After the metadata column shipped, new
-- rows were written alongside the old ones (rather than upserted), leaving
-- duplicate (workspace_id, provider) pairs. The new row carries a real
-- `tier` + `capabilities` array; the old row is a ghost.
--
-- This migration deletes the ghost. It's idempotent — once the legacy rows are
-- gone, the EXISTS check finds nothing and the DELETE is a no-op. Safe to run
-- repeatedly. We deliberately do NOT use ON DELETE CASCADE side-effects
-- because no FK depends on the legacy row's id.
--
-- The `(...)` parens are required around the OR — without them Postgres
-- parses `a or b and exists(...)` as `a or (b and exists(...))`, leaving
-- legacy null-tier rows behind when the metadata column happens to be `{}`.

delete from provider_keys old
where
  (old.key_metadata is null or old.key_metadata = '{}'::jsonb)
  and exists (
    select 1
    from provider_keys newer
    where newer.workspace_id = old.workspace_id
      and newer.provider = old.provider
      and newer.id <> old.id
      and newer.key_metadata is not null
      and newer.key_metadata <> '{}'::jsonb
  );
