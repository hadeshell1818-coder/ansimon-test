const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inputPath = path.join(root, 'local-import', 'postal-hazard-controls-review.json');
const outputPath = path.join(root, 'local-import', 'approved-jangheung-risk-assessment.sql');
const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const records = payload.records.filter(record => record.domain === '장흥우체국 위험성평가');
if (!records.length) throw new Error('승인 대상 장흥우체국 위험성평가 항목이 없습니다.');

const quote = value => `'${String(value ?? '').replace(/'/g, "''")}'`;
const title = '장흥우체국 위험성평가 자료 (2026.6.16~6.26)';
const version = '2026-06-16~2026-06-26';
const sections = records.map(record => {
  const body = [
    `출처: ${record.source}`,
    `작업명·공정: ${record.task}`,
    `점검 항목: ${record.check_item}`,
    `유해·위험요인: ${record.hazard}`,
    `예상 사고 형태: ${record.accident_type}`,
    `개선대책(원문 현재 안전보건조치 요약): ${record.controls.join(' ')}`,
    `원문 판정: ${record.source_judgement}`,
    `검색어: ${record.keywords.join(', ')}`,
  ].join('\n');
  const locator = `${record.task} · 항목 ${record.item_no}`;
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  return { version, locator, body, content_hash: hash };
});
const tags = ['우체국', '장흥우체국', '위험성평가', '우편작업', '소포', '집배', '내부자료'];
const sectionsJson = JSON.stringify(sections);

const sql = `-- User-approved internal material. Re-running updates the same document and its 28 search sections.
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
  where title = ${quote(title)} and publisher = '장흥우체국' and source_url is null
  order by created_at desc
  limit 1
  for update;

  if v_document_id is null then
    insert into public.safety_documents (
      title, source_url, publisher, category, kind, tags, jurisdiction, rights_note,
      source_group, review_status, content_use_allowed, source_version, checked_at,
      reviewed_by, created_by
    ) values (
      ${quote(title)}, null, '장흥우체국', 'inspections', 'checklist',
      array[${tags.map(quote).join(', ')}]::text[], '대한민국',
      '사용자 제공 내부 자료 · Supabase 검색 및 위험성평가 근거 활용 승인 (2026-09-29)',
      'POST_OFFICE', 'approved', true, ${quote(version)}, now(),
      '사용자 승인 적재', 'user-approved-upload'
    ) returning id into v_document_id;
  else
    update public.safety_documents set
      category = 'inspections', kind = 'checklist',
      tags = array[${tags.map(quote).join(', ')}]::text[], jurisdiction = '대한민국',
      rights_note = '사용자 제공 내부 자료 · Supabase 검색 및 위험성평가 근거 활용 승인 (2026-09-29)',
      source_group = 'POST_OFFICE', review_status = 'approved', content_use_allowed = true,
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

select d.id, d.title, d.publisher, d.source_group, d.review_status,
  count(s.id) as searchable_sections
from public.safety_documents d
left join public.safety_document_sections s on s.document_id = d.id
  and s.version = ${quote(version)}
where d.title = ${quote(title)} and d.publisher = '장흥우체국'
  and d.source_url is null
group by d.id, d.title, d.publisher, d.source_group, d.review_status
order by d.created_at desc
limit 1;
`;

fs.writeFileSync(outputPath, sql, 'utf8');
console.log(JSON.stringify({ outputPath, sections: records.length, bytes: Buffer.byteLength(sql) }));
