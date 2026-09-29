const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const root = path.resolve(__dirname, '..');
const inputPath = process.argv[2];
const outputPath = path.join(root, 'local-import', 'approved-postal-accident-cases.sql');
if (!inputPath) throw new Error('엑셀 파일 경로가 필요합니다.');

const workbook = XLSX.readFile(inputPath);
const sheet = workbook.Sheets['업로드용'];
if (!sheet) throw new Error('업로드용 시트를 찾을 수 없습니다.');
const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
const required = ['자료 구분', '작업명·공정', '항목 번호', '점검 항목', '유해·위험요인', '예상 사고 형태', '개선대책', '검색어', 'locator', 'version', 'body'];
for (const [index, row] of rows.entries()) {
  const missing = required.filter(key => !String(row[key] || '').trim());
  if (missing.length) throw new Error(`${index + 2}행 필수값 누락: ${missing.join(', ')}`);
}
const locators = rows.map(row => String(row.locator).trim());
if (new Set(locators).size !== locators.length) throw new Error('중복 locator가 있습니다.');

const quote = value => `'${String(value ?? '').replace(/'/g, "''")}'`;
const title = '우정사업 안전사고 사례 100선 추가자료';
const publisher = '우정사업본부';
const version = [...new Set(rows.map(row => String(row.version).trim()))];
if (version.length !== 1) throw new Error(`version 값이 하나가 아닙니다: ${version.join(', ')}`);
const sections = rows.map(row => ({
  version: version[0],
  locator: String(row.locator).trim(),
  body: String(row.body).trim(),
  content_hash: crypto.createHash('sha256').update(String(row.body).trim()).digest('hex'),
}));
const tags = [...new Set(['우체국', '우정사업', '안전사고', '위험성평가', '감소대책', ...rows.map(row => String(row['작업명·공정']).trim())])];
const sectionsJson = JSON.stringify(sections);
const originalName = path.basename(inputPath);
const fileSize = fs.statSync(inputPath).size;
const fileHash = crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex');
const rightsNote = `사용자 제공 우정사업 안전사고 사례 자료. 위험성평가 검색 및 감소대책 근거 활용 승인. 원본 파일 SHA-256 ${fileHash}`;
const bodyText = rows.map(row => String(row.body).trim()).join('\n\n');

const sql = `-- User-approved postal accident cases: ${sections.length} searchable sections.
begin;

do $upload$
declare
  v_document_id uuid;
begin
  select id into v_document_id
  from public.safety_documents
  where title = ${quote(title)} and publisher = ${quote(publisher)} and source_url is null
  order by created_at desc
  limit 1
  for update;

  if v_document_id is null then
    insert into public.safety_documents (
      title, source_url, publisher, category, kind, tags, jurisdiction, rights_note,
      source_group, review_status, content_use_allowed, source_version, checked_at,
      reviewed_by, created_by, original_file_name, mime_type, file_size, body_text
    ) values (
      ${quote(title)}, null, ${quote(publisher)}, 'inspections', 'incident',
      array[${tags.map(quote).join(', ')}]::text[], '대한민국', ${quote(rightsNote)},
      'POST_OFFICE', 'approved', true, ${quote(version[0])}, now(),
      '사용자 승인 적재', 'user-approved-postal-accident-upload', ${quote(originalName)},
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ${fileSize}, ${quote(bodyText)}
    ) returning id into v_document_id;
  else
    update public.safety_documents set
      category = 'inspections', kind = 'incident', tags = array[${tags.map(quote).join(', ')}]::text[],
      jurisdiction = '대한민국', rights_note = ${quote(rightsNote)}, source_group = 'POST_OFFICE',
      review_status = 'approved', content_use_allowed = true, source_version = ${quote(version[0])},
      checked_at = now(), reviewed_by = '사용자 승인 적재', original_file_name = ${quote(originalName)},
      mime_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      file_size = ${fileSize}, body_text = ${quote(bodyText)}
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
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, sql, 'utf8');
console.log(JSON.stringify({ outputPath, title, version: version[0], sections: sections.length, fileHash, bytes: Buffer.byteLength(sql) }));
