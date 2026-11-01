#!/usr/bin/env node
// Draft-level evidence simulation (docs/working-rules.md §2-1, §3).
// For every case in seed-assets/draft-simulation-cases.json it runs the real draft pipeline (AI search words →
// Supabase search → [semantic] → [AI selection] → draft → review) once per evidence mode and scores:
//   - expectation exists in the corpus at all (otherwise "자료 없음" → material to add)
//   - expected section among candidates / delivered to the draft / cited in the reviewed draft
//   - cited sections that match no expectation (judged afterwards with --judge)
// Usage:
//   (behind an HTTPS proxy add NODE_USE_ENV_PROXY=1)
//   OPENAI_API_KEY=... SAFETY_SUPABASE_URL=... SAFETY_SUPABASE_SERVICE_KEY=... \
//   node scripts/simulate-drafts.cjs --set A --modes words,meaning,rerank --concurrency 4 [--limit 10] [--types B01,B02]
//   node scripts/simulate-drafts.cjs --judge            # judge unexpected citations of finished runs
//   node scripts/simulate-drafts.cjs --report           # write the summary (markdown + json)
// Results are appended to local-import/simulation/runs.jsonl (not in git) so an interrupted run resumes.
const fs = require('node:fs');
const path = require('node:path');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => arg.startsWith('--')
  ? [arg.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true] : null).filter(Boolean));
const OUT = path.resolve(args.out || path.join(__dirname, '../local-import/simulation'));
const RUNS = path.join(OUT, 'runs.jsonl'), JUDGED = path.join(OUT, 'judged.jsonl');
const casesFile = require('../seed-assets/draft-simulation-cases.json');
const env = { ...process.env, SAFETY_EXTERNAL_SEARCH: 'off' };
fs.mkdirSync(OUT, { recursive: true });

const readJsonl = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const normalize = text => String(text || '').replace(/[ㆍ·]/g, '·');
const matches = (expect, item) => new RegExp(expect.t).test(normalize(item.title)) && new RegExp(expect.l).test(normalize(item.locator));

function allCases() {
  const set = String(args.set || 'all').toUpperCase(), only = args.types ? String(args.types).split(',') : null;
  const list = [];
  for (const type of casesFile.types) {
    if (only && !only.includes(type.id)) continue;
    type.cases.forEach((text, index) => {
      const caseSet = index < 2 ? 'A' : 'B';
      if (set === 'ALL' || set === caseSet) list.push({ id: `${type.id}-${index + 1}`, typeId: type.id, set: caseSet, area: type.area, hazard: type.hazard, text, expect: type.expect });
    });
  }
  return args.limit ? list.slice(0, Number(args.limit)) : list;
}

