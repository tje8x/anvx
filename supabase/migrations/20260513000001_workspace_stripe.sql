alter table workspaces add column if not exists stripe_customer_id text;
alter table workspaces add column if not exists stripe_subscription_id text;
alter table workspaces add column if not exists stripe_subscription_item_id text;
alter table workspaces add column if not exists subscription_status text;
