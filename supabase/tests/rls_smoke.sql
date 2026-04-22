-- RLS smoke test: verify workspace isolation between users
begin;

-- Insert two fake users
insert into users (id, clerk_user_id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'user_a', 'a@test.com'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'user_b', 'b@test.com');

-- Insert two workspaces
insert into workspaces (id, clerk_org_id, name, slug, owner_user_id) values
  ('11111111-1111-1111-1111-111111111111', 'org_a', 'Workspace A', 'ws-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('22222222-2222-2222-2222-222222222222', 'org_b', 'Workspace B', 'ws-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

-- Insert matching workspace_members rows
insert into workspace_members (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner');

-- Impersonate user A
set local role 'authenticated';
select set_config('request.jwt.claims', '{"user_id": "user_a"}', true);

-- Assert user A sees exactly 1 workspace
do $$
begin
  if (select count(*) from workspaces) != 1 then
    raise exception 'FAIL: user_a should see 1 workspace, got %', (select count(*) from workspaces);
  end if;
end $$;

-- Impersonate user B
reset role;
set local role 'authenticated';
select set_config('request.jwt.claims', '{"user_id": "user_b"}', true);

-- Assert user B sees exactly 1 workspace
do $$
begin
  if (select count(*) from workspaces) != 1 then
    raise exception 'FAIL: user_b should see 1 workspace, got %', (select count(*) from workspaces);
  end if;
end $$;

-- Cleanup (rollback undoes all inserts)
rollback;
