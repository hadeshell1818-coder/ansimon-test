-- 007: 의미 검색 속도 개선 (006 이후 실행)
-- 006의 match_safety_sections는 문서 테이블과 조인한 채 거리순 정렬을 해서 벡터(HNSW) 색인을 못 타고
-- 전체를 비교하는 경우가 있었다. 동시 요청이 몰리면 statement timeout(57014)으로 실패했다.
-- 먼저 조문 테이블만으로 색인을 타서 가까운 후보 200개를 뽑고, 그다음 승인·현행 버전 조건으로 거른다.
-- 다시 실행해도 안전하다(create or replace).

create or replace function public.match_safety_sections(query_embedding extensions.vector(1536), match_count int default 40)
returns table (id uuid, document_id uuid, version text, locator text, body text, similarity double precision)
language sql stable set search_path = public, extensions as $$
  with nearest as (
    select s.id, s.document_id, s.version, s.locator, s.body, s.embedding <=> query_embedding as distance
    from public.safety_document_sections s
    where s.embedding is not null
    order by s.embedding <=> query_embedding
    limit 200
  )
  select n.id, n.document_id, n.version, n.locator, n.body, 1 - n.distance as similarity
  from nearest n
  join public.safety_documents d on d.id = n.document_id
  where d.review_status = 'approved' and d.content_use_allowed
    and (d.source_version is null or n.version = d.source_version)
  order by n.distance
  limit least(greatest(match_count, 1), 100);
$$;

create or replace function public.match_safety_cases(query_embedding extensions.vector(1536), match_count int default 25)
returns table (id uuid, similarity double precision)
language sql stable set search_path = public, extensions as $$
  with nearest as (
    select r.id, r.review_status, r.embedding <=> query_embedding as distance
    from public.safety_import_rows r
    where r.embedding is not null
    order by r.embedding <=> query_embedding
    limit 200
  )
  select n.id, 1 - n.distance as similarity
  from nearest n
  where n.review_status = 'approved'
  order by n.distance
  limit least(greatest(match_count, 1), 100);
$$;

revoke all on function public.match_safety_sections(extensions.vector, int) from public, anon, authenticated;
revoke all on function public.match_safety_cases(extensions.vector, int) from public, anon, authenticated;
grant execute on function public.match_safety_sections(extensions.vector, int) to service_role;
grant execute on function public.match_safety_cases(extensions.vector, int) to service_role;
