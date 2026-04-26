-- Allow packs to be dismissed (replaces a 'requested' pack that the user
-- created but doesn't want to purchase). Dismissed packs free up their period
-- for re-generation but stay in the table for audit history.

alter table packs drop constraint if exists packs_status_check;
alter table packs add constraint packs_status_check
  check (status in ('requested', 'generating', 'ready', 'failed', 'delivered', 'dismissed'));
