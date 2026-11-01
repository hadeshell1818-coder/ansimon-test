const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// Ranked word search (supabase/008): statutes and other material are ranked inside Supabase with rare-word weights,
// and the old per-word ilike fetch is not used. Without 008 (PGRST202) the per-word fetch runs and the reason is kept.
async function main() {
  let missing = false;
  const calls = [];
  const json = data => ({ ok: true, status: 200, headers: { get: () => '0-0/100' }, json: async () => data, text: async () => JSON.stringify(data) });
  const docs = [{ id: 'rule', title: '산업안전보건기준에 관한 규칙', kind: 'law', review_status: 'approved', source_version: 'v1' },
    { id: 'guide', title: 'KOSHA GUIDE G-1 밀폐공간', kind: 'guideline', review_status: 'approved', source_version: 'v1' }];
  const request = async (url, options = {}) => {
    const href = decodeURIComponent(String(url)), body = options.body ? JSON.parse(options.body) : {};
    calls.push({ href, body });
    if (href.includes('/rpc/search_safety_sections')) {
      if (missing) return { ok: false, status: 404, text: async () => '{"code":"PGRST202","message":"Could not find the function public.search_safety_sections"}' };
      return json(body.law_only ? [{ id: 'a619', document_id: 'rule', version: 'v1', locator: '제619조(밀폐공간 작업 프로그램의 수립ㆍ시행)', body: '밀폐공간 작업 프로그램' }]
        : [{ id: 'g1', document_id: 'guide', version: 'v1', locator: '4.1 밀폐공간 재해예방 원칙', body: '밀폐공간 맨홀 환기' }]);
    }
    if (href.includes('/safety_documents?')) return json(docs);
    if (href.includes('/safety_document_sections?') && href.includes('ilike')) return json([{ id: 'old', document_id: 'rule', version: 'v1', locator: '제3조(전도의 방지)', body: '맨홀 밀폐공간' }]);
    return json([]);
  };
  const repo = createKnowledgeRepository({ SAFETY_SUPABASE_URL: 'https://t.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'k' }, request);
  const ranked = await repo.rankEvidence(['밀폐공간', '맨홀', '점검']);
  assert.deepEqual(ranked.map(item => item.ref), ['doc:a619', 'doc:g1']);
  const rpcCalls = calls.filter(call => call.href.includes('/rpc/search_safety_sections'));
  assert.deepEqual(rpcCalls.map(call => call.body.law_only).sort(), [false, true]);
  assert.deepEqual(rpcCalls[0].body.words, ['밀폐공간', '맨홀'], 'generic words are not sent');
  assert.ok(rpcCalls[0].body.weights.every(Number.isFinite));
  assert.ok(!calls.some(call => call.href.includes('/safety_document_sections?') && call.href.includes('ilike') && !call.href.includes('select=id&or')), 'no per-word fetch when ranked search works');
  missing = true; calls.length = 0;
  const fallback = await repo.rankEvidence(['밀폐공간', '맨홀']);
  assert.ok(fallback.some(item => item.ref === 'doc:old'), 'per-word fetch runs without 008');

  // Other spellings are searched without their own count query, a word in over a fifth of sections (사용) is left
  // out of the ranked search, and the document list and counts are fetched once for repeated searches.
  const seen = [];
  const counts = { 사용: 500, 롤파렛트: 3, 철사: 4 };
  const countingRequest = async (url, options = {}) => {
    const href = decodeURIComponent(String(url)), body = options.body ? JSON.parse(options.body) : {};
    seen.push({ href, body });
    const word = (href.match(/body\.ilike\.\*(.+?)\*/) || [])[1];
    const range = href.includes('select=id&or=') ? `0-0/${counts[word] ?? 0}` : href.endsWith('?select=id') ? '0-0/1000' : '0-0/0';
    const reply = data => ({ ok: true, status: 200, headers: { get: () => range }, json: async () => data, text: async () => JSON.stringify(data) });
    if (href.includes('/rpc/search_safety_sections')) return reply(body.law_only ? [] : [{ id: 'p5', document_id: 'guide', version: 'v1', locator: '접수작업 · 항목 5', body: '롤테이너 돌출된 강선' }]);
    if (href.includes('/safety_documents?')) return reply(docs);
    return reply([]);
  };
  const counting = createKnowledgeRepository({ SAFETY_SUPABASE_URL: 'https://t.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'k' }, countingRequest);
  const found = await counting.rankEvidence(['롤파렛트 사용', '철사']);
  assert.deepEqual(found.map(item => item.ref), ['doc:p5']);
  const searchCall = seen.find(call => call.href.includes('/rpc/search_safety_sections'));
  assert.ok(searchCall.body.words.includes('롤테이너') && searchCall.body.words.includes('철사'), 'other spellings are searched');
  assert.ok(!searchCall.body.words.includes('사용'), 'a word in over a fifth of sections is left out');
  const countedWords = seen.filter(call => call.href.includes('select=id&or=')).map(call => call.href.match(/body\.ilike\.\*(.+?)\*/)[1]);
  assert.deepEqual(countedWords.sort(), ['롤파렛트', '사용', '철사'].sort(), 'only the words the staff used are counted');
  seen.length = 0;
  await counting.rankEvidence(['롤파렛트 사용', '철사']);
  assert.ok(!seen.some(call => call.href.includes('/safety_documents?') || call.href.includes('select=id')), 'document list and counts are reused');
  console.log('PASS: ranked word search inside Supabase with weights; per-word fetch only without 008; spellings share counts; common words dropped; lists cached');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
