-- Rename "shadow" → "observer" across schema. Functionality unchanged.

-- 1. Update routing_mode values + check constraint
alter table workspaces drop constraint if exists workspaces_routing_mode_check;
update workspaces set routing_mode = 'observer' where routing_mode = 'shadow';
alter table workspaces alter column routing_mode set default 'observer';
alter table workspaces add constraint workspaces_routing_mode_check
  check (routing_mode in ('observer', 'copilot', 'autopilot'));

-- 2. Rename usage column
alter table routing_usage_records rename column shadow_suggestion to observer_suggestion;

-- 3. Rename recommendations table + its index
alter table shadow_recommendations rename to observer_recommendations;
alter index if exists sr_workspace_unresponded rename to or_workspace_unresponded;

-- RLS policies are renamed implicitly when the table is renamed.
