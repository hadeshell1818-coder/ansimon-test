// Builds an idempotent Supabase SQL file for official laws/notices from law.go.kr public pages.
// Use when the Open API (LAW_API_OC) is not available. Requires Playwright with a Chromium browser.
// Usage: node scripts/prepare-official-laws-from-web.cjs [제목 ...]   (no titles: sources added for photo hazards)
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { OFFICIAL_SAFETY_SOURCES } = require('../official-law-import.cjs');

const BASE = 'https://www.law.go.kr';
const DEFAULT_TITLES = [
  '근골격계부담작업의 범위 및 유해요인조사 방법에 관한 고시',
  '위험기계·기구 방호조치 기준',
  '안전검사 고시',
  '보호구 안전인증 고시',
  '소방시설 설치 및 관리에 관한 법률',
  '화재의 예방 및 안전관리에 관한 법률',
];
const quote = value => value == null ? 'null' : `'${String(value).replace(/'/g, "''")}'`;
const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const isoDate = text => { const m = String(text).match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };

// The title page embeds the current version in an iframe; the browser shares the session's proxy settings.
async function frameUrl(page, source) {
  const kind = source.type === 'law' ? '법령' : '행정규칙';
  await page.goto(`${BASE}/${encodeURIComponent(kind)}/${encodeURIComponent(source.title.replace(/\s+/g, ''))}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const src = await page.evaluate(() => document.querySelector('iframe#lawService')?.getAttribute('src') || '');
  if (!/(lsInfoP|admRulInfoP)\.do/.test(src)) throw new Error(`${source.title}: 국가법령정보센터에서 현행 본문을 찾지 못했습니다.`);
  return new URL(src.replace('/LSW//', '/LSW/'), BASE).href;
}

async function readDocument(page, source) {
  const url = await frameUrl(page, source);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  // Large regulations fill their article blocks after the network goes idle.
  await page.waitForSelector('.lawcon', { timeout: 120000 }).catch(() => {});
  const data = await page.evaluate(() => {
    const header = (document.body.innerText.match(/\[시행[^\]]*\]\s*\[[^\]]*\]/) || [''])[0];
    const title = (document.querySelector('#conTop h2, .lawtit, h2') || {}).innerText || '';
    let chapter = '';
    const articles = [];
    // Chapter headings and article blocks are not always nested the same way; read them in document order.
    for (const node of document.querySelectorAll('.gtit, .lawcon')) {
      if (node.classList.contains('gtit')) {
        const text = node.innerText.replace(/\s+/g, ' ').trim();
        if (/^제\d+장/.test(text)) chapter = text;
      } else articles.push({ chapter, text: node.innerText });
    }
    return { header, title, articles };
  });
  const [, effective, promulgation] = data.header.match(/\[(시행[^\]]*)\]\s*\[([^\]]*)\]/) || [];
  const effectiveDate = isoDate(effective || '');
  const kindAndNumber = compact(String(promulgation || '').split(',')[0]);
  if (!effectiveDate || !kindAndNumber) throw new Error(`${source.title}: 시행일·공포번호를 읽지 못했습니다.`);
  const sections = [];
  for (const article of data.articles) {
    const lines = article.text.split('\n').map(compact).filter(Boolean);
    const locator = (lines[0]?.match(/^제\d+조(?:의\d+)?\s*\([^)]*\)/) || [])[0];
    if (!locator) continue; // deleted articles and headings without a 제N조(제목) form
    const body = lines.join('\n');
    sections.push({ locator: compact(locator), body: article.chapter && source.type !== 'law' ? `[${article.chapter}]\n${body}` : body });
  }
  // Technical standards (e.g. NFTC) number sections "2.1", "2.1.1" instead of articles; split at the second level.
  if (!sections.length) {
    let part = '', current = null;
    for (const line of data.articles.map(article => article.text).join('\n').split('\n').map(compact).filter(Boolean)) {
      const heading = line.match(/^(\d+)\.\s+(\S.*)$/), sub = line.match(/^(\d+\.\d+)\s+(\S.*)$/);
      if (heading) { part = `${heading[1]}. ${heading[2]}`; continue; }
      if (sub) { current = { locator: compact(`${sub[1]} ${sub[2]}`).slice(0, 180), lines: part ? [`[${part}]`, line] : [line] }; sections.push(current); continue; }
      if (current) current.lines.push(line);
    }
    for (const section of sections) { section.body = section.lines.join('\n'); delete section.lines; }
  }
  // Same locator uniqueness rule as the API importer.
  const counts = new Map();
  for (const section of sections) {
    const count = (counts.get(section.locator) || 0) + 1;
    counts.set(section.locator, count);
    if (count > 1) section.locator = `${section.locator} · ${count}`;
  }
  if (!sections.length) throw new Error(`${source.title}: 조문을 추출하지 못했습니다.`);
  const admRulSeq = new URL(url).searchParams.get('admRulSeq');
  const isLaw = source.type === 'law';
  return {
    metadata: {
      title: source.title,
      source_url: isLaw ? `${BASE}/법령/${encodeURIComponent(source.title)}` : `${BASE}/LSW/admRulInfoP.do?admRulSeq=${encodeURIComponent(admRulSeq)}`,
      publisher: isLaw ? '법제처 국가법령정보센터' : '고용노동부 · 법제처 국가법령정보센터',
      category: source.category,
      kind: isLaw ? 'law' : 'guideline',
      tags: source.tags,
      effective_from: effectiveDate,
      source_version: `${kindAndNumber.replace(/\s*(제[\d-]+호)/, ' $1')} · 시행 ${effectiveDate}`,
    },
    sections: sections.map(section => ({ ...section, content_hash: crypto.createHash('sha256').update(section.body).digest('hex') })),
  };
}

// Plain statements only: the Supabase SQL editor cuts very long pasted lines, which broke dollar-quoted blocks.
// One article per line, 40 articles per insert, and each output file stays under MAX_FILE_BYTES.
const MAX_FILE_BYTES = 300000;
const CHUNK = 40;
function documentStatements({ metadata, sections }) {
  const url = quote(metadata.source_url), version = quote(metadata.source_version);
  const head = `-- ${metadata.title} · ${metadata.source_version} · 조문 ${sections.length}개
insert into public.safety_documents (
  title, source_url, publisher, category, kind, tags, jurisdiction, rights_note, source_group,
  review_status, content_use_allowed, effective_from, effective_until, source_version, checked_at, reviewed_by, created_by
) values (
  ${quote(metadata.title)}, ${url}, ${quote(metadata.publisher)}, ${quote(metadata.category)}, ${quote(metadata.kind)},
  array[${metadata.tags.map(quote).join(', ')}]::text[], '대한민국',
  '국가법령정보센터 공식 공개 원문. 실제 적용 전 시행일과 개정 여부를 공식 원문에서 다시 확인', 'PUBLIC',
  'approved', true, ${quote(metadata.effective_from)}, null, ${version}, now(), '공식 원문 확인 · 웹 원문 적재', 'official-law-web-import'
)
on conflict (source_url) do update set
  title = excluded.title, publisher = excluded.publisher, category = excluded.category, kind = excluded.kind,
  tags = excluded.tags, rights_note = excluded.rights_note, review_status = 'approved', content_use_allowed = true,
  effective_from = excluded.effective_from, source_version = excluded.source_version, checked_at = now(), reviewed_by = excluded.reviewed_by;
`;
  const inserts = [];
  for (let index = 0; index < sections.length; index += CHUNK) {
    const rows = sections.slice(index, index + CHUNK).map(section => `  (${quote(section.locator)}, ${quote(section.body)}, ${quote(section.content_hash)})`);
    inserts.push(`insert into public.safety_document_sections (document_id, version, locator, body, content_hash)
select d.id, ${version}, item.locator, item.body, item.content_hash
from public.safety_documents d, (values
${rows.join(',\n')}
) as item(locator, body, content_hash)
where d.source_url = ${url}
on conflict (document_id, version, locator) do update set body = excluded.body, content_hash = excluded.content_hash;
`);
  }
  // Superseded versions would otherwise be searched next to the current text; keep rows cited by assessments.
  const cleanup = `delete from public.safety_document_sections s
using public.safety_documents d
where d.id = s.document_id and d.source_url = ${url} and s.version <> ${version}
  and not exists (select 1 from public.safety_assessment_evidence e where e.section_id = s.id);
`;
  return [head, ...inserts, cleanup];
}

// Splits statements into files of at most MAX_FILE_BYTES; a large document continues in the next file.
function writeSqlFiles(documents, outPath) {
  const parts = [[]];
  let size = 0;
  for (const statement of documents.flatMap(documentStatements)) {
    const bytes = Buffer.byteLength(statement);
    if (size + bytes > MAX_FILE_BYTES && parts.at(-1).length) { parts.push([]); size = 0; }
    parts.at(-1).push(statement); size += bytes;
  }
  const base = outPath.replace(/\.sql$/, '');
  return parts.map((statements, index) => {
    const file = parts.length === 1 ? outPath : `${base}-${String(index + 1).padStart(2, '0')}.sql`;
    const note = parts.length === 1 ? '' : ` · ${index + 1}/${parts.length} (번호 순서대로 실행)`;
    fs.writeFileSync(file, `-- 국가법령정보센터 공개 원문${note}. 다시 실행해도 같은 자료·조문을 갱신합니다.\nbegin;\n\n${statements.join('\n')}\ncommit;\n`);
    return file;
  });
}

// Rebuilds documents from SQL files written by earlier versions of this script (no re-download).
function documentsFromSql(text) {
  const documents = [];
  for (const block of text.split(/\n(?=-- .+ · 조문 \d+개\n)/)) {
    const title = (block.match(/^-- (.+?) · /) || [])[1];
    const values = block.match(/\) values \(\n\s*'((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)',\n\s*array\[(.*?)\]::text\[\][\s\S]*?'approved', true, '([\d-]+)', null, '((?:[^']|'')*)'/);
    const json = block.match(/jsonb_to_recordset\('((?:[^']|'')*)'::jsonb\)/);
    if (!title || !values || !json) continue;
    const unquote = value => value.replace(/''/g, "'");
    documents.push({
      metadata: { title: unquote(values[1]), source_url: unquote(values[2]), publisher: unquote(values[3]), category: values[4], kind: values[5],
        tags: [...values[6].matchAll(/'((?:[^']|'')*)'/g)].map(m => unquote(m[1])), effective_from: values[7], source_version: unquote(values[8]) },
      sections: JSON.parse(unquote(json[1])).map(({ locator, body, content_hash }) => ({ locator, body, content_hash })),
    });
  }
  return documents;
}

async function main() {
  if (process.argv[2] === '--from-sql') {
    const documents = process.argv.slice(3).flatMap(file => documentsFromSql(fs.readFileSync(file, 'utf8')));
    if (!documents.length) throw new Error('변환할 자료를 찾지 못했습니다.');
    const out = path.resolve(__dirname, '../local-import', process.env.OUT_FILE || 'approved-official-laws.sql');
    for (const file of writeSqlFiles(documents, out)) console.log(file);
    console.log(`자료 ${documents.length}종 · 조문 ${documents.reduce((sum, doc) => sum + doc.sections.length, 0)}개`);
    return;
  }
  const titles = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TITLES;
  const sources = titles.map(title => {
    const source = OFFICIAL_SAFETY_SOURCES.find(item => item.title === title);
    if (!source) throw new Error(`적재 목록에 없는 자료입니다: ${title}`);
    return source;
  });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const documents = [], failures = [];
  try {
    for (const source of sources) {
      // law.go.kr occasionally serves a partly rendered page; retry before giving up.
      let document, lastError;
      for (let attempt = 1; attempt <= 3 && !document; attempt++) {
        try { document = await readDocument(page, source); }
        catch (error) { lastError = error; console.error(`${source.title}: 재시도 ${attempt}/3 · ${error.message}`); }
      }
      if (!document) { failures.push(`${source.title}: ${lastError.message}`); continue; }
      console.log(`${document.metadata.title} · ${document.metadata.source_version} · 조문 ${document.sections.length}개`);
      documents.push(document);
    }
  } finally { await browser.close(); }
  // Like the in-app import, keep what succeeded and report what did not.
  if (failures.length) console.error(`적재하지 못한 자료 ${failures.length}종\n${failures.join('\n')}`);
  if (!documents.length) { process.exitCode = 1; return; }
  const outDir = path.resolve(__dirname, '../local-import');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, process.env.OUT_FILE || 'approved-official-laws.sql');
  for (const file of writeSqlFiles(documents, out)) console.log(file);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
