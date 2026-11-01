const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// Each improvement measure names the references that actually support it ("(근거 n)"); the review keeps a sound
// measure but drops a ref that does not support it (계단 미끄럼 ↔ "계단의 강도"); guides count as references, not
// only statutes; a measure without support is marked as a general measure.
async function main() {
  const json = data => ({ ok: true, status: 200, headers: { get: () => '0-0/100' }, json: async () => data, text: async () => JSON.stringify(data) });
  const docs = [{ id: 'rule', title: '산업안전보건기준에 관한 규칙', kind: 'law', review_status: 'approved', source_version: 'v1' },
    { id: 'kosha', title: 'KOSHA GUIDE A-G-2-2025 작업장 내 통로(경사로, 계단, 발판사다리) 선정 및 설치에 관한 기술지원규정', kind: 'guideline', review_status: 'approved', source_version: 'v1' }];
  const sections = { rule: [{ id: 'a26', document_id: 'rule', version: 'v1', locator: '제26조(계단의 강도)', body: '계단 강도' }, { id: 'a3', document_id: 'rule', version: 'v1', locator: '제3조(전도의 방지)', body: '계단 미끄러짐 전도' }],
    kosha: [{ id: 'g64', document_id: 'kosha', version: 'v1', locator: '6.4 계단 디딤면의 미끄럼 방지', body: '계단 디딤면 미끄럼방지 테이프' }] };
  const request = async (url, options = {}) => {
    const href = decodeURIComponent(String(url)), body = options.body ? JSON.parse(options.body) : {};
    if (href.includes('/rpc/search_safety_sections')) return json(body.law_only ? sections.rule : sections.kosha);
    if (href.includes('/safety_documents?')) return json(docs);
    if (body.messages) {
      const first = body.messages[0].content;
      const content = first.startsWith('산업안전 위험 설명') ? { queries: ['계단 미끄러움', '전도의 방지'], critical: false, questions: [] }
        : first.startsWith('당신은 산업안전 위험성평가 초안의 품질') ? { causalCheck: 'pass', legalCheck: 'pass', reviewSummary: 'ok', additionalChecks: [],
          approvedMeasures: [{ text: '계단 디딤판에 미끄럼방지 테이프 부착', refs: ['doc:g64', 'doc:a26'] }, { text: '계단 주변 물기 즉시 제거', refs: ['doc:a3'] }, { text: '직원 안전교육', refs: [] }] }
          : { factor: '계단 미끄러짐', measures: [{ text: '계단 디딤판에 미끄럼방지 테이프 부착', refs: ['doc:g64'] }, { text: '계단 주변 물기 즉시 제거', refs: ['doc:a3'] }, { text: '직원 안전교육', refs: [] }], citations: ['doc:a26'], limitations: '' };
      return json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    return json([]);
  };
  const repo = createKnowledgeRepository({ SAFETY_SUPABASE_URL: 'https://t.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'k', OPENAI_API_KEY: 'k', SAFETY_EXTERNAL_SEARCH: 'off' }, request);
  const advice = await repo.recommendRisk({ description: '계단이 미끄러워 넘어질 뻔함' });
  // doc:a26 (계단의 강도) was only a whole-draft citation, never a measure's ref, so the review cannot attach it.
  assert.deepEqual(advice.measureLinks.map(item => item.refs), [['doc:g64'], ['doc:a3'], []]);
  assert.deepEqual(advice.references.map(item => item.label), ['KOSHA GUIDE A-G-2-2025 6.4 계단 디딤면의 미끄럼 방지', '산업안전보건기준에 관한 규칙 제3조(전도의 방지)']);
  assert.deepEqual(advice.measures, ['계단 디딤판에 미끄럼방지 테이프 부착 (근거 1)', '계단 주변 물기 즉시 제거 (근거 2)', '직원 안전교육 (일반 안전대책 · 근거 없음)']);
  assert.ok(!advice.citations.includes('doc:a26'), 'a statute that supports no measure is not cited');
  console.log('PASS: measures carry their own supporting references; unsupported refs are dropped; guides count as references');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
