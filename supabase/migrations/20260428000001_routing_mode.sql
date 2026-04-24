alter table workspaces
	add column if not exists routing_mode text not null default 'shadow'
		check (routing_mode in ('shadow', 'copilot', 'autopilot'));