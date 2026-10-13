const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { requestAiJson } = require('../ai-json.cjs');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

async function main() {
  let attempts = 0;
  const retry = async (_url, options) => {
    attempts++;
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, attempts === 1 ? 1000 : 2000);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: attempts === 1 ? 'length' : 'stop',
      message: { content: attempts === 1 ? '{"measures":[' : '{"measures":["확인"]}' } }] }) };
  };
  assert.deepEqual(await requestAiJson({ request: retry, key: 'mock', messages: [], maxTokens: 1000 }), { measures: ['확인'] });
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(requestAiJson({ request: async () => { attempts++; return { ok: false, status: 401, json: async () => ({}) }; }, key: 'mock', messages: [] }), { code: 'ai_service_failed' });
  assert.equal(attempts, 1, 'authentication failures must not retry');
  attempts = 0;
  await assert.rejects(requestAiJson({ request: async () => { attempts++; return { ok: true, json: async () => ({ choices: [{ message: { content: '{bad' } }] }) }; }, key: 'mock', messages: [] }), { code: 'ai_invalid_response' });
  assert.equal(attempts, 2, 'malformed JSON retry is bounded');

  let searches = 0, drafts = 0, broken = false;
  const source = { title: '공식 지침', publisher: '안전보건공단', url: 'https://www.kosha.or.kr/guide', excerpt: '문 고정 장치 점검', measure: '출입문 고정' };
  const request = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/responses')) {
      searches++;
      assert.equal(body.tools[0].filters, undefined);
      if (broken) return { ok: false, status: 400, json: async () => ({ error: { param: 'tools', message: 'invalid configuration' } }) };
      return { ok: true, json: async () => ({ output: [{ type: 'web_search_call', action: { sources: [{ url: source.url }] } },
        { type: 'message', content: [{ text: JSON.stringify({ sources: [source, { ...source, url: 'https://untrusted.example/guide' }] }) }] }] }) };
    }
    const prompt = body.messages[0].content;
    let result;
    if (prompt.startsWith('산업안전 위험 설명')) result = { queries: ['출입문 바람'], critical: false };
    else if (prompt.startsWith('당신은 산업안전 위험성평가 초안의 품질')) result = { approvedReply: '기존 문 고정 방식을 현장에서 확인하세요.', causalCheck: 'pass', legalCheck: 'pass', approvedMeasures: ['담당자가 출입문 고정 장치를 점검하고 통행을 통제한다.'], approvedCitations: ['external:0'], additionalChecks: [] };
    else { drafts++; result = { factor: 'AI가 바꾼 표현', measures: ['출입문 고정 장치를 점검한다.'], citations: ['external:0'], rationale: '문 움직임 제한' }; }
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }) };
  };
  const repo = createKnowledgeRepository({ OPENAI_API_KEY: 'mock' }, request);
  const input = { description: '정문 출입문이 바람에 날려 통행인과 부딪칠 위험', actorId: 'manager1' };
  const original = JSON.stringify(input);
  const first = await repo.recommendRisk(input);
  assert.equal(first.status, 'ready');
  assert.equal(first.externalSources.length, 1, 'unverified URLs must never become evidence');
  assert.equal(JSON.stringify(input), original, 'original input is immutable');
  const chat = await repo.recommendRisk({ ...input, feedback: '다른 대책은?', evidenceSession: first.evidenceSession });
  assert.equal(searches, 1, 'conversation reuses server-side evidence');
  assert.equal(chat.externalSearch.reused, true);
  await repo.recommendRisk({ ...input, actorId: 'manager2', feedback: '다른 대책은?', evidenceSession: first.evidenceSession });
  assert.equal(searches, 2, 'evidence sessions cannot be borrowed by another user');
  await repo.recommendRisk({ ...input, description: '계단에서 미끄러져 넘어질 위험이 있음', feedback: '다른 대책은?', evidenceSession: first.evidenceSession });
  assert.equal(searches, 3, 'changed hazards invalidate cached evidence');
  await repo.recommendRisk({ ...input, feedback: '다른 근거는?', refreshSources: true, evidenceSession: first.evidenceSession });
  assert.equal(searches, 4, 'explicit search refresh bypasses cached evidence');
  broken = true;
  const beforeDrafts = drafts;
  const failed = await repo.recommendRisk(input);
  assert.equal(failed.status, 'search_failed');
  assert.equal(drafts, beforeDrafts, 'no draft or review after an evidence search failure');
  const beforeSearches = searches;
  await repo.recommendRisk(input);
  assert.equal(searches, beforeSearches, 'configuration failures do not repeatedly call the same broken endpoint');

  const sourceCode = fs.readFileSync('server.js', 'utf8');
  const hazard = { id: 'H1', transcript: '원본 신고', carrierId: 'c1', audioFile: 'original.webm' };
  const context = vm.createContext({ process: { env: { OPENAI_API_KEY: 'mock' } },
    rosterById: () => ({ zone: 'z1' }), ZONES: [{ id: 'z1', name: '구역1', area: '읍', places: [], near: [] }],
    zoneById: id => id === 'z1', requestAiJson: async () => { throw Error('invalid JSON'); },
    stubDraft: text => ({ text, zones: ['z1'], mode: 'rule' }), console: { error() {} } });
  vm.runInContext(sourceCode.slice(sourceCode.indexOf('async function openaiDraft('), sourceCode.indexOf('async function processVoice(')), context);
  const before = JSON.stringify(hazard), fallback = await context.openaiDraft(hazard.transcript, hazard);
  assert.equal(JSON.stringify(hazard), before, 'failed alert generation never mutates the original report');
  assert.equal(fallback.mode, 'rule');assert.match(fallback.aiError, /원본.*직접 검토/);
  for (const path of ['public/safety.html', 'public/risk.html']) {
    for (const match of fs.readFileSync(path, 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1]);
  }
  console.log('PASS: bounded JSON recovery, search compatibility, verified sources, isolated evidence cache, no draft on search failure, original reports preserved, both page scripts valid');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
