-- SIF 고위험요인 아카이브 승인: 검토 후 실행하세요. 승인하면 6,032건이 위험성평가 근거로 인용될 수 있습니다.
-- 공개자료라도 한국산업안전보건공단의 이용 조건을 확인한 뒤 실행합니다. 되돌리려면 'approved'를 'pending'으로 바꿔 다시 실행합니다.
-- 실행 전 확인: 승인된 사례가 Cohere 재순위를 거치도록 코드가 조정됐는지(AGENTS.md 숙제 목록 "근거 자료 보완"). 실행 후 근거자료실 「의미 검색 색인 만들기」로 사례 색인을 만든다.
begin;
update public.safety_documents
set review_status = 'approved', content_use_allowed = true, checked_at = now(), reviewed_by = '안전보건담당자 검토 승인'
where title = '산업재해 고위험요인(SIF) 아카이브';
update public.safety_import_rows r
set review_status = 'approved'
from public.safety_documents d
where d.id = r.document_id and d.title = '산업재해 고위험요인(SIF) 아카이브' and r.review_status = 'pending';
commit;
select review_status, count(*) from public.safety_import_rows group by review_status;
