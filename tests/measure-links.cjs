const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// Each improvement measure keeps the references that actually support it; the review keeps a sound measure but drops
// a ref that does not support it (계단 미끄럼 ↔ "계단의 강도"); guides and checklists count as references, not only
// statutes. Measures stay plain text for the form, and 관련근거 says what each source is in words ("항목 5" is not a
// citation); checklist items repeating the same hazard and measures are listed once.
async function main() {
  const json = data => ({ ok: true, status: 200, headers: { get: () => '0-0/100' }, json: async () => data, text: async () => JSON.stringify(data) });
  const docs = [{ id: 'rule', title: '산업안전보건기준에 관한 규칙', kind: 'law', review_status: 'approved', source_version: 'v1' },
    { id: 'kosha', title: 'KOSHA GUIDE A-G-2-2025 작업장 내 통로(경사로, 계단, 발판사다리) 선정 및 설치에 관한 기술지원규정', kind: 'guideline', review_status: 'approved', source_version: 'v1' },
    { id: 'list', title: '우체국 작업 위험요인 및 개선대책 검색자료', kind: 'checklist', review_status: 'approved', source_version: 'v1' }];
  const item = no => `자료 구분: 청사·사무\n작업명·공정: 청사·사무실·출퇴근\n항목 번호: ${no}\n점검 항목: 계단 점검 ${no}\n유해·위험요인: 계단 미끄러짐·넘어짐\n개선대책: 계단 물기를 제거하고 미끄럼방지재를 붙인다.`;
  const sections = { rule: [{ id: 'a26', document_id: 'rule', version: 'v1', locator: '제26조(계단의 강도)', body: '계단 강도' }, { id: 'a3', document_id: 'rule', version: 'v1', locator: '제3조(전도의 방지)', body: '계단 미끄러짐 전도' }],
    kosha: [{ id: 'g64', document_id: 'kosha', version: 'v1', locator: '6.4 계단 디딤면의 미끄럼 방지', body: '계단 디딤면 미끄럼방지 테이프' },
      { id: 'c5', document_id: 'list', version: 'v1', locator: '청사·사무 · 청사·사무실·출퇴근 · 항목 5', body: item(5) },
      { id: 'c6', document_id: 'list', version: 'v1', locator: '청사·사무 · 청사·사무실·출퇴근 · 항목 6', body: item(6) }] };
  const request = async (url, options = {}) => {
    const href = decodeURIComponent(String(url)), body = options.body ? JSON.parse(options.body) : {};
    if (href.includes('/rpc/search_safety_sections')) return json(body.law_only ? sections.rule : sections.kosha);
    if (href.includes('/safety_documents?')) return json(docs);
    if (body.messages) {
      const first = body.messages[0].content;
      const content = first.startsWith('산업안전 위험 설명') ? { queries: ['계단 미끄러움', '전도의 방지'], critical: false, questions: [] }
        : first.startsWith('당신은 산업안전 위험성평가 초안의 품질') ? { causalCheck: 'pass', legalCheck: 'pass', reviewSummary: 'ok', additionalChecks: [],
          approvedMeasures: [{ text: '계단 디딤판에 미끄럼방지 테이프 부착', refs: ['doc:g64', 'doc:a26', 'doc:c5'] }, { text: '계단 주변 물기 즉시 제거', refs: ['doc:a3', 'doc:c6'] }] }
          : { factor: '계단 미끄러짐', measures: [{ text: '계단 디딤판에 미끄럼방지 테이프 부착', refs: ['doc:g64', 'doc:c5'] }, { text: '계단 주변 물기 즉시 제거', refs: ['doc:a3', 'doc:c6'] }, { text: '직원 안전교육', refs: [] }], citations: ['doc:a26'], limitations: '' };
      return json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    return json([]);
  };
  const repo = createKnowledgeRepository({ SAFETY_SUPABASE_URL: 'https://t.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'k', OPENAI_API_KEY: 'k', SAFETY_EXTERNAL_SEARCH: 'off' }, request);
  const advice = await repo.recommendRisk({ description: '계단이 미끄러워 넘어질 뻔함' });
  // doc:a26 (계단의 강도) was only a whole-draft citation, never a measure's ref, so the review cannot attach it.
  assert.deepEqual(advice.measureLinks.map(item => item.refs), [['doc:g64', 'doc:c5'], ['doc:a3', 'doc:c6'], []]);
  assert.deepEqual(advice.references.map(item => item.label), ['KOSHA GUIDE A-G-2-2025 작업장 내 통로(경사로, 계단, 발판사다리) 선정 및 설치 - 6.4 계단 디딤면의 미끄럼 방지',
    '우체국 작업 위험요인 점검표(청사·사무실·출퇴근): 계단 미끄러짐·넘어짐', '산업안전보건기준에 관한 규칙 제3조(전도의 방지)']);
  assert.deepEqual(advice.references.map(item => item.measures), [[1], [1, 2], [2]], 'the two identical checklist items are one reference supporting measures 1 and 2');
  assert.ok(advice.references.every(item => !/항목 \d/.test(item.label)), 'no storage address in 관련근거');
  assert.deepEqual(advice.measures, ['계단 디딤판에 미끄럼방지 테이프 부착', '계단 주변 물기 즉시 제거', '직원 안전교육'], 'plain text; the general measure the review dropped comes back for staff to choose');
  assert.ok(!advice.citations.includes('doc:a26'), 'a statute that supports no measure is not cited');
  console.log('PASS: measures keep their supporting references; unsupported refs dropped; readable 관련근거 labels; identical checklist items merged; plain measure text');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
