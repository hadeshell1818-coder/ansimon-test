-- 008: 단어 검색 순위를 Supabase 안에서 매긴다 (006·007 이후 실행, 다시 실행해도 안전)
-- 지금까지는 단어마다 ilike로 30건씩 받아 앱에서 순위를 매겼다. 그런데 Supabase는 그 30건을 순서 없이 잘라 주므로,
-- "중량물"처럼 수백 건에 나오는 단어에서는 정답 조문·점검 항목이 아예 후보에 끼지 못했다(섹터 시뮬레이션: 검색어가
-- 정답 본문에 있는 경우 93%인데 후보에 오른 건 18%). 이 함수는 승인된 현행 조문 전체에 점수를 매겨 상위만 돌려준다.
-- 점수: 단어마다 가중치(드문 단어일수록 큼) × (본문 1 + 조문 제목 3 + 자료 제목 1), 두 단어 이상 구절이 본문에 있으면 +2,
-- 안전보건규칙 총칙(제1~53조) +1. 앱(safety-knowledge.cjs searchApprovedSections)과 같은 식이다.

create or replace function public.search_safety_sections(
  words text[], weights double precision[], phrases text[] default '{}', law_only boolean default null, match_count int default 60)
returns table (id uuid, document_id uuid, version text, locator text, body text, score double precision)
language sql stable set search_path = public as $$
  with docs as (
    select d.id, d.title, d.source_version,
      (d.kind = 'law' or coalesce(d.source_url, '') like 'https://www.law.go.kr/%') as is_law
    from public.safety_documents d
    where d.review_status = 'approved'
  ), scored as (
    select s.id, s.document_id, s.version, s.locator, s.body,
      (select coalesce(sum(w.weight * (
          (case when s.body ilike '%' || w.word || '%' then 1 else 0 end)
        + (case when coalesce(s.locator, '') ilike '%' || w.word || '%' then 3 else 0 end)
        + (case when d.title ilike '%' || w.word || '%' then 1 else 0 end))), 0)
       from unnest(words, weights) as w(word, weight))
      + (select count(*) * 2 from unnest(phrases) as p(phrase) where s.body ilike '%' || p.phrase || '%') as raw,
      d.title, d.is_law
    from public.safety_document_sections s
    join docs d on d.id = s.document_id
    where (d.source_version is null or s.version is null or s.version = d.source_version)
      and (law_only is null or d.is_law = law_only)
      and (s.body ilike any (select '%' || x || '%' from unnest(words) as x)
        or coalesce(s.locator, '') ilike any (select '%' || x || '%' from unnest(words) as x))
  )
  select id, document_id, version, locator, body,
    raw + (case when raw > 0 and title = '산업안전보건기준에 관한 규칙'
      and coalesce(substring(locator from '^제(\d+)조'), '0')::int between 1 and 53 then 1 else 0 end) as score
  from scored
  where raw > 0
  order by score desc, length(body)
  limit least(greatest(match_count, 1), 200);
$$;

revoke all on function public.search_safety_sections(text[], double precision[], text[], boolean, int) from public, anon, authenticated;
grant execute on function public.search_safety_sections(text[], double precision[], text[], boolean, int) to service_role;
