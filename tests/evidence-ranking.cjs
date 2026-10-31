const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// Supabase returns ilike matches unordered; the draft must still receive the sections that match most search
// words (article titles first), only current versions, at most three sections per document.
async function main() {
  const documents = [
    { id: 'rule', title: '산업안전보건기준에 관한 규칙', kind: 'law', review_status: 'approved', source_version: 'v2', source_url: 'https://www.law.go.kr/rule' },
    { id: 'nftc', title: '유도등의 화재안전기술기준(NFTC 303)', kind: 'guideline', review_status: 'approved', source_version: 'n1', source_url: 'https://www.law.go.kr/nftc' },
    { id: 'kosha', title: 'KOSHA GUIDE G-11-2017 넘어짐 방지를 위한 위험관리 기술지침', kind: 'guideline', review_status: 'approved', source_version: 'k1', source_url: 'https://portal.kosha.or.kr/x' },
  ];
  const sections = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `filler-${i}`, document_id: 'rule', version: 'v2', locator: `제${100 + i}조(기타)`, body: '바닥 '.repeat(5) + i })),
    { id: 'fall', document_id: 'rule', version: 'v2', locator: '제3조(전도의 방지)', body: '사업주는 근로자가 작업장에서 넘어지거나 미끄러지는 등의 위험이 없도록 작업장 바닥 등을 안전하고 청결한 상태로 유지하여야 한다.' },
    { id: 'fall-old', document_id: 'rule', version: 'v1', locator: '제3조(전도의 방지)', body: '옛 조문 바닥 전도 미끄러짐' },
    { id: 'exit-sign', document_id: 'nftc', version: 'n1', locator: '2.1 피난구유도등 설치기준', body: '피난구유도등은 바닥으로부터 높이 1.5m 이상으로 설치한다.' },
    { id: 'slip', document_id: 'kosha', version: 'k1', locator: '4.2 넘어짐의 위험요소', body: '미끄러짐은 바닥에 엎질러진 물 등으로 발생한다. 전도 위험을 줄인다.' },
  ];
  const urls = []; let draftEvidence = null;
  const request = async (url, options = {}) => {
    const href = decodeURIComponent(String(url));
    if (href.includes('/rest/v1/')) {
      urls.push(href);
      if (href.includes('/safety_documents?')) return { ok: true, status: 200, json: async () => documents };
      if (href.includes('/safety_document_sections?')) {
        const terms = [...href.matchAll(/(locator|body)\.?=?ilike\.\*([^*]+)\*/g)].map(m => ({ field: m[1], term: m[2] }));
        const hits = sections.filter(section => terms.every(({ field, term }) => String(section[field]).includes(term)));
        return { ok: true, status: 200, json: async () => hits };
      }
      return { ok: true, status: 200, json: async () => [] };
    }
    const body = JSON.parse(options.body), first = body.messages[0].content;
    let content;
    if (first.startsWith('산업안전 위험 설명')) content = { queries: ['바닥 미끄러짐', '전도'], critical: false, questions: [] };
    else if (first.startsWith('당신은 산업안전 위험성평가 초안의 품질')) content = { causalCheck: 'pass', legalCheck: 'pass', approvedMeasures: ['바닥 물기를 즉시 제거한다.'], approvedCitations: ['doc:fall'], reviewSummary: '연결됨', additionalChecks: [] };
    else {
      draftEvidence = JSON.parse(body.messages.at(-1).content).evidence;
      content = { factor: '젖은 바닥 미끄러짐', measures: ['바닥 물기를 즉시 제거한다.'], citations: ['doc:fall'], limitations: '' };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  };
  const repo = createKnowledgeRepository({ SAFETY_SUPABASE_URL: 'https://test.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'key', OPENAI_API_KEY: 'k', SAFETY_EXTERNAL_SEARCH: 'off' }, request);
  await repo.recommendRisk({ description: '출입구 바닥이 젖어 미끄러움' });
  assert.ok(urls.some(url => /locator=ilike\.\*전도\*/.test(url)), 'article titles are searched');
  assert.ok(urls.some(url => /and=\(body\.ilike\.\*바닥\*,body\.ilike\.\*미끄러짐\*\)/.test(url)), 'word pairs are searched');
  const laws = draftEvidence.filter(item => item.type === '승인된 법령');
  assert.equal(laws[0].locator, '제3조(전도의 방지)', 'the article whose title and text match ranks first');
  assert.ok(!draftEvidence.some(item => item.ref === 'doc:fall-old'), 'superseded versions are not searched');
  assert.ok(laws.filter(item => item.title === '산업안전보건기준에 관한 규칙').length <= 3, 'at most three sections per document');
  const guides = draftEvidence.filter(item => item.type === '문서 본문');
  assert.deepEqual(guides.map(item => item.ref), ['doc:slip'], 'non-law guides are passed separately');
  console.log('PASS: evidence ranking by article title and word matches, current versions only, per-document cap, laws and guides separated');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
