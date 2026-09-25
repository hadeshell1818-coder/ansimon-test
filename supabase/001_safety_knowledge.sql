-- New project only. The current app uses its own sessions, not Supabase Auth.
-- All browser access is denied. Only the authorized application server uses service_role.
begin;
create table public.safety_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  source_url text not null unique check (source_url like 'https://%'),
  publisher text not null,
  category text not null check (category in ('inspections','weather','musculoskeletal','stress','chemicals','training','contractors','general')),
  kind text not null check (kind in ('law','guideline','incident','checklist','manual')),
  tags text[] not null default '{}',
  jurisdiction text not null default '미확인',
  rights_note text not null default '이용조건 확인 필요',
  source_group text not null default 'PUBLIC' check (source_group = 'PUBLIC'),
  review_status text not null default 'pending' check (review_status in ('pending','approved','retired')),
  content_use_allowed boolean not null default false,
  effective_from date,
  effective_until date,
  source_version text,
  checked_at timestamptz,
  reviewed_by text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_until is null or effective_from is null or effective_until >= effective_from),
  check (review_status <> 'approved' or (reviewed_by is not null and checked_at is not null))
);

-- Future text ingestion: neither file upload nor automatic AI indexing is enabled yet.
create table public.safety_document_sections (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.safety_documents(id),
  version text not null,
  locator text not null,
  body text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique(document_id, version, locator)
);
create table public.safety_assessment_evidence (
  id uuid primary key default gen_random_uuid(),
  assessment_id text not null,
  document_id uuid not null references public.safety_documents(id),
  section_id uuid references public.safety_document_sections(id),
  locator text,
  note text,
  selected_by text not null,
  selected_at timestamptz not null default now(),
  unique(assessment_id, document_id, section_id)
);
create function public.safety_require_content_permission() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists(select 1 from public.safety_documents where id = new.document_id
    and content_use_allowed and review_status = 'approved') then
    raise exception 'Document content permission and review are required';
  end if;
  return new;
end;
$$;
create trigger safety_content_permission before insert or update on public.safety_document_sections
for each row execute function public.safety_require_content_permission();

create function public.safety_document_timestamp() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger safety_document_updated before update on public.safety_documents
for each row execute function public.safety_document_timestamp();

create index safety_documents_category on public.safety_documents(category, review_status);
create index safety_documents_tags on public.safety_documents using gin(tags);
alter table public.safety_documents enable row level security;
alter table public.safety_document_sections enable row level security;
alter table public.safety_assessment_evidence enable row level security;
revoke all on public.safety_documents, public.safety_document_sections from anon, authenticated;
revoke all on public.safety_assessment_evidence from anon, authenticated;
grant select, insert, update on public.safety_documents, public.safety_document_sections, public.safety_assessment_evidence to service_role;
revoke all on function public.safety_require_content_permission() from public;
revoke all on function public.safety_document_timestamp() from public;
commit;
