const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// Cohere rerank mode (default when COHERE_API_KEY is set): word + semantic (HyDE) candidates are reordered by the
// Cohere Rerank API and the draft receives the top 6 statutes and top 4 guides in that order. A failed or slow
// rerank falls back to the search order and says so; without a key the word search runs as before.
async function main() {
  const calls = [];
  let cohere = 'ok';
  const json = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => '0-0/100' }, json: async () => data, text: async () => JSON.stringify(data) });
  // One section per document so the three-per-document cap does not shrink the pool in this test.
  const docs = [...Array.from({ length: 10 }, (_, i) => ({ id: `rule-${i}`, title: `법령 ${i}`, kind: 'law', review_status: 'approved', source_version: 'v1' })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `guide-doc-${i}`, title: `KOSHA GUIDE ${i}`, kind: 'guideline', review_status: 'approved', source_version: 'v1' }))];
  const laws = Array.from({ length: 10 }, (_, i) => ({ id: `law-${i}`, document_id: `rule-${i}`, version: 'v1', locator: `제${170 + i}조(지게차 ${i})`, body: `지게차 후진 ${i}` }));
  const guides = Array.from({ length: 6 }, (_, i) => ({ id: `guide-${i}`, document_id: `guide-doc-${i}`, version: 'v1', locator: `5.${i} 지게차`, body: `지게차 후진 경보 ${i}` }));
  const request = async (url, options = {}) => {
    const href = decodeURIComponent(String(url)), body = options.body ? JSON.parse(options.body) : {};
    calls.push({ href, body, headers: options.headers || {} });
    if (href === 'https://api.cohere.com/v2/rerank') {
      if (cohere === 'fail') return json({ message: 'boom' }, 500);
      if (cohere === 'slow') { const error = new Error('The operation was aborted due to timeout'); error.name = 'TimeoutError'; throw error; }
      // Reverse the candidate order so the test can tell reranked order from search order.
      return json({ results: body.documents.map((_, index) => ({ index, relevance_score: index })).reverse() });
    }
    if (href.endsWith('/v1/embeddings')) return json({ data: body.input.map((_, index) => ({ index, embedding: [0.1] })) });
    if (href.includes('/rpc/match_safety_sections')) return json([]);
    if (href.includes('/rpc/match_safety_cases')) return json([]);
    if (href.includes('/rpc/search_safety_sections')) return json(body.law_only ? laws : guides);
    if (href.includes('/safety_documents?')) return json(docs);
    if (body.messages) {
      const first = body.messages[0].content;
      const content = first.startsWith('산업안전 위험 설명') ? { queries: ['지게차 후진', '접촉의 방지'], critical: false, questions: [] }
        : first.startsWith('산업안전 위험 설명을 읽고') ? { passage: '사업주는 지게차에 후진경보기를 설치하여야 한다.' }
          : first.startsWith('당신은 산업안전 위험성평가 초안의 품질') ? { causalCheck: 'pass', legalCheck: 'pass', approvedMeasures: ['후진경보기 설치'], approvedCitations: [], reviewSummary: 'ok', additionalChecks: [] }
            : { factor: '지게차 후진 충돌', measures: ['후진경보기 설치'], citations: [], limitations: '' };
      return json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    return json([]);
  };
  const env = { SAFETY_SUPABASE_URL: 'https://t.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'k', OPENAI_API_KEY: 'k', COHERE_API_KEY: 'co', SAFETY_EXTERNAL_SEARCH: 'off' };
  const repo = createKnowledgeRepository(env, request);
  const draftEvidence = () => JSON.parse(calls.filter(call => call.body.messages?.some(message => String(message.content).startsWith('당신은 우체국 산업안전'))).at(-1).body.messages.at(-1).content).evidence;

  const advice = await repo.recommendRisk({ description: '지게차가 후진하는데 뒤에 사람 지나감' });
  assert.equal(advice.internalSearch.mode, 'cohere', 'a Cohere key makes reranking the default');
  assert.equal(advice.internalSearch.rerank.provider, 'cohere'); assert.equal(advice.internalSearch.rerank.error, '');
  const rerankCall = calls.find(call => call.href === 'https://api.cohere.com/v2/rerank');
  assert.equal(rerankCall.headers.Authorization, 'Bearer co'); assert.equal(rerankCall.body.model, 'rerank-v3.5');
  assert.equal(rerankCall.body.documents.length, 16, 'the whole wide pool is reranked');
  const evidence = draftEvidence();
  // The reranked order is reversed here: 6 guides then laws 9..6 make the top 10 of any kind (no reserved law slots).
  assert.deepEqual(evidence.filter(item => item.type === '승인된 법령').map(item => item.ref), ['doc:law-9', 'doc:law-8', 'doc:law-7', 'doc:law-6'], 'statutes in reranked order');
  assert.deepEqual(evidence.filter(item => item.type === '문서 본문').map(item => item.ref), ['doc:guide-5', 'doc:guide-4', 'doc:guide-3', 'doc:guide-2', 'doc:guide-1', 'doc:guide-0'], 'guides in reranked order');
  assert.ok(calls.some(call => call.body.messages?.[0]?.content.startsWith('산업안전 위험 설명을 읽고')), 'HyDE passage feeds the meaning search');

  cohere = 'fail';
  const failed = await repo.recommendRisk({ description: '지게차가 후진하는데 뒤에 사람 지나감', refreshSources: true });
  assert.match(failed.internalSearch.rerank.error, /재순위 실패: 검색 순서 사용/);
  assert.equal(draftEvidence().filter(item => item.type === '승인된 법령')[0].ref, 'doc:law-0', 'search order on failure');
  cohere = 'slow';
  const slow = await repo.recommendRisk({ description: '지게차가 후진하는데 뒤에 사람 지나감', refreshSources: true });
  assert.match(slow.internalSearch.rerank.error, /응답 지연/);

  const noKey = createKnowledgeRepository({ ...env, COHERE_API_KEY: '' }, request);
  calls.length = 0;
  assert.equal((await noKey.recommendRisk({ description: '지게차가 후진하는데 뒤에 사람 지나감' })).internalSearch.mode, 'words');
  assert.ok(!calls.some(call => call.href.includes('cohere')), 'no Cohere call without a key');
  console.log('PASS: Cohere rerank orders the draft evidence (top 10 of any kind), falls back on failure or delay, off without a key');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
