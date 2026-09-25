-- SIF 원자료 가져오기용 검토대기 영역.
-- safety_document_sections에는 담당자 승인 전까지 넣지 않는다.
begin;
create table if not exists public.safety_import_rows (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.safety_documents(id),
  source_file text not null,
  source_url text not null check (source_url like 'https://%'),
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  domain text not null check (domain in ('manufacturing','construction')),
  industry_large text not null default '',
  industry_medium text not null default '',
  industry_small text not null default '',
  work_category text not null default '',
  work_name text not null default '',
  unit_work text not null default '',
  incident_type text not null default '',
  incident_summary text not null default '',
  hazard_object text not null default '',
  high_risk_situation text not null default '',
  causal_factors text not null default '',
  reduction_measures text not null default '',
  raw_row jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending' check (review_status in ('pending','approved','rejected')),
  imported_by text,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_url, source_sheet, source_row)
);
create index if not exists safety_import_rows_domain on public.safety_import_rows(domain, review_status);
create index if not exists safety_import_rows_hazard on public.safety_import_rows using gin(to_tsvector('simple', coalesce(hazard_object,'') || ' ' || coalesce(high_risk_situation,'') || ' ' || coalesce(causal_factors,'') || ' ' || coalesce(reduction_measures,'')));
create index if not exists safety_import_rows_document on public.safety_import_rows(document_id);
alter table public.safety_import_rows enable row level security;
revoke all on public.safety_import_rows from anon, authenticated;
grant select, insert, update on public.safety_import_rows to service_role;
commit;
