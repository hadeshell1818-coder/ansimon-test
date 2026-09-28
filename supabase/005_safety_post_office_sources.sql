-- Allow explicitly approved postal-service internal safety materials.
begin;
alter table public.safety_documents
  drop constraint if exists safety_documents_source_group_check;
alter table public.safety_documents
  add constraint safety_documents_source_group_check
  check (source_group in ('PUBLIC', 'POST_OFFICE', 'ASSESSMENT_RULES'));
commit;
