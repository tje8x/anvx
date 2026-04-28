create table waitlist (
  id uuid default gen_random_uuid() primary key,
  name text,
  email text not null unique,
  company text,
  monthly_ai_spend text,
  team_size text,
  source text,
  created_at timestamptz default now() not null
);

create index waitlist_created_at on waitlist(created_at desc);

alter table waitlist enable row level security;

-- No client policies. Inserts only via /api/waitlist (service role).
create policy "waitlist_no_client_access" on waitlist
  for all using (false) with check (false);
