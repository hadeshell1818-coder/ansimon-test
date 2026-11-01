#!/usr/bin/env node
// Sector simulation built from the 장흥우체국 risk assessment and the postal checklist items already in Supabase
// ("우체국 작업 위험요인 및 개선대책 검색자료": 15 work sectors + 장흥 28 items). Each checklist item ("…위험이 있는가?")
// is the answer the improvement measures must address, so cases are written from the items and scored on:
//   stage ② – the source checklist item within the top results, and a directly applicable statute in the top 6
//            (judged by a larger model than the drafts).
// Case texts are written by gpt-4.1 (not the draft model, not the agent) in two styles: the 장흥 assessment's short
// noun-phrase hazard wording (set A) and a colloquial field memo (set B). The data is internal, so cases and results
// stay in local-import/ (not in git).
// Usage (behind a proxy add NODE_USE_ENV_PROXY=1):
//   node scripts/simulate-sectors.cjs --build [--per 8]      write local-import/simulation/sectors/cases.json
//   node scripts/simulate-sectors.cjs --extract              AI search words per case (stage ①, about 1 KRW each)
//   node scripts/simulate-sectors.cjs --rank [--semantic] [--refine] [--tag name]   stage ② retrieval (no drafts)
//   node scripts/simulate-sectors.cjs --judge --tag name     statute relevance of the top 6
//   node scripts/simulate-sectors.cjs --report               per-sector tables for every tag
const fs = require('node:fs');
const path = require('node:path');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => arg.startsWith('--')
  ? [arg.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true] : null).filter(Boolean));
const OUT = path.join(__dirname, '../local-import/simulation/sectors');
fs.mkdirSync(OUT, { recursive: true });
const CASES = path.join(OUT, 'cases.json');
const env = { ...process.env, SAFETY_EXTERNAL_SEARCH: 'off' };
const repo = createKnowledgeRepository(env);
const readJsonl = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const POSTAL_TITLE = '우체국 작업 위험요인 및 개선대책 검색자료';
// 장흥 assessment groups mapped onto the finer work sectors of the checklist.
const JANGHEUNG_SECTOR = { '장흥우체국 청사·사무실': '청사·사무실·출퇴근', '장흥우체국 집배·차량 운행': '집배업무', '장흥우체국 소포·우편물 취급': '소포공급작업',
  '장흥우체국 청사관리·시설보수': '청사관리·설비보수·점검', '장흥우체국 소방·비상대응': '밀폐공간작업·응급상황', '장흥우체국 근골격계·건강관리': '근골격계부담·기타 작업', '장흥우체국 청소·경비업무': '청소·경비업무' };

async function supabase(resource, query) {
  const base = String(env.SAFETY_SUPABASE_URL || '').replace(/\/$/, '');
  const response = await fetch(`${base}/rest/v1/${resource}${query}`, { headers: { apikey: env.SAFETY_SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SAFETY_SUPABASE_SERVICE_KEY}` } });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}
async function chat(model, system, user) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0.7, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }] }) });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return JSON.parse((await response.json()).choices[0].message.content);
}
async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const item = items[next++]; await worker(item); } }));
}
const field = (body, name) => (String(body).match(new RegExp(`${name}:\\s*(.+)`)) || [])[1]?.trim() || '';

async function build() {
  const [doc] = await supabase('safety_documents', `?select=id&title=eq.${encodeURIComponent(POSTAL_TITLE)}`);
  const sections = await supabase('safety_document_sections', `?select=id,locator,body&document_id=eq.${doc.id}&limit=2000`);
  const items = sections.map(section => {
    const parts = section.locator.split(' · ');
    const jangheung = parts[0] === '장흥우체국 위험성평가';
    return { sectionId: section.id, sector: jangheung ? JANGHEUNG_SECTOR[parts[1]] || parts[1] : parts[1], group: parts[0], jangheung,
      check: field(section.body, '점검 항목'), hazard: field(section.body, '유해·위험요인'), accident: field(section.body, '예상 사고 형태'), measure: field(section.body, '개선대책') };
  }).filter(item => item.check && item.sector);
  // Seeded order so the same items are picked on every build; 장흥 items first in each sector.
  const hash = text => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const perSector = Number(args.per || 8), bySector = new Map();
  for (const item of items) (bySector.get(item.sector) || bySector.set(item.sector, []).get(item.sector)).push(item);
  const picked = [...bySector.values()].flatMap(list => list.sort((a, b) => Number(b.jangheung) - Number(a.jangheung) || hash(a.sectionId) - hash(b.sectionId)).slice(0, perSector));
  const examples = items.filter(item => item.jangheung).slice(0, 8).map(item => item.hazard);
  const system = '우체국 안전보건 담당자가 위험성평가표의 유해·위험요인 칸에 적거나 현장에서 메모할 문장을 만듭니다. 주어진 점검 항목이 가리키는 위험 상황을 담당자 입장에서 묘사하되, 점검 항목의 문구를 그대로 베끼지 말고 현장 단어(설비·장소·동작 이름)로 바꾸세요. 법령 용어(전도, 협착, 중량물, 추락의 방지 등)는 쓰지 마세요. hazardStyle: 장흥우체국 평가서처럼 짧은 명사형(10~25자, 예시 참고). memoStyle: 담당자가 휴대폰으로 급히 적은 구어체 한 문장(15~40자, 줄임말·띄어쓰기 실수 허용). JSON: {"hazardStyle":"...","memoStyle":"..."}';
  const cases = [];
  await pool(picked, 6, async item => {
    const written = await chat('gpt-4.1', system, { sector: item.sector, checkItem: item.check, hazard: item.hazard, accident: item.accident, styleExamples: examples });
    cases.push({ ...item, A: String(written.hazardStyle || '').trim(), B: String(written.memoStyle || '').trim() });
  });
  cases.sort((a, b) => a.sector.localeCompare(b.sector) || a.sectionId.localeCompare(b.sectionId));
  fs.writeFileSync(CASES, JSON.stringify({ built: new Date().toISOString(), perSector, total: cases.length, cases }, null, 1));
  console.log(`사례 ${cases.length}건 (섹터 ${bySector.size}개 × 최대 ${perSector}), 세트 A·B 각 ${cases.length}문장 → ${CASES}`);
}

function allRuns() {
  const { cases } = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  return cases.flatMap((item, index) => ['A', 'B'].map(set => ({ id: `S${index + 1}-${set}`, set, text: item[set], item })));
}

async function extract() {
  const file = path.join(OUT, 'queries.jsonl');
  const done = new Set(readJsonl(file).map(row => row.id));
  const todo = allRuns().filter(run => !done.has(run.id));
  await pool(todo, 6, async run => {
    const queries = await repo.extractQueries(run.text).catch(error => ({ error: error.message }));
    fs.appendFileSync(file, `${JSON.stringify({ id: run.id, ...(Array.isArray(queries) ? { queries } : queries) })}\n`);
  });
  console.log(`검색어 ${todo.length}건 추출`);
}

async function rank() {
  const tag = args.tag || ['words', args.semantic && 'semantic', args.refine && 'refine'].filter(Boolean).join('+');
  const file = path.join(OUT, `rank-${tag}.jsonl`);
  const queries = new Map(readJsonl(path.join(OUT, 'queries.jsonl')).filter(row => row.queries).map(row => [row.id, row.queries]));
  const done = new Set(readJsonl(file).map(row => row.id));
  const todo = allRuns().filter(run => queries.has(run.id) && !done.has(run.id));
  await pool(todo, Number(args.concurrency || 4), async run => {
    try {
      const ranked = await repo.rankEvidence(queries.get(run.id), { ...(args.semantic ? { semanticText: run.text } : {}), ...(args.refine ? { refineFor: run.text } : {}) });
      const laws = ranked.filter(item => item.kind === 'law'), guides = ranked.filter(item => item.kind !== 'law');
      const position = guides.findIndex(item => item.ref === `doc:${run.item.sectionId}`);
      fs.appendFileSync(file, `${JSON.stringify({ id: run.id, set: run.set, sector: run.item.sector, checklistRank: position, guides: guides.length, laws: laws.slice(0, 6) })}\n`);
    } catch (error) { console.log(`${run.id} 실패: ${error.message.slice(0, 100)}`); }
  });
  console.log(`${tag}: ${todo.length}건 순위 계산`);
}

// One call per case: which of the top-6 statutes directly applies to the reported hazard.
async function judge() {
  const tag = args.tag || 'words';
  const file = path.join(OUT, `judge-${tag}.jsonl`), runs = new Map(allRuns().map(run => [run.id, run]));
  const done = new Set(readJsonl(file).map(row => row.id));
  const todo = readJsonl(path.join(OUT, `rank-${tag}.jsonl`)).filter(row => !done.has(row.id) && row.laws.length);
  await pool(todo, 6, async row => {
    const run = runs.get(row.id);
    const sections = await Promise.all(row.laws.map(law => supabase('safety_document_sections', `?select=body&id=eq.${law.ref.slice(4)}`).then(r => r[0]?.body || '').catch(() => '')));
    const verdict = await chat('gpt-4.1', '산업안전 위험성평가의 법령 근거를 판정합니다. 담당자가 적은 위험 상황과 점검 항목에 대해 후보 조문 중 그 위험의 원인·의무·개선대책에 직접 적용되는 것의 번호만 고르세요. 일반 원칙 수준(예: 사업주의 일반 안전조치 의무)만 맞는 것은 general에, 대상·작업·설비가 다른 것은 고르지 마세요. JSON: {"direct":[번호],"general":[번호]}',
      { situation: run.text, checkItem: run.item.check, candidates: row.laws.map((law, index) => ({ no: index + 1, title: law.title, locator: law.locator, text: sections[index].slice(0, 700) })) }).catch(error => ({ error: error.message }));
    fs.appendFileSync(file, `${JSON.stringify({ id: row.id, direct: verdict.direct || [], general: verdict.general || [], error: verdict.error })}\n`);
  });
  console.log(`${tag}: ${todo.length}건 판정`);
}

function report() {
  const tags = fs.readdirSync(OUT).filter(name => name.startsWith('rank-')).map(name => name.slice(5, -6));
  const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : '-';
  const lines = ['# 섹터별 시뮬레이션 (② 후보 검색)', '', '점검 항목 = 개선대책이 해결해야 할 답. 사례 문장은 gpt-4.1이 점검 항목에서 담당자 말투로 작성(A: 장흥 평가서 유해요인 말투, B: 현장 메모 말투).', ''];
  for (const tag of tags) {
    const rows = readJsonl(path.join(OUT, `rank-${tag}.jsonl`));
    const judged = new Map(readJsonl(path.join(OUT, `judge-${tag}.jsonl`)).map(row => [row.id, row]));
    const stat = (list) => ({ n: list.length, top4: list.filter(r => r.checklistRank >= 0 && r.checklistRank < 2).length, top10: list.filter(r => r.checklistRank >= 0 && r.checklistRank < 4).length,
      any: list.filter(r => r.checklistRank >= 0).length, judged: list.filter(r => judged.has(r.id)).length,
      law2: list.filter(r => (judged.get(r.id)?.direct || []).some(no => no <= 2)).length, law6: list.filter(r => (judged.get(r.id)?.direct || []).length).length });
    lines.push(`## ${tag}`, '', '| 섹터 | 세트 | 사례 | 점검항목 상위4(지침 2칸) | 상위10(지침 4칸) | 후보 전체 | 직접 적용 법령 상위2 | 상위6 |', '|---|---|---|---|---|---|---|---|');
    const sectors = [...new Set(rows.map(r => r.sector))].sort();
    for (const set of ['A', 'B']) {
      for (const sector of [...sectors, '전체']) {
        const list = rows.filter(r => r.set === set && (sector === '전체' || r.sector === sector));
        const s = stat(list);
        lines.push(`| ${sector === '전체' ? '**전체**' : sector} | ${set} | ${s.n} | ${pct(s.top4, s.n)} | ${pct(s.top10, s.n)} | ${pct(s.any, s.n)} | ${s.judged ? pct(s.law2, s.judged) : '-'} | ${s.judged ? pct(s.law6, s.judged) : '-'} |`);
      }
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

(async () => {
  if (args.build) await build();
  else if (args.extract) await extract();
  else if (args.rank) await rank();
  else if (args.judge) await judge();
  else if (args.report) report();
})().catch(error => { console.error(error); process.exitCode = 1; });
