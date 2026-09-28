const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inputPath = path.join(root, 'local-import', 'postal-hazard-controls-review.json');
const outputPath = path.join(root, 'local-import', 'approved-postal-hazard-controls.sql');
const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const records = payload.records;
if (records.length !== 401) throw new Error(`기대 항목 401건, 실제 ${records.length}건`);

const quote = value => `'${String(value ?? '').replace(/'/g, "''")}'`;
const title = '우체국 작업 위험요인 및 개선대책 검색자료';
const version = 'postal-hazard-controls-2026-09-29-v1';
const sections = records.map(record => {
  const body = [
    `자료 구분: ${record.domain}`,
    `작업명·공정: ${record.task}`,
    `항목 번호: ${record.item_no}`,
    `점검 항목: ${record.check_item}`,
    `유해·위험요인: ${record.hazard}`,
    `예상 사고 형태: ${record.accident_type}`,
    `개선대책: ${record.controls.join(' ')}`,
    record.supplementary_controls?.length ? `추가 보완대책: ${record.supplementary_controls.join(' ')}` : '',
    record.legal_basis?.length ? `관련 법령·근거(확인 필요 포함): ${record.legal_basis.join('; ')}` : '',
    record.source ? `원자료: ${record.source}` : '',
    record.source_judgement ? `원문 판정: ${record.source_judgement}` : '',
    `검색어: ${record.keywords.join(', ')}`,
  ].filter(Boolean).join('\n');
  const locator = `${record.domain} · ${record.task} · 항목 ${record.item_no}`;
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  return { version, locator, body, content_hash: contentHash };
});
const tags = [...new Set(['우체국', '위험성평가', ...records.flatMap(record => [record.domain, record.task])])];
const sectionsJson = JSON.stringify(sections);
const rightsNote = '사용자 제공·검토 자료 및 사용자 승인에 따라 내부 위험성평가 검색용으로 적재. 법령·대책의 적용성은 평가 담당자가 현장 조건과 원문을 확인해야 함.';

const sql = `-- User-approved searchable postal safety dataset: ${records.length} sections.
-- Idempotent upsert; executing again updates the same document/sections.
begin;

alter table public.safety_documents
  drop constraint if exists safety_documents_source_group_check;
alter table public.safety_documents
  add constraint safety_documents_source_group_check
  check (source_group in ('PUBLIC', 'POST_OFFICE', 'ASSESSMENT_RULES'));

do $upload$
declare
  v_document_id uuid;
begin
  select id into v_document_id
  from public.safety_documents
  where title = ${quote(title)} and publisher = '안심ON 안전자료 정리' and source_url is null
  order by created_at desc
  limit 1
  for update;

  if v_document_id is null then
    insert into public.safety_documents (
      title, source_url, publisher, category, kind, tags, jurisdiction, rights_note,
      source_group, review_status, content_use_allowed, source_version, checked_at,
      reviewed_by, created_by
    ) values (
      ${quote(title)}, null, '안심ON 안전자료 정리', 'inspections', 'checklist',
      array[${tags.map(quote).join(', ')}]::text[], '대한민국', ${quote(rightsNote)},
      'POST_OFFICE', 'approved', true, ${quote(version)}, now(),
      '사용자 승인 적재', 'user-approved-postal-controls-upload'
    ) returning id into v_document_id;
  else
    update public.safety_documents set
      category = 'inspections', kind = 'checklist',
      tags = array[${tags.map(quote).join(', ')}]::text[], jurisdiction = '대한민국',
      rights_note = ${quote(rightsNote)}, source_group = 'POST_OFFICE',
      review_status = 'approved', content_use_allowed = true,
      source_version = ${quote(version)}, checked_at = now(), reviewed_by = '사용자 승인 적재'
    where id = v_document_id;
  end if;

  insert into public.safety_document_sections (document_id, version, locator, body, content_hash)
  select v_document_id, item.version, item.locator, item.body, item.content_hash
  from jsonb_to_recordset(${quote(sectionsJson)}::jsonb)
    as item(version text, locator text, body text, content_hash text)
  on conflict (document_id, version, locator)
  do update set body = excluded.body, content_hash = excluded.content_hash;
end
$upload$;

commit;

select d.title, d.publisher, d.source_group, d.review_status,
  count(s.id) as searchable_sections,
  count(*) filter (where s.locator like '장흥우체국 위험성평가%') as jangheung_sections
from public.safety_documents d
left join public.safety_document_sections s on s.document_id = d.id
  and s.version = ${quote(version)}
where d.title = ${quote(title)} and d.publisher = '안심ON 안전자료 정리'
  and d.source_url is null
group by d.id, d.title, d.publisher, d.source_group, d.review_status
order by d.created_at desc
limit 1;
`;

fs.writeFileSync(outputPath, sql, 'utf8');
console.log(JSON.stringify({ outputPath, sections: sections.length, bytes: Buffer.byteLength(sql) }));
