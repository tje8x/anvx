-- All object paths must be prefixed workspaces/<workspace_id>/
-- RLS enforces both bucket AND workspace on every access.

create policy "storage_documents_select_own" on storage.objects
  for select using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = 'workspaces'
    and (storage.foldername(name))[2]::text = auth.jwt()->>'workspace_id'
);

create policy "storage_documents_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = 'workspaces'
    and (storage.foldername(name))[2]::text = auth.jwt()->>'workspace_id'
);

create policy "storage_documents_delete_own" on storage.objects
  for delete using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = 'workspaces'
    and (storage.foldername(name))[2]::text = auth.jwt()->>'workspace_id'
);

create policy "storage_packs_select_own" on storage.objects
  for select using (
    bucket_id = 'packs'
    and (storage.foldername(name))[1] = 'workspaces'
    and (storage.foldername(name))[2]::text = auth.jwt()->>'workspace_id'
);

create policy "storage_packs_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'packs'
    and (storage.foldername(name))[1] = 'workspaces'
    and (storage.foldername(name))[2]::text = auth.jwt()->>'workspace_id'
);

create policy "storage_packs_delete_own" on storage.objects
  for delete using (
    bucket_id = 'packs'
    and (storage.foldername(name))[1] = 'workspaces'
    and (storage.foldername(name))[2]::text = auth.jwt()->>'workspace_id'
);