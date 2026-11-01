#!/usr/bin/env node
// Stage ③ comparison on saved candidate pools (simulate-drafts.cjs --replay ... --dump-pool FILE):
//   --judge   judge every pool item once (gpt-4.1-mini, chunks of 25) → <pool>.judged.jsonl
//   --score   compare orders: search order vs. reranker order(s) given as --order name=file.jsonl ({caseId, order:[refs]})
// An item counts as right when it matches the case's expected grounds or the judge marked it directly applicable.
// Top 4 = 2 statutes + 2 guides, top 10 = 6 + 4, as shown to the safety officer.
// Usage: NODE_USE_ENV_PROXY=1 OPENAI_API_KEY=... node scripts/rerank-eval.cjs --pool local-import/simulation/pools.jsonl --judge
//        node scripts/rerank-eval.cjs --pool local-import/simulation/pools.jsonl --score --order bge=local-import/simulation/bge-order.jsonl
const fs = require('node:fs');
const path = require('node:path');
const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => arg.startsWith('--')
  ? [arg.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true] : null).filter(Boolean));
const orders = process.argv.slice(2).flatMap((arg, index, all) => arg === '--order' ? [all[index + 1]] : []);
const readJsonl = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const poolFile = path.resolve(args.pool), judgedFile = poolFile.replace(/\.jsonl$/, '.judged.jsonl');
const pools = readJsonl(poolFile);
const cases = require('../seed-assets/draft-simulation-cases.json');
const types = new Map(cases.types.map(type => [type.id, type]));
const normalize = text => String(text || '').replace(/[ㆍ·]/g, '·');
const matches = (expect, item) => new RegExp(expect.t).test(normalize(item.title)) && new RegExp(expect.l).test(normalize(item.locator));

async function judge() {
  const done = new Set(readJsonl(judgedFile).map(row => row.caseId));
  const todo = pools.filter(pool => !done.has(pool.caseId));
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < todo.length) {
      const pool = todo[next++], direct = [];
      for (let start = 0; start < pool.items.length; start += 25) {
        const chunk = pool.items.slice(start, start + 25);
        const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model: args.model || 'gpt-4.1-mini', temperature: 0, response_format: { type: 'json_object' }, messages: [
            { role: 'system', content: '산업안전 위험성평가 근거를 판정합니다. 담당자가 적은 위험 상황에 대해 후보 조문·지침 중 그 위험의 원인·의무·개선대책에 직접 적용되는 것의 번호만 고르세요. 일반 원칙 수준만 맞거나 대상·작업·설비가 다른 것은 고르지 마세요. JSON: {"direct":[번호]}' },
            { role: 'user', content: JSON.stringify({ situation: pool.text, candidates: chunk.map((item, index) => ({ no: index + 1, title: item.title, locator: item.locator, text: String(item.body || '').slice(0, 500) })) }) },
          ] }) }).catch(() => null);
        if (!response?.ok) { console.log(`판정 실패 ${pool.caseId}`); continue; }
        const verdict = JSON.parse((await response.json()).choices[0].message.content);
        for (const no of Array.isArray(verdict.direct) ? verdict.direct : []) if (chunk[Number(no) - 1]) direct.push(chunk[Number(no) - 1].ref);
      }
      fs.appendFileSync(judgedFile, `${JSON.stringify({ caseId: pool.caseId, direct })}\n`);
    }
  }));
  console.log(`판정 ${todo.length}건`);
}

function score() {
  const judged = new Map(readJsonl(judgedFile).map(row => [row.caseId, new Set(row.direct)]));
  const variants = [['검색 순서', null], ...orders.map(spec => { const [name, file] = spec.split('='); return [name, new Map(readJsonl(path.resolve(file)).map(row => [row.caseId, row.order]))]; })];
  const lines = [];
  for (const [name, orderMap] of variants) {
    const tally = {};
    for (const pool of pools) {
      // Only cases every order covers, so a partly finished reranker run is compared on the same cases.
      if (!judged.has(pool.caseId) || variants.some(([, map]) => map && !map.has(pool.caseId))) continue;
      const expects = types.get(pool.typeId).expect;
      const right = item => judged.get(pool.caseId).has(item.ref) || expects.some(expect => matches(expect, item));
      const byRef = new Map(pool.items.map(item => [item.ref, item]));
      const ordered = orderMap ? (orderMap.get(pool.caseId) || []).map(ref => byRef.get(ref)).filter(Boolean) : pool.items;
      const laws = ordered.filter(item => item.kind === 'law'), guides = ordered.filter(item => item.kind !== 'law');
      const top4 = [...laws.slice(0, 2), ...guides.slice(0, 2)], top10 = [...laws.slice(0, 6), ...guides.slice(0, 4)];
      const t = tally[pool.set] ||= { cases: 0, any: 0, ok4: 0, ok10: 0, law2: 0, law6: 0, right4: 0 };
      t.cases += 1;
      if (pool.items.some(right)) t.any += 1;
      if (top4.some(right)) t.ok4 += 1;
      if (top10.some(right)) t.ok10 += 1;
      if (laws.slice(0, 2).some(right)) t.law2 += 1;
      if (laws.slice(0, 6).some(right)) t.law6 += 1;
      t.right4 += top4.filter(right).length;
    }
    const pct = (a, b) => `${Math.round(a / b * 100)}%`;
    for (const [set, t] of Object.entries(tally).sort()) lines.push(`| ${name} | ${set} | ${t.cases} | ${pct(t.any, t.cases)} | ${pct(t.ok4, t.cases)} | ${pct(t.ok10, t.cases)} | ${pct(t.law2, t.cases)} | ${pct(t.law6, t.cases)} | ${(t.right4 / t.cases).toFixed(2)} |`);
  }
  const table = ['| 순서 | 세트 | 사례 | 후보 안 맞는 근거 | 상위4 | 상위10 | 법령 상위2 | 법령 상위6 | 상위4 중 맞는 개수(평균) |', '|---|---|---|---|---|---|---|---|---|', ...lines].join('\n');
  console.log(table);
  if (args.out) fs.writeFileSync(path.resolve(args.out), `${table}\n`);
}

(async () => { if (args.judge) await judge(); if (args.score) score(); })().catch(error => { console.error(error); process.exitCode = 1; });
