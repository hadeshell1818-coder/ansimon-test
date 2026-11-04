const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// Hazard-first draft (2026-11-04, 문어발 콘센트): the understanding call also returns the direct cause, controls that
// remove it and the search passage; the process name ("시설물") is never a search word; the draft runs on gpt-4.1-mini
// with the cause and direct controls, and the separate review is off unless SAFETY_DRAFT_REVIEW=on.
async function main() {
  const calls = [];
  const reply = body => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }] }) });
  const request = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const system = body.messages[0].content;
    if (system.startsWith('산업안전 위험 설명과 사진')) return reply({ understanding: '한 콘센트에 여러 기기를 꽂아 과부하로 화재가 날 수 있다', cause: '한 콘센트에 여러 기기를 꽂은 과부하',
      directControls: ['한 콘센트·멀티탭에 여러 기기를 꽂지 않기', '콘센트 증설'], passage: '사업주는 과부하를 방지하여야 한다.', queries: ['시설물', '문어발 콘센트', '과부하'], critical: false, questions: [] });
    return reply({ factor: '문어발 콘센트 과부하', rationale: '과부하가 원인이다.', measures: [{ text: '한 콘센트·멀티탭에 여러 기기를 꽂지 않는다', refs: [] }, { text: '콘센트를 증설한다', refs: [] }], citations: [], limitations: '근거 미확인' });
  };
  const repo = createKnowledgeRepository({ OPENAI_API_KEY: 'k', SAFETY_EXTERNAL_SEARCH: 'off' }, request);
  const result = await repo.recommendRisk({ description: '문어발식 콘센트로 화재위험있음.', process: '시설물' }, { diagnostics: true });
  assert.deepEqual(result.diagnostics.queries, ['문어발 콘센트', '과부하'], 'the process name is not a search word');
  const draft = calls.find(call => JSON.parse(call.messages.at(-1).content).directControls);
  assert.equal(draft.model, 'gpt-4.1-mini');
  const input = JSON.parse(draft.messages.at(-1).content);
  assert.equal(input.cause, '한 콘센트에 여러 기기를 꽂은 과부하');
  assert.deepEqual(input.directControls, ['한 콘센트·멀티탭에 여러 기기를 꽂지 않기', '콘센트 증설']);
  assert.ok(draft.messages.some(message => /1~2번째 대책은 위험의 직접 원인/.test(message.content)), 'measures start from the cause');
  assert.ok(!calls.some(call => String(call.messages[0].content).startsWith('당신은 산업안전 위험성평가 초안의 품질')), 'no review call by default');
  assert.ok(!calls.some(call => String(call.messages[0].content).startsWith('산업안전 위험 설명을 읽고, 이 위험에 적용될')), 'no separate passage call');
  assert.equal(result.measures[0], '한 콘센트·멀티탭에 여러 기기를 꽂지 않는다');

  calls.length = 0;
  await createKnowledgeRepository({ OPENAI_API_KEY: 'k', SAFETY_EXTERNAL_SEARCH: 'off', SAFETY_DRAFT_REVIEW: 'on', SAFETY_DRAFT_MODEL: 'gpt-4o-mini' }, request)
    .recommendRisk({ description: '문어발식 콘센트로 화재위험있음.', process: '시설물' });
  assert.ok(calls.some(call => String(call.messages[0].content).startsWith('당신은 산업안전 위험성평가 초안의 품질')), 'review on request');
  assert.ok(calls.every(call => call.model === 'gpt-4o-mini'));
  console.log('PASS: process name not searched, cause and direct controls reach a gpt-4.1-mini draft, passage in the same call, review off by default and on by setting');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
