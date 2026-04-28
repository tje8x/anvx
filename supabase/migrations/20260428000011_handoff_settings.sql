alter table workspaces
  add column handoff_schedule text default 'disabled',
  add column handoff_email text,
  add column handoff_format text default 'pdf_csv';
