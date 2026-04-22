-- 1. Extensions
create extension if not exists "pgcrypto";

-- 2. users
create table users (
  id uuid default gen_random_uuid() primary key,
  clerk_user_id text unique not null,
  email text not null,
  display_name text,
  avatar_url text,
  deleted_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- 3. workspaces
create table workspaces (
  id uuid default gen_random_uuid() primary key,
  clerk_org_id text unique not null,
  name text not null,
  slug text unique not null,
  owner_user_id uuid references users(id) not null,
  plan text default 'design_partner' check (plan in ('design_partner','metered','trial')),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- 4. workspace_members
create table workspace_members (
  id uuid default gen_random_uuid() primary key,
  workspace_id uuid references workspaces(id) on delete cascade not null,
  user_id uuid references users(id) on delete cascade not null,
  role text not null check (role in ('owner','admin','member')),
  invited_by uuid references users(id),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(workspace_id, user_id)
);

-- 5. processed_webhooks
create table processed_webhooks (
  id uuid default gen_random_uuid() primary key,
  source text not null check (source in ('clerk','stripe')),
  event_id text not null,
  processed_at timestamptz default now() not null,
  unique(source, event_id)
);

-- 6. Enable RLS
alter table users enable row level security;
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table processed_webhooks enable row level security;

-- 7a. Helper to break circular RLS dependency between workspaces and workspace_members
create or replace function get_user_workspace_ids(p_clerk_user_id text)
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select wm.workspace_id
  from workspace_members wm
  join users u on u.id = wm.user_id
  where u.clerk_user_id = p_clerk_user_id;
$$;

-- 7b. Policies
create policy "users_select_own" on users
  for select
  using (clerk_user_id = auth.jwt()->>'user_id');

create policy "workspaces_select_member" on workspaces
  for select
  using (
    id in (select get_user_workspace_ids(auth.jwt()->>'user_id'))
  );

create policy "wm_select_own_workspace" on workspace_members
  for select
  using (
    workspace_id in (select get_user_workspace_ids(auth.jwt()->>'user_id'))
  );

-- processed_webhooks: no user-facing policies (webhook service-role only)

-- 8. updated_at trigger
create function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at before update on users
  for each row execute function set_updated_at();

create trigger set_updated_at before update on workspaces
  for each row execute function set_updated_at();

create trigger set_updated_at before update on workspace_members
  for each row execute function set_updated_at();
