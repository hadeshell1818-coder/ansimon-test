#!/usr/bin/env node
// Direct-measure simulation (2026-11-04): runs the real draft pipeline on everyday hazards written the way staff write
// them (seed-assets/direct-measure-cases.json) and has a larger model judge each draft:
//   direct      the measure that removes the cause (e.g. 문어발 콘센트 → 한 콘센트에 여러 기기를 꽂지 않음) is present
//   directRank  its position among the measures (1 = first)
//   fit         measures that actually reduce this hazard (of 5)
//   badRefs     references that have nothing to do with this hazard
// plus the time of each stage. Usage (behind a proxy add NODE_USE_ENV_PROXY=1):
//   OPENAI_API_KEY=... SAFETY_SUPABASE_URL=... SAFETY_SUPABASE_SERVICE_KEY=... [COHERE_API_KEY=...] \
//   node scripts/simulate-direct-measures.cjs --label baseline [--only C01,C02] [--concurrency 3] [--set KEY=VALUE ...]
// Results: local-import/simulation/direct-<label>.jsonl (not in git) and a summary on stdout.
const fs = require('node:fs');
const path = require('node:path');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const overrides = Object.fromEntries(args.flatMap((arg, i) => arg === '--set' ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
const label = option('--label', 'run');
const only = option('--only', '') ? option('--only').split(',') : null;
const cases = require('../seed-assets/direct-measure-cases.json').cases.filter(item => !only || only.includes(item.id));
const out = path.join(__dirname, '../local-import/simulation', `direct-${label}.jsonl`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const env = { ...process.env, ...overrides };
const repo = createKnowledgeRepository(env, fetch);

async function judge(item, result) {
  const measures = (result.measures || []).map((m, i) => `${i + 1}. ${typeof m === 'string' ? m : m.text}`).join('\n');
  const refs = (result.references || []).map((r, i) => `${i + 1}. ${r.label}`).join('\n') || '(없음)';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.SIM_JUDGE_MODEL || 'gpt-4.1', temperature: 0, response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: '당신은 산업안전 위험성평가 개선대책 채점자입니다. 위험 설명, 그 위험의 원인을 없애는 직접 대책(채점 기준), 초안의 개선대책과 관련근거를 받습니다. direct: 개선대책 중 하나라도 채점 기준의 핵심(원인을 없애거나 직접 막는 조치)을 실제로 담고 있으면 true(같은 뜻이면 표현이 달라도 됨, "점검·교육·주의"처럼 뭉뚱그린 말만 있으면 false). directRank: 그 대책의 번호(없으면 null). fit: 이 위험을 실제로 줄이는 대책 수(다른 작업·다른 위험 대책은 제외). badRefs: 이 위험과 상관없는 관련근거 수. note: 빠진 것이나 엉뚱한 것 한 줄. JSON: {"direct":true,"directRank":1,"fit":5,"badRefs":0,"note":""}' },
      { role: 'user', content: JSON.stringify({ hazard: item.text, process: item.process, expectedDirect: item.direct, measures, references: refs }) },
    ] }),
  });
  if (!response.ok) throw new Error(`채점 실패 ${response.status}`);
  return JSON.parse((await response.json()).choices[0].message.content);
}

async function runOne(item) {
  const started = Date.now();
  try {
    let result = await repo.recommendRisk({ description: item.text, process: item.process }, { diagnostics: true });
    if (result.needsClarification) result = await repo.recommendRisk({ description: item.text, process: item.process, answers: result.questions.map(q => ({ question: q.question, answer: '설명에 쓴 그대로입니다' })) }, { diagnostics: true });
    const verdict = await judge(item, result);
    const row = { id: item.id, label, ms: Date.now() - started, timing: result.timing, rerank: result.diagnostics?.rerank || null,
      queries: result.diagnostics?.queries || [], understanding: result.understanding || '',
      measures: (result.measures || []).map(m => typeof m === 'string' ? m : m.text), references: (result.references || []).map(r => r.label), verdict };
    fs.appendFileSync(out, JSON.stringify(row) + '\n');
    console.log(`${item.id} ${verdict.direct ? '직접 O' : '직접 X'}${verdict.directRank ? `(${verdict.directRank})` : ''} 맞는 대책 ${verdict.fit} · 엉뚱 근거 ${verdict.badRefs} · ${(row.timing?.totalMs / 1000).toFixed(1)}초 · ${verdict.note || ''}`.slice(0, 220));
    return row;
  } catch (error) {
    const row = { id: item.id, label, error: error.message };
    fs.appendFileSync(out, JSON.stringify(row) + '\n');
    console.log(`${item.id} 오류 ${error.message}`.slice(0, 200));
    return row;
  }
}

(async () => {
  const queue = [...cases], rows = [];
  await Promise.all(Array.from({ length: Number(option('--concurrency', 3)) }, async () => { while (queue.length) rows.push(await runOne(queue.shift())); }));
  const ok = rows.filter(row => !row.error), n = ok.length || 1;
  const mean = values => values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const stageMean = name => mean(ok.map(row => row.timing?.stages?.find(s => s.stage === name)?.ms || 0)) / 1000;
  console.log(`\n[${label}] ${ok.length}건 (오류 ${rows.length - ok.length})`);
  console.log(`직접 대책 포함 ${ok.filter(r => r.verdict.direct).length}/${ok.length} · 1~2번째 ${ok.filter(r => r.verdict.direct && r.verdict.directRank <= 2).length}/${ok.length}`);
  console.log(`맞는 대책 평균 ${mean(ok.map(r => Number(r.verdict.fit) || 0)).toFixed(2)} · 엉뚱 근거 평균 ${mean(ok.map(r => Number(r.verdict.badRefs) || 0)).toFixed(2)} · 재순위 실패 ${ok.filter(r => r.rerank?.error).length}`);
  console.log(`시간 평균 ${(mean(ok.map(r => r.timing?.totalMs || 0)) / 1000).toFixed(1)}초 (이해 ${stageMean('understand').toFixed(1)} · 검색 ${stageMean('search').toFixed(1)} · 초안 ${stageMean('draft').toFixed(1)} · 검토 ${stageMean('review').toFixed(1)}) · 결과 ${path.relative(process.cwd(), out)}`);
})();
