-- One case is one retrievable unit; source citations and derived tags stay together.
begin;
create or replace view public.safety_case_chunks with (security_invoker = true) as
select id, document_id, source_url, source_file, source_sheet, source_row,
  domain, industry_large, industry_medium, industry_small, review_status,
  raw_row -> '_search' as search_labels,
  concat_ws(E'\n',
    '사고개요: ' || incident_summary,
    '기인물: ' || hazard_object,
    '고위험작업: ' || high_risk_situation,
    '유발요인: ' || causal_factors,
    '감소대책 예시: ' || reduction_measures) as content
from public.safety_import_rows;
revoke all on public.safety_case_chunks from public, anon, authenticated;
grant select on public.safety_case_chunks to service_role;
create index if not exists safety_import_rows_search_labels
  on public.safety_import_rows using gin ((raw_row -> '_search'));
commit;
