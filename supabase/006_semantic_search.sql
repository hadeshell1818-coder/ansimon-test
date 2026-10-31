-- 의미 검색(임베딩): 현장 표현("출입구 바닥이 젖어 미끄러움")과 법령 표현("전도의 방지")처럼
-- 단어가 겹치지 않아도 뜻이 가까운 조문·사례를 찾는다. 단어 검색은 그대로 두고 결과를 합쳐 쓴다.
-- 벡터는 앱의 「의미 검색 색인 만들기」가 OpenAI 임베딩으로 채운다. 다시 실행해도 안전하다.
create extension if not exists vector with schema extensions;

alter table public.safety_document_sections add column if not exists embedding extensions.vector(1536);
alter table public.safety_document_sections add column if not exists embedding_model text;
alter table public.safety_import_rows add column if not exists embedding extensions.vector(1536);
alter table public.safety_import_rows add column if not exists embedding_model text;

create index if not exists safety_document_sections_embedding on public.safety_document_sections
  using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists safety_import_rows_embedding on public.safety_import_rows
  using hnsw (embedding extensions.vector_cosine_ops);

-- 본문이 바뀐 조문·사례의 옛 벡터는 지워 다시 계산하게 한다(웹 SQL·Open API 적재 모두 해당).
create or replace function public.safety_clear_stale_section_embedding() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.body is distinct from old.body then new.embedding = null; new.embedding_model = null; end if;
  return new;
end;
$$;
create or replace function public.safety_clear_stale_case_embedding() returns trigger
language plpgsql set search_path = public as $$
begin
  if row(new.incident_summary, new.hazard_object, new.high_risk_situation, new.causal_factors, new.reduction_measures)
      is distinct from row(old.incident_summary, old.hazard_object, old.high_risk_situation, old.causal_factors, old.reduction_measures) then
    new.embedding = null; new.embedding_model = null;
  end if;
  return new;
end;
$$;
drop trigger if exists safety_section_embedding_stale on public.safety_document_sections;
create trigger safety_section_embedding_stale before update on public.safety_document_sections
  for each row execute function public.safety_clear_stale_section_embedding();
drop trigger if exists safety_import_row_embedding_stale on public.safety_import_rows;
create trigger safety_import_row_embedding_stale before update on public.safety_import_rows
  for each row execute function public.safety_clear_stale_case_embedding();

-- 승인된 자료의 현재 버전 조문만 검색한다(위험성평가 근거로 남은 옛 버전은 제외).
create or replace function public.match_safety_sections(query_embedding extensions.vector(1536), match_count int default 40)
returns table (id uuid, document_id uuid, version text, locator text, body text, similarity double precision)
language sql stable set search_path = public, extensions as $$
  select s.id, s.document_id, s.version, s.locator, s.body, 1 - (s.embedding <=> query_embedding) as similarity
  from public.safety_document_sections s
  join public.safety_documents d on d.id = s.document_id
  where s.embedding is not null and d.review_status = 'approved' and d.content_use_allowed
    and (d.source_version is null or s.version = d.source_version)
  order by s.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 100);
$$;

create or replace function public.match_safety_cases(query_embedding extensions.vector(1536), match_count int default 25)
returns table (id uuid, similarity double precision)
language sql stable set search_path = public, extensions as $$
  select r.id, 1 - (r.embedding <=> query_embedding) as similarity
  from public.safety_import_rows r
  where r.embedding is not null and r.review_status = 'approved'
  order by r.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 100);
$$;

-- 색인 저장: 한 번에 여러 행의 벡터를 넣는다. items = [{"id": "...", "embedding": [..1536..]}]
create or replace function public.set_safety_embeddings(target text, items jsonb, model text)
returns int language plpgsql set search_path = public, extensions as $$
declare updated int;
begin
  if target = 'sections' then
    update public.safety_document_sections s set embedding = (i.value->>'embedding')::extensions.vector, embedding_model = model
    from jsonb_array_elements(items) i where s.id = (i.value->>'id')::uuid;
  elsif target = 'cases' then
    update public.safety_import_rows r set embedding = (i.value->>'embedding')::extensions.vector, embedding_model = model
    from jsonb_array_elements(items) i where r.id = (i.value->>'id')::uuid;
  else
    raise exception 'unknown target %', target;
  end if;
  get diagnostics updated = row_count;
  return updated;
end;
$$;

revoke all on function public.match_safety_sections(extensions.vector, int) from public, anon, authenticated;
revoke all on function public.match_safety_cases(extensions.vector, int) from public, anon, authenticated;
revoke all on function public.set_safety_embeddings(text, jsonb, text) from public, anon, authenticated;
revoke all on function public.safety_clear_stale_section_embedding() from public;
revoke all on function public.safety_clear_stale_case_embedding() from public;
grant execute on function public.match_safety_sections(extensions.vector, int) to service_role;
grant execute on function public.match_safety_cases(extensions.vector, int) to service_role;
grant execute on function public.set_safety_embeddings(text, jsonb, text) to service_role;
