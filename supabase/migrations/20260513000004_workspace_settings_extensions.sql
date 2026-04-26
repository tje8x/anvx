-- Workspace settings expansion: timezone, fiscal year, currency, copilot
-- approval policy, and per-workspace notification destinations.
alter table workspaces add column if not exists timezone text default 'UTC';
alter table workspaces add column if not exists fiscal_year_start_month int default 1
  check (fiscal_year_start_month between 1 and 12);
alter table workspaces add column if not exists default_currency text default 'USD';
alter table workspaces add column if not exists copilot_approvers text default 'admins_only'
  check (copilot_approvers in ('admins_only', 'admins_and_members'));
alter table workspaces add column if not exists slack_webhook_url text;
alter table workspaces add column if not exists notification_email text;
alter table workspaces add column if not exists autopilot_digest text default 'daily'
  check (autopilot_digest in ('per_event', 'daily', 'weekly'));

-- Allow expanded role set on workspace_members
alter table workspace_members drop constraint if exists workspace_members_role_check;
alter table workspace_members add constraint workspace_members_role_check
  check (role in ('owner', 'admin', 'member', 'viewer', 'accountant_viewer'));