async function supabase(resource, query) {
  const base = String(env.SAFETY_SUPABASE_URL || '').replace(/\/$/, '');
  const response = await fetch(`${base}/rest/v1/${resource}${query}`, { headers: { apikey: env.SAFETY_SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SAFETY_SUPABASE_SERVICE_KEY}` } });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

// Current-version sections of approved documents (title + locator only) for the "자료 없음" check.
async function corpusIndex() {
  const cache = path.join(OUT, 'corpus-index.json');
  if (fs.existsSync(cache) && !args.refreshCorpus) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const documents = await supabase('safety_documents', '?select=id,title,source_version,review_status&review_status=eq.approved&limit=2000');
  const byId = new Map(documents.map(doc => [doc.id, doc]));
  const sections = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await supabase('safety_document_sections', `?select=id,document_id,version,locator&order=id&limit=1000&offset=${offset}`);
    sections.push(...page);
    if (page.length < 1000) break;
  }
  const index = sections.map(section => ({ section, doc: byId.get(section.document_id) }))
    .filter(({ section, doc }) => doc && (!doc.source_version || !section.version || section.version === doc.source_version))
    .map(({ section, doc }) => ({ id: section.id, title: doc.title, locator: section.locator }));
  fs.writeFileSync(cache, JSON.stringify(index));
  return index;
}

async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; await worker(item); }
  }));
}

async function run() {
  const modes = String(args.modes || 'words,meaning,rerank').split(',');
  const repo = createKnowledgeRepository(env);
  const done = new Set(readJsonl(RUNS).filter(row => !row.error).map(row => `${row.caseId}|${row.mode}`));
  // Per case: the words run extracts the search words; the other modes reuse them so only retrieval differs.
  const previous = new Map(readJsonl(RUNS).filter(row => !row.error && row.mode === 'words').map(row => [row.caseId, row.queries]));
  const cases = allCases().filter(item => modes.some(mode => !done.has(`${item.id}|${mode}`)));
  console.log(`실행할 사례 ${cases.length}건 × 방식 ${modes.length} (이미 끝난 초안 ${done.size}건 건너뜀)`);
  let finished = 0;
  const runOne = async (item, mode, queries) => {
    const started = Date.now();
    let row;
    try {
      const result = await repo.recommendRisk({ description: item.text }, { evidenceMode: mode, diagnostics: true, ...(queries ? { queries } : {}) });
      const d = result.diagnostics || {};
      const byRef = new Map((d.delivered || []).map(entry => [entry.ref, entry]));
      row = { caseId: item.id, typeId: item.typeId, set: item.set, area: item.area, mode, ms: Date.now() - started,
        status: result.status, needsClarification: Boolean(result.needsClarification), queries: d.queries || queries || [],
        candidates: d.candidates || [], delivered: d.delivered || [], rerank: d.rerank ? { kept: d.rerank.kept, candidates: d.rerank.candidates, error: d.rerank.error, dropped: d.rerank.dropped } : null,
        draftCited: (d.draftCitations || []).map(ref => byRef.get(ref) || { ref }), cited: (d.reviewedCitations || []).map(ref => byRef.get(ref) || { ref }),
        sifCited: (d.reviewedCitations || []).filter(ref => ref.startsWith('sif:')).length, measures: result.measures || [] };
    } catch (error) {
      row = { caseId: item.id, typeId: item.typeId, set: item.set, area: item.area, mode, ms: Date.now() - started, error: error.message };
    }
    fs.appendFileSync(RUNS, `${JSON.stringify(row)}\n`);
    finished += 1;
    if (finished % 10 === 0 || row.error) console.log(`${finished} ${item.id} ${mode}${row.error ? ` 오류: ${row.error}` : ''}`);
    return row;
  };
  await pool(cases, Number(args.concurrency || 4), async item => {
    let queries = previous.get(item.id);
    if (modes.includes('words') && !done.has(`${item.id}|words`)) queries = (await runOne(item, 'words')).queries;
    for (const mode of modes.filter(mode => mode !== 'words' && !done.has(`${item.id}|${mode}`))) await runOne(item, mode, queries?.length ? queries : undefined);
  });
}

// Judge cited sections that match no expectation: relevant (a valid extra ground) or irrelevant (wrong citation).
// Uses a different, larger model than the drafts so the judge does not share the draft model's blind spots.
async function judge() {
  const types = new Map(casesFile.types.map(type => [type.id, type]));
  const judged = new Set(readJsonl(JUDGED).map(row => `${row.caseId}|${row.ref}`));
  const runs = readJsonl(RUNS).filter(row => !row.error);
  const todo = new Map();
  for (const row of runs) {
    const type = types.get(row.typeId);
    for (const cite of row.cited) {
      if (!cite.ref?.startsWith('doc:') || type.expect.some(expect => matches(expect, cite))) continue;
      const key = `${row.caseId}|${cite.ref}`;
      if (!judged.has(key)) todo.set(key, { row, cite, type });
    }
  }
  console.log(`판정할 인용 ${todo.size}건`);
  const model = args.model || 'gpt-4.1';
  await pool([...todo.values()], Number(args.concurrency || 4), async ({ row, cite, type }) => {
    const id = cite.ref.slice(4);
    const [section] = await supabase('safety_document_sections', `?select=locator,body&id=eq.${encodeURIComponent(id)}`).catch(() => []);
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: '산업안전 위험성평가 근거 인용을 판정합니다. 담당자가 적은 위험 상황에 대해 인용된 조문·지침이 그 위험의 원인·의무·개선대책에 실제로 적용되는지 판단하세요. relevant: 직접 적용되는 타당한 근거. partial: 일반 원칙 수준으로만 관련. irrelevant: 대상·작업·설비가 달라 적용되지 않는 엉뚱한 인용. JSON: {"verdict":"relevant|partial|irrelevant","reason":"한 줄"}' },
        { role: 'user', content: JSON.stringify({ situation: row.caseId ? casesFile.types.find(t => t.id === row.typeId).cases[Number(row.caseId.split('-').pop()) - 1] : '', hazard: type.hazard, citation: { title: cite.title, locator: section?.locator || cite.locator, text: String(section?.body || '').slice(0, 1500) } }) },
      ] }) });
    if (!response.ok) { console.log(`판정 실패 ${response.status}`); return; }
    const verdict = JSON.parse((await response.json()).choices[0].message.content);
    fs.appendFileSync(JUDGED, `${JSON.stringify({ caseId: row.caseId, ref: cite.ref, title: cite.title, locator: cite.locator, verdict: verdict.verdict, reason: verdict.reason, model })}\n`);
  });
}

async function report() {
  const corpus = await corpusIndex();
  const types = new Map(casesFile.types.map(type => [type.id, type]));
  const runs = readJsonl(RUNS).filter(row => !row.error);
  const errors = readJsonl(RUNS).filter(row => row.error);
  const verdicts = new Map(readJsonl(JUDGED).map(row => [`${row.caseId}|${row.ref}`, row.verdict]));
  const exists = new Map();
  for (const type of casesFile.types) for (const expect of type.expect) exists.set(`${type.id}|${expect.label}`, corpus.some(item => matches(expect, item)));
  const summary = {};
  const misses = [];
  for (const row of runs) {
    const type = types.get(row.typeId);
    const key = `${row.mode}|${row.set}`;
    const s = summary[key] ||= { mode: row.mode, set: row.set, drafts: 0, expectations: 0, missingMaterial: 0, existing: 0, candidate: 0, delivered: 0, draftCited: 0, cited: 0,
      citedDocs: 0, unexpected: 0, relevant: 0, partial: 0, irrelevant: 0, unjudged: 0, reviewRequired: 0, ms: 0, byArea: {} };
    const a = s.byArea[row.area] ||= { existing: 0, delivered: 0, cited: 0, irrelevant: 0 };
    s.drafts += 1; s.ms += row.ms; if (row.status === 'review_required') s.reviewRequired += 1;
    for (const expect of type.expect) {
      s.expectations += 1;
      if (!exists.get(`${type.id}|${expect.label}`)) { s.missingMaterial += 1; misses.push({ mode: row.mode, set: row.set, caseId: row.caseId, area: row.area, label: expect.label, kind: '자료 없음' }); continue; }
      s.existing += 1; a.existing += 1;
      const inCandidates = row.candidates.some(item => matches(expect, item));
      const inDelivered = row.delivered.some(item => matches(expect, item));
      const inDraft = (row.draftCited || []).some(item => item.title && matches(expect, item));
      const inCited = row.cited.some(item => item.title && matches(expect, item));
      if (inDraft) s.draftCited += 1;
      if (inCandidates) s.candidate += 1;
      if (inDelivered) { s.delivered += 1; a.delivered += 1; }
      if (inCited) { s.cited += 1; a.cited += 1; }
      if (!inDelivered) misses.push({ mode: row.mode, set: row.set, caseId: row.caseId, area: row.area, label: expect.label,
        kind: inCandidates ? '후보에 있었으나 골라내기에서 빠짐' : '있는데 못 찾음', queries: row.queries });
      else if (!inCited) misses.push({ mode: row.mode, set: row.set, caseId: row.caseId, area: row.area, label: expect.label, kind: '전달됐으나 인용 안 함' });
    }
    for (const cite of row.cited.filter(item => item.ref?.startsWith('doc:'))) {
      s.citedDocs += 1;
      if (type.expect.some(expect => matches(expect, cite))) continue;
      s.unexpected += 1;
      const verdict = verdicts.get(`${row.caseId}|${cite.ref}`);
      if (verdict) { s[verdict] += 1; if (verdict === 'irrelevant') a.irrelevant += 1; } else s.unjudged += 1;
    }
  }
  const pct = (part, whole) => whole ? `${Math.round(part / whole * 100)}%` : '-';
  const lines = ['# 초안 시뮬레이션 결과', '', `실행 ${runs.length}건, 오류 ${errors.length}건. 기대 근거는 저장소와 무관하게 정했다(seed-assets/draft-simulation-cases.json).`, '',
    '| 방식 | 세트 | 초안 | 기대 근거 | 자료 없음 | 후보에 있음 | 초안에 전달 | 초안 인용 | 재검토 후 인용 | 기대 밖 인용 | 그중 엉뚱함 | 일반 수준 | 타당 | 미판정 | 재검토 필요 초안 | 평균 초 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const s of Object.values(summary).sort((a, b) => a.set.localeCompare(b.set) || a.mode.localeCompare(b.mode))) {
    lines.push(`| ${s.mode} | ${s.set} | ${s.drafts} | ${s.expectations} | ${s.missingMaterial} | ${s.candidate}/${s.existing} (${pct(s.candidate, s.existing)}) | ${s.delivered}/${s.existing} (${pct(s.delivered, s.existing)}) | ${s.draftCited}/${s.existing} (${pct(s.draftCited, s.existing)}) | ${s.cited}/${s.existing} (${pct(s.cited, s.existing)}) | ${s.unexpected}/${s.citedDocs} | ${s.irrelevant} | ${s.partial} | ${s.relevant} | ${s.unjudged} | ${s.reviewRequired} | ${Math.round(s.ms / s.drafts / 1000)} |`);
  }
  lines.push('', '## 업무 구역별 (초안 전달 / 인용 / 엉뚱한 인용)', '');
  const areas = [...new Set(casesFile.types.map(type => type.area))];
  const keys = Object.keys(summary).sort();
  lines.push(`| 구역 | ${keys.join(' | ')} |`, `|---|${keys.map(() => '---').join('|')}|`);
  for (const area of areas) lines.push(`| ${area} | ${keys.map(key => { const a = summary[key].byArea[area]; return a ? `${pct(a.delivered, a.existing)} / ${pct(a.cited, a.existing)} / ${a.irrelevant}` : '-'; }).join(' | ')} |`);
  const missingLabels = [...new Set(misses.filter(miss => miss.kind === '자료 없음').map(miss => `${miss.area} · ${miss.label}`))];
  lines.push('', '## 자료 없음 (보완할 자료)', '', ...missingLabels.map(label => `- ${label}`));
  const notFound = {};
  for (const miss of misses.filter(miss => miss.kind !== '자료 없음')) { const k = `${miss.mode} · ${miss.kind} · ${miss.label}`; notFound[k] = (notFound[k] || 0) + 1; }
  lines.push('', '## 있는데 못 찾음·인용 안 함 (방식별, 많은 순)', '', ...Object.entries(notFound).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, n]) => `- ${k}: ${n}건`));
  fs.writeFileSync(path.join(OUT, 'report.md'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ summary, misses, errors: errors.map(row => ({ caseId: row.caseId, mode: row.mode, error: row.error })) }, null, 1));
  console.log(lines.slice(0, 12).join('\n'));
  console.log(`\n보고서: ${path.join(OUT, 'report.md')}`);
}

(async () => {
  if (args.judge) await judge();
  else if (args.report) await report();
  else if (args.corpus) { const index = await corpusIndex(); console.log(`조문 ${index.length}건`); }
  else await run();
})().catch(error => { console.error(error); process.exitCode = 1; });
