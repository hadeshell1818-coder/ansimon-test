const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// Search-word refinement: generic, too common or unmatched words are replaced using the whole report;
// useful words are kept; middle-dot bundles are split into separate words; nothing is sent when all words are useful.
async function main() {
  const counts = { '': 6000, 정화조: 30, 맨홀: 60, 소포: 1300, 롱타임중단: 0 };
  const sent = [];
  const request = async (url, options = {}) => {
    const href = decodeURIComponent(String(url));
    if (options.headers?.Prefer === 'count=exact') {
      const term = (href.match(/body\.ilike\.\*([^*]+)\*/) || [])[1] || '';
      return { ok: true, status: 206, headers: { get: () => `0-0/${counts[term] ?? 10}` }, text: async () => '[]', json: async () => [] };
    }
    const body = JSON.parse(options.body || '{}');
    sent.push(JSON.parse(body.messages[1].content));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ replacements: ['밀폐공간·산소결핍', '환기'] }) } }] }) };
  };
  const repo = createKnowledgeRepository({ SAFETY_SUPABASE_URL: 'https://t.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'k', OPENAI_API_KEY: 'k' }, request);
  const refined = await repo.refineQueries('정화조 점검하러 맨홀 들어감', ['정화조', '맨홀', '소포', '안전조치', '롱타임중단']);
  assert.deepEqual(refined.weak.map(item => item.query), ['소포', '안전조치', '롱타임중단']);
  assert.match(refined.weak[0].reason, /너무 흔함/); assert.equal(refined.weak[1].reason, '일반어'); assert.equal(refined.weak[2].reason, '자료에 없는 말');
  assert.deepEqual(refined.queries, ['정화조', '맨홀', '밀폐공간', '산소결핍', '환기']);
  assert.equal(sent[0].description, '정화조 점검하러 맨홀 들어감', 'the whole report goes to the AI');
  const untouched = await repo.refineQueries('정화조 맨홀', ['정화조', '맨홀']);
  assert.deepEqual(untouched.queries, ['정화조', '맨홀']); assert.equal(sent.length, 1, 'no AI call when every word is useful');
  console.log('PASS: generic/common/unmatched search words replaced from the whole report; useful words kept');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
