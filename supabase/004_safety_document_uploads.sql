-- Private source-file storage and searchable text supplied with each document.
begin;
alter table public.safety_documents alter column source_url drop not null;
alter table public.safety_documents
  add column if not exists original_file_name text,
  add column if not exists storage_path text,
  add column if not exists mime_type text,
  add column if not exists file_size bigint,
  add column if not exists body_text text not null default '';

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('safety-documents', 'safety-documents', false, 6291456,
  array['application/pdf','application/haansofthwp','application/vnd.hancom.hwp','application/x-hwp','application/vnd.hancom.hwpx','application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = 6291456,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists safety_documents_service_insert on storage.objects;
create policy safety_documents_service_insert on storage.objects
  for insert to service_role with check (bucket_id = 'safety-documents');
drop policy if exists safety_documents_service_select on storage.objects;
create policy safety_documents_service_select on storage.objects
  for select to service_role using (bucket_id = 'safety-documents');
drop policy if exists safety_documents_service_delete on storage.objects;
create policy safety_documents_service_delete on storage.objects
  for delete to service_role using (bucket_id = 'safety-documents');

create index if not exists safety_documents_body_text_search
  on public.safety_documents using gin (to_tsvector('simple', coalesce(body_text, '')));
commit;
