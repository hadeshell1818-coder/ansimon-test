const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseSifWorkbook } = require('../sif-import.cjs');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

function fixture() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['□ 제조업 등(건설업 외 업종)'], [],
    ['연번', '산재업종(대분류)', '산재업종(중분류)', '산재업종(소분류)', '재해개요', '기인물', '고위험작업·상황', '재해유발요인', '위험성 감소대책(예시)'],
    ['1', '제조업', '우편업', '우편물류', '롤파렛트가 넘어짐', '롤파렛트', '운반', '중량물 전도', '통로 정리'],
  ]), '아카이브(제조업등)');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['□ 건설업'], [],
    ['연번', '고위험작업·상황', '', '', '재해종류', '재해개요', '기인물', '재해유발요인', '위험성 감소대책(예시)'],
    ['', '공종', '작업명', '단위작업명', '', '', '', '', ''],
    ['1', '1. 토공사', '굴착', '장비반입', '추락', '개구부 추락', '개구부', '덮개 없음', '덮개 설치'],
  ]), '아카이브(건설업)');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

async function main() {
  const parsed = parseSifWorkbook(fixture(), 'fixture.xlsx');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].domain, 'manufacturing');
  assert.equal(parsed.rows[0].hazard_object, '롤파렛트');
  assert.equal(parsed.rows[1].domain, 'construction');
  assert.equal(parsed.rows[1].incident_type, '추락');

  const calls = [];
  const repository = createKnowledgeRepository({ SAFETY_SUPABASE_URL: 'https://example.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'server-only' }, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/safety_documents?select=id')) return { ok: true, status: 200, json: async () => [] };
    if (String(url).includes('/safety_documents?on_conflict')) return { ok: true, status: 201, json: async () => [{ id: 'doc-1' }] };
    return { ok: true, status: 201, json: async () => [] };
  });
  const result = await repository.importSif(fixture().toString('base64'), 'fixture.xlsx', 'manager');
  assert.equal(result.imported, 2);
  assert.deepEqual(result.sheets, ['아카이브(제조업등)', '아카이브(건설업)']);
  assert.equal(calls.filter(call => call.url.includes('/safety_import_rows')).length, 1);
  const imported = JSON.parse(calls.find(call => call.url.includes('/safety_import_rows')).options.body);
  assert(imported.every(row => row.review_status === 'pending' && row.document_id === 'doc-1'));
  console.log('PASS: SIF workbook parsing, 2-domain categorization, pending Supabase import payload');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
