-- Normalize the legacy 'google_ai' provider id to 'google'.
--
-- The routing engine's `Provider` union uses 'google'; the connector layer was
-- writing 'google_ai' which left existing connections unroutable (the engine
-- looked up ctx.providerKeys['google'] and got nothing). This migration rewrites
-- every place the value lives so old rows continue to work after the rename.
--
-- Safe to run repeatedly: each statement is idempotent (only matches rows
-- still using the legacy id).

update provider_keys              set provider = 'google' where provider = 'google_ai';
update usage_records              set provider = 'google' where provider = 'google_ai';
update provider_model_usage       set provider = 'google' where provider = 'google_ai';
