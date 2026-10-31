const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// A report ("출입구 바닥이 젖어 미끄러움") and the statute ("전도의 방지") share no search word; the semantic list
// must still bring the statute to the draft. Without supabase/006 the word search keeps working and says why.
async function main() {
  const documents = [{ id: 'rule', title: '산업안전보건기준에 관한 규칙', kind: 'law', review_status: 'approved', source_version: 'v1', source_url: 'https://www.law.go.kr/rule' }];
  const statute = { id: 'fall', document_id: 'rule', version: 'v1', locator: '제3조(전도의 방지)', body: '사업주는 근로자가 넘어지는 등의 위험이 없도록 작업장을 청결한 상태로 유지하여야 한다.' };
  const sifCase = { id: 'case-1', review_status: 'approved', incident_summary: '젖은 출입구에서 넘어짐', reduction_measures: '흡수 매트 고정' };
  let rpcMissing = false, pending = [{ id: 'fall', document_id: 'rule', locator: statute.locator, body: statute.body }];
  const calls = [];
  const json = (data, headers = {}) => ({ ok: true, status: 200, headers: { get: name => headers[name.toLowerCase()] }, json: async () => data, text: async () => JSON.stringify(data) });
  const request = async (url, options = {}) => {
    const href = decodeURIComponent(String(url)), body = options.body ? JSON.parse(options.body) : {};
    calls.push({ href, body, headers: options.headers || {} });
    if (href.endsWith('/v1/embeddings')) return json({ data: body.input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) });
    if (href.includes('/rest/v1/rpc/')) {
      if (rpcMissing) return { ok: false, status: 404, text: async () => '{"code":"PGRST202","message":"Could not find the function public.match_safety_sections"}' };
      if (href.endsWith('match_safety_sections')) return json([{ ...statute, similarity: 0.81 }]);
      if (href.endsWith('match_safety_cases')) return json([{ id: 'case-1', similarity: 0.77 }]);
      if (href.endsWith('set_safety_embeddings')) { pending = []; return json(body.items.length); }
    }
    if (href.includes('/safety_documents?')) return json(documents);
    if (href.includes('/safety_import_rows?') && href.includes('id=in.(case-1)')) return json([sifCase]);
    if (href.includes('embedding=is.null') && options.headers?.Prefer === 'count=exact') return json([], { 'content-range': `0-0/${href.includes('safety_document_sections') ? pending.length : 0}` });
    if (options.headers?.Prefer === 'count=exact') return json([], { 'content-range': '0-0/1' });
    if (href.includes('/safety_document_sections?') && href.includes('embedding=is.null')) return json(pending);
    if (href.includes('/safety_import_rows?') && href.includes('embedding=is.null')) return json([]);
    if (href.includes('/chat/completions') || body.messages) {
      const first = body.messages[0].content;
      const content = first.startsWith('산업안전 위험 설명') ? { queries: ['출입구 미끄러움'], critical: false, questions: [] }
        : first.startsWith('당신은 산업안전 위험성평가 초안의 품질') ? { causalCheck: 'pass', legalCheck: 'pass', approvedMeasures: ['흡수 매트를 고정한다.'], approvedCitations: ['doc:fall'], reviewSummary: '연결', additionalChecks: [] }
          : { factor: '젖은 바닥 전도', measures: ['흡수 매트를 고정한다.'], citations: ['doc:fall'], limitations: '' };
      return json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    return json([]);
  };
  const env = { SAFETY_SUPABASE_URL: 'https://test.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'key', OPENAI_API_KEY: 'k', SAFETY_EXTERNAL_SEARCH: 'off', SAFETY_SEMANTIC_SEARCH: 'on' };
  const repo = createKnowledgeRepository(env, request);

  const advice = await repo.recommendRisk({ description: '출입구 바닥이 젖어 미끄러움' });
  const draftCall = calls.find(call => call.body.messages?.some(message => String(message.content).startsWith('당신은 우체국 산업안전')));
  const evidence = JSON.parse(draftCall.body.messages.at(-1).content).evidence;
  assert.ok(evidence.some(item => item.ref === 'doc:fall' && item.type === '승인된 법령'), 'meaning-only statute reaches the draft');
  assert.equal(evidence.find(item => item.type === 'SIF 사례').ref, 'sif:case-1', 'semantic cases come first');
  assert.deepEqual(advice.internalSearch.semantic, { used: true, error: '' });
  const embedCall = calls.find(call => call.href.endsWith('/v1/embeddings'));
  assert.equal(embedCall.body.model, 'text-embedding-3-small'); assert.equal(embedCall.body.dimensions, 1536);

  rpcMissing = true;
  const fallback = await repo.recommendRisk({ description: '출입구 바닥이 젖어 미끄러움', refreshSources: true });
  assert.equal(fallback.internalSearch.semantic.used, false);
  assert.match(fallback.internalSearch.semantic.error, /006_semantic_search\.sql/);
  rpcMissing = false;

  const before = await repo.embeddingStatus();
  assert.equal(before.ready, false); assert.equal(before.sections.missing, 1);
  const indexed = await repo.indexEmbeddings({ budgetMs: 5000 });
  const setCall = calls.find(call => call.href.endsWith('set_safety_embeddings'));
  assert.equal(setCall.body.target, 'sections'); assert.equal(setCall.body.model, 'text-embedding-3-small');
  assert.deepEqual(setCall.body.items, [{ id: 'fall', embedding: [0.1, 0.2, 0.3] }]);
  const indexInput = calls.filter(call => call.href.endsWith('/v1/embeddings')).at(-1).body.input[0];
  assert.match(indexInput, /^산업안전보건기준에 관한 규칙 제3조\(전도의 방지\)\n사업주는/, 'document title and article title are embedded with the text');
  assert.equal(indexed.indexed, 1); assert.equal(indexed.ready, true);

  const evaluation = await repo.evaluateSearch({ offset: 0, limit: 2 });
  assert.equal(evaluation.total, 175); assert.equal(evaluation.results.length, 2);
  assert.ok(evaluation.results.every(item => item.expect.every(expect => ['words', 'add', 'rrf'].every(key => typeof expect[key] === 'boolean'))));
  const evalEmbed = calls.filter(call => call.href.endsWith('/v1/embeddings')).at(-1).body.input[0];
  assert.match(evalEmbed, /\n/, 'evaluation embeds the report text together with the search words, like a real draft');

  const noKey = createKnowledgeRepository({ ...env, OPENAI_API_KEY: '' }, request);
  assert.equal((await noKey.embeddingStatus()).ready, false);
  await assert.rejects(noKey.indexEmbeddings(), /OPENAI_API_KEY/);
  // Additive fusion: many meaning-only matches must not push out a section the word search found.
  const wordHit = { id: 'word-hit', document_id: 'rule', version: 'v1', locator: '제22조(통로의 설치)', body: '통로 미끄러움 출입구 통로 미끄러움' };
  const flood = Array.from({ length: 30 }, (_, i) => ({ id: `meaning-${i}`, document_id: `doc-${i}`, version: 'v1', locator: `제${i}조(기타)`, body: '기타 조문', similarity: 0.9 - i / 100 }));
  const floodDocs = [...documents, ...flood.map(item => ({ id: item.document_id, title: `법령 ${item.document_id}`, kind: 'law', review_status: 'approved', source_version: 'v1', source_url: 'https://www.law.go.kr/x' }))];
  const floodRepo = createKnowledgeRepository(env, async (url, options = {}) => {
    const href = decodeURIComponent(String(url));
    if (href.endsWith('/v1/embeddings')) return json({ data: [{ index: 0, embedding: [0.1] }] });
    if (href.endsWith('match_safety_sections')) return json(flood);
    if (href.endsWith('match_safety_cases')) return json([]);
    if (href.includes('/safety_documents?')) return json(floodDocs);
    if (href.includes('/safety_document_sections?') && /ilike\.\*(통로|미끄러움|출입구)\*/.test(href)) return json([wordHit]);
    return request(url, options);
  });
  const floodEval = await floodRepo.evaluateSearch({ offset: 0, limit: 1 });
  assert.ok(floodEval.results.length === 1);
  await floodRepo.recommendRisk({ description: '출입구 통로 미끄러움' });
  const floodDraft = calls.filter(call => call.body.messages?.some(message => String(message.content).startsWith('당신은 우체국 산업안전'))).at(-1);
  const floodLaws = JSON.parse(floodDraft.body.messages.at(-1).content).evidence.filter(item => item.type === '승인된 법령');
  assert.ok(floodLaws.some(item => item.ref === 'doc:word-hit'), 'word-search pick survives a flood of meaning matches');
  assert.equal(floodLaws.filter(item => item.ref.startsWith('doc:meaning-')).length, 4, 'at most four meaning-only statutes are appended');
  console.log('PASS: meaning-only statute and cases reach the draft, missing migration reported with word-search fallback, batched indexing and status, search evaluation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
