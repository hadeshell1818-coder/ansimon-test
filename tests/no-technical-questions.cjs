const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// Staff cannot answer measurement questions on the spot (2026-11-05: a 문어발 콘센트 draft asked for the total power draw).
// Such a question is dropped and the draft is written at once; a question about what the object is still goes through.
async function main() {
  const reply = body => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }] }) });
  const run = async question => {
    const calls = [];
    const request = async (url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      const system = String(body.messages[0].content);
      if (system.startsWith('산업안전 위험 설명과 사진')) return reply({ understanding: '여러 기기를 한 곳에 꽂아 과부하 화재 위험', cause: '과부하', directControls: ['한 곳에 여러 기기를 꽂지 않기'],
        passage: '사업주는 과부하를 방지하여야 한다.', queries: ['과부하'], critical: true, questions: [{ question, reason: '대책이 달라짐' }] });
      if (system.startsWith('질문 필요성을 재검토')) return reply({ unresolvedMeaning: true, questions: [{ question, reason: '대책이 달라짐' }] });
      return reply({ factor: '과부하 화재', rationale: '과부하', measures: [{ text: '한 곳에 여러 기기를 꽂지 않는다', refs: [] }], citations: [], limitations: '' });
    };
    const repo = createKnowledgeRepository({ OPENAI_API_KEY: 'k', SAFETY_EXTERNAL_SEARCH: 'off' }, request);
    return repo.recommendRisk({ description: '책상 밑에 전기를 여러 개 연결해 화재 위험이 있음', process: '사무' });
  };
  const technical = await run('연결된 기기들의 총 소비전력은 얼마인가요?');
  assert.notEqual(technical.needsClarification, true, 'a measurement question is not asked');
  assert.equal(technical.measures[0], '한 곳에 여러 기기를 꽂지 않는다');
  const identify = await run('연결된 것이 멀티탭인가요, 벽 콘센트인가요?');
  assert.equal(identify.needsClarification, true, 'identifying the object may still be asked');
  console.log('PASS: measurement questions (power, capacity, load…) are never asked; identifying questions still are');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
