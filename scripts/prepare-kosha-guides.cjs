#!/usr/bin/env node
// Builds Supabase SQL for selected KOSHA GUIDEs (한국산업안전보건공단 기술지원규정) from the public
// 산업안전포털 (portal.kosha.or.kr): current list → PDF download → text → numbered sections.
// Needs curl and pdftotext (poppler-utils). Node fetch ignores the HTTPS proxy, so downloads use curl.
//   node scripts/prepare-kosha-guides.cjs [out.sql]        (default local-import/kosha/kosha-guides.sql)
//   KOSHA_PDF_DIR=folder reuses PDFs already downloaded there; KOSHA_ONLY=번호,번호 limits the run to those guides.
// Scanned (image-only) PDFs have no extractable text; they are reported and skipped, never guessed.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PORTAL = 'https://portal.kosha.or.kr';
// Guides for post-office facilities and work: floors/stairs/ladders, storage and handling, conveyors and
// vehicles, electrical, fire and emergency, lighting/ventilation/office, PPE, heat/cold, work at height.
const KOSHA_GUIDES = [
  ['A-G-2-2025', 'general', ['통로', '계단', '경사로', '발판사다리']], ['A-G-4-2025', 'general', ['이동식 사다리', '추락']],
  ['B-M-1-2025', 'general', ['고정식 사다리']], ['G-11-2017', 'general', ['넘어짐', '미끄러짐', '걸림']],
  ['M-59-2012', 'general', ['넘어짐', '서비스업', '위험성평가']], ['M-60-2012', 'general', ['미끄러짐', '바닥']],
  ['M-139-2012', 'general', ['미끄러짐', '바닥재']], ['A-G-9-2025', 'general', ['창고', '적재']],
  ['M-49-2023', 'general', ['적재', '하역']], ['A-G-17-2026', 'musculoskeletal', ['인력운반', '중량물', '소포']],
  ['E-G-1-2025', 'musculoskeletal', ['근골격계']], ['E-G-4-2025', 'musculoskeletal', ['근골격계', '업종별']],
  ['B-M-33-2026', 'general', ['컨베이어', '끼임']], ['B-M-11-2025', 'general', ['지게차']],
  ['G-10-2023', 'general', ['운반차량', '구내 운행']], ['G-90-2015', 'general', ['운반구', '대차', '롤테이너']],
  ['B-M-25-2026', 'general', ['잠금장치', '표지', '정비']], ['B-M-37-2026', 'general', ['끼임', '회전기계']],
  ['B-M-16-2026', 'general', ['기계식 주차장치']], ['B-E-12-2026', 'general', ['전기작업']],
  ['B-E-14-2026', 'general', ['누전차단기', '감전']], ['B-E-16-2026', 'general', ['전기설비', '정비']],
  ['B-E-4-2025', 'general', ['코드', '접속기구', '멀티탭']], ['B-E-9-2026', 'general', ['접지']],
  ['B-E-5-2025', 'general', ['비상전원']], ['B-E-19-2026', 'general', ['피뢰설비', '건축물']],
  ['E-100-2021', 'general', ['저압', '감전']], ['E-31-2014', 'general', ['배선기구', '콘센트']],
  ['E-57-2020', 'general', ['배선용차단기', '분전반']], ['E-77-2015', 'general', ['휴대 전기기기']],
  ['E-85-2017', 'general', ['전기설비 설치']], ['E-139-2013', 'general', ['비상조명', '유도등']],
  ['E-140-2013', 'general', ['비상조명', '배터리']], ['E-185-2021', 'general', ['리튬이온', '에너지저장장치', '배터리']],
  ['A-G-15-2026', 'general', ['비상조치계획', '중소규모']], ['C-C-55-2026', 'general', ['비상조치계획']],
  ['A-G-14-2026', 'general', ['용접', '화재예방']], ['G-125-2017', 'general', ['지진', '비상대응']],
  ['P-25-2012', 'general', ['방화벽', '화재']], ['P-63-2012', 'general', ['공기조화', '환기설비']],
  ['A-G-16-2026', 'general', ['조명기구']], ['G-26-2013', 'general', ['조명']],
  ['G-36-2012', 'general', ['안전보건표지']], ['A-G-12-2026', 'general', ['보호구']],
  ['E-G-3-2025', 'general', ['영상표시단말기', '사무환경']], ['E-G-6-2025', 'general', ['사무환경']],
  ['E-G-21-2026', 'general', ['환기설비']], ['E-G-20-2026', 'general', ['석면조사', '건축물']],
  ['H-178-2022', 'general', ['휴게시설']], ['H-25-2011', 'general', ['청소', '건물']],
  ['W-17-2015', 'weather', ['한랭']], ['X-9-2012', 'weather', ['온열', '폭염']],
  ['G-44-2011', 'general', ['수공구']], ['M-155-2023', 'general', ['고소작업대']],
  ['X-44-2016', 'general', ['고소작업대']], ['G-101-2013', 'general', ['차량 적재함', '떨어짐']],
  ['G-67-2011', 'general', ['외벽 청소']], ['A-G-1-2025', 'general', ['추락방호망']],
  ['D-C-14-2026', 'general', ['승강로', '엘리베이터']], ['A-G-19-2026', 'general', ['고시인성', '표시']],
  ['E-G-18-2026', 'general', ['밀폐공간', '정화조', '맨홀', '산소결핍']], ['X-68-2015', 'general', ['밀폐공간', '위험관리']],
  ['A-G-10-2025', 'general', ['급식실', '구내식당', '주방']], ['A-G-6-2025', 'general', ['급식실', '조리', '화상', '미끄러짐']],
  // 2026-11-01 simulation gaps (motorcycles, kitchens, batteries, forklifts, warehouses, trucks, customer stress, gas).
  ['A-G-3-2025', 'general', ['오토바이', '이륜차', '배달', '집배']], ['A-G-5-2025', 'general', ['조리도구', '칼', '구내식당']],
  ['H-26-2020', 'general', ['조리', '급식', '화상']], ['W-26-2023', 'general', ['급식', '환기', '주방']],
  ['E-10-2013', 'general', ['축전지', '배터리', '충전']], ['G-100-2013', 'general', ['지게차', '운전자 교육']],
  ['X-66-2013', 'general', ['물류', '창고', '위험성평가']], ['H-221-2023', 'general', ['물류센터', '공기질', '먼지']],
  ['C-114-2020', 'general', ['화물자동차', '적재함', '상하차']], ['H-163-2021', 'general', ['감정노동', '고객응대', '창구']],
  ['H-203-2018', 'general', ['고객응대', '폭언', '창구']], ['E-G-2-2025', 'general', ['직무스트레스']],
  ['E-G-5-2025', 'general', ['직무스트레스', '업종별']], ['H-91-2021', 'general', ['피로', '과로']],
  ['H-47-2021', 'general', ['장시간 근로', '과로']], ['C-C-87-2026', 'general', ['가스누출', '경보기', '보일러']],
];
const MAX_FILE_BYTES = 300000, CHUNK = 40, MAX_SECTION = 6000;
const quote = value => `'${String(value).replace(/'/g, "''")}'`;

function curl(args) { return execFileSync('curl', ['-sS', '--retry', '3', '--retry-all-errors', '-m', '120', ...args], { maxBuffer: 64 << 20 }); }
function post(api, body) { return JSON.parse(curl(['-X', 'POST', `${PORTAL}${api}`, '-H', 'Content-Type: application/json', '-d', JSON.stringify(body)]).toString()); }

function guideList() {
  return post('/api/portal24/bizV/p/VCPDG08009/selectList', { techGdlnCtgryCd: '', techGdlnSttsSeCdIng: '1', techGdlnSttsSeCdDel: '0', startDt: null, endDt: null, searchType: 'all', searchVal: null, page: 1, rowsPerPage: '2000' }).payload.list;
}

function downloadPdf(guide, dir) {
  const files = post('/api/portal24/bizA/p/files/getFileList', { fileId: guide.techGdlnOrgnlAtcflNo, fileUploadType: '02', atcflTaskColNm: 'onlyPDF', atcflSeTaskComCdNm: 'Y' }).payload || [];
  const file = files.find(item => String(item.atcflExtnNm).toLowerCase() === 'pdf');
  if (!file) throw Error('PDF 첨부 없음');
  const url = `${PORTAL}/api/portal24/bizA/p/files/downloadAtchFile?atcflNo=${file.atcflNo}&atcflSeq=${file.atcflSeq}&isDirect=N&taskSeCd=undefined`;
  const out = path.join(dir, `${guide.techGdlnNo}.pdf`);
  const cached = fs.existsSync(out) && fs.readFileSync(out).subarray(0, 4).toString() === '%PDF';
  if (!cached) fs.writeFileSync(out, curl([url]));
  if (fs.readFileSync(out).subarray(0, 4).toString() !== '%PDF') throw Error('PDF가 아닌 응답');
  return { out, url };
}

// Removes running headers/footers and joins the body into lines.
function cleanLines(text, number) {
  const compactNumber = number.replace(/[\s-–]/g, '');
  return text.replace(/\f/g, '\n').split('\n').map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line && line !== 'KOSHA GUIDE' && line.replace(/[\s-–]/g, '') !== compactNumber && !/^-\s*\d+\s*-$/.test(line));
}

// Splits "1. 목적", "4. 제목" and "4.2 제목" headings; numbers must run in order so quoted law items
// ("1. 견고한 구조로 할 것") are not mistaken for headings. Text after the last heading stays in it.
function guideSections(lines) {
  // Some PDFs put a heading number on its own line ("1." / "목적"); join it with the short title line after it.
  lines = lines.reduce((joined, line) => {
    const previous = joined.at(-1);
    if (previous && /^\d{1,2}\.$/.test(previous) && line.length <= 20) joined[joined.length - 1] = `${previous} ${line}`;
    else joined.push(line);
    return joined;
  }, []);
  // Older PDFs split spaced headings ("1. 목" / "적"); anchor on the body's "2. 적용범위" (not the
  // dotted table of contents) and step back to the "1." heading before it.
  const scope = lines.findIndex(line => /^2\.\s*적\s*용\s*범\s*위$/.test(line));
  let start = scope > 0 ? lines.slice(0, scope).findLastIndex(line => /^1\.\s*목/.test(line)) : -1;
  if (start < 0) start = lines.findIndex(line => /^1\.\s*목\s*적$/.test(line));
  if (start < 0) return [];
  // The table of contents, when present, lists the real top-level headings; quoted law items such as
  // "5. 폭은 30센티미터 이상으로 할 것" then cannot pass as headings.
  const squash = text => text.replace(/[^\p{L}\p{N}]/gu, '');
  const contents = new Map(lines.slice(0, start).map(line => line.match(/^(\d{1,2})\.\s*([^\d.].*?)\s*[·.…‥]{3,}\s*\d+$/)).filter(Boolean)
    .map(match => [Number(match[1]), squash(match[2])]));
  // A heading whose contents entry wrapped onto two lines is missing from the map; accept it unless it reads like a sentence.
  // Some contents pages abbreviate or misstate a heading, so a heading directly followed by its "N.1" also counts.
  const listedHeading = (number, title, next) => {
    if (!contents.size || new RegExp(`^${number}\\.1\\s`).test(next || '')) return true;
    if (!contents.has(number)) return !/[것다]\.?$/.test(title.trim());
    const listed = contents.get(number), body = squash(title);
    return body.startsWith(listed.slice(0, Math.min(4, listed.length))) || body.includes(listed);
  };
  // Annexes quoted inside a law excerpt ("[별표 4]") are not the guide's own appendices, which follow its last heading.
  const lastListed = Math.max(1, ...contents.keys());
  const sections = [{ locator: '1. 목적', lines: [] }];
  let top = 1, sub = 0, current = sections[0], part = '1. 목적';
  const open = locator => { current = { locator, lines: [] }; sections.push(current); };
  const body = lines.slice(start + 1);
  for (const [index, line] of body.entries()) {
    if (top === 1 && !current.lines.length && /^적$/.test(line)) continue;
    const topMatch = line.match(/^(\d{1,2})\.\s*([^\d.].{0,45})$/);
    const subMatch = line.match(/^(\d{1,2})\.(\d{1,2})\.?\s+(\S.{0,50})$/);
    const appendix = line.match(/^[<〈［\[【]\s*(부록|별표|별지|부 록)\s*(\d*)\s*[>〉］\]】]?\s*(.{0,40})$/);
    if (topMatch && Number(topMatch[1]) === top + 1 && !/[다음함것]\.$/.test(line) && listedHeading(top + 1, topMatch[2], body[index + 1])) {
      top += 1; sub = 0; part = `${top}. ${topMatch[2].trim()}`; open(part); continue;
    }
    if (subMatch && Number(subMatch[1]) === top && Number(subMatch[2]) === sub + 1) {
      sub += 1; open(`${top}.${sub} ${subMatch[3].trim()}`); current.part = part; continue;
    }
    if (appendix && top >= lastListed && /[>〉］\]】]/.test(line) && !/^[과와에을를의.,:;)]|다\.?$/.test(appendix[3])) { top = 99; open(`${appendix[1].replace(/\s/g, '')} ${appendix[2]} ${appendix[3]}`.replace(/\s+/g, ' ').trim()); continue; }
    if (current) current.lines.push(line);
  }
  return sections.flatMap(section => {
    const text = section.lines.join('\n').trim();
    if (!text) return [];
    const prefix = section.part ? `[${section.part}]\n` : '';
    const chunks = [];
    for (let index = 0; index < text.length; index += MAX_SECTION) chunks.push(text.slice(index, index + MAX_SECTION));
    return chunks.map((chunk, index) => {
      const locator = (index ? `${section.locator} (계속 ${index + 1})` : section.locator).slice(0, 120);
      const body = `${prefix}${locator}\n${chunk}`;
      return { locator, body, content_hash: crypto.createHash('sha256').update(body).digest('hex') };
    });
  }).filter((section, index, all) => all.findIndex(other => other.locator === section.locator) === index);
}

const TRANSCRIBED_DIR = path.join(__dirname, '../local-import/kosha/transcribed');
// '## 4.1 제목' headings split a hand-copied guide into sections, like the numbered sections of text PDFs.
function transcribedSections(text) {
  return text.split(/^## /m).map(part => part.trim()).filter(Boolean).map(part => {
    const [heading, ...rest] = part.split('\n');
    const locator = heading.trim().slice(0, 120), body = `${locator}\n${rest.join('\n').trim()}`;
    return { locator, body, content_hash: crypto.createHash('sha256').update(body).digest('hex') };
  }).filter(section => section.body.length > section.locator.length + 1);
}

function documentStatements({ metadata, sections }) {
  const url = quote(metadata.source_url), version = quote(metadata.source_version);
  const head = `-- ${metadata.title} · ${metadata.source_version} · 항목 ${sections.length}개
insert into public.safety_documents (
  title, source_url, publisher, category, kind, tags, jurisdiction, rights_note, source_group,
  review_status, content_use_allowed, effective_from, effective_until, source_version, checked_at, reviewed_by, created_by
) values (
  ${quote(metadata.title)}, ${url}, '한국산업안전보건공단', ${quote(metadata.category)}, 'guideline',
  array[${metadata.tags.map(quote).join(', ')}]::text[], '대한민국',
  ${quote(metadata.transcribed ? '한국산업안전보건공단 공개 기술지원규정(KOSHA GUIDE). 원문 PDF가 그림으로만 되어 있어 화면을 보고 글로 옮김. 법령이 아닌 기술 권고이며 그림·표·수치와 최신 여부는 원문 PDF에서 확인'
    : '한국산업안전보건공단 공개 기술지원규정(KOSHA GUIDE) 원문 PDF에서 추출한 글. 법령이 아닌 기술 권고이며 표·그림과 최신 여부는 원문 PDF에서 확인')}, 'PUBLIC',
  'approved', true, ${metadata.effective_from ? quote(metadata.effective_from) : 'null'}, null, ${version}, now(), ${quote(metadata.transcribed ? 'KOSHA 산업안전포털 원문 확인 · 그림 PDF 옮김' : 'KOSHA 산업안전포털 원문 확인 · PDF 글 추출')}, 'kosha-guide-import'
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
  const cleanup = `delete from public.safety_document_sections s
using public.safety_documents d
where d.id = s.document_id and d.source_url = ${url} and s.version <> ${version}
  and not exists (select 1 from public.safety_assessment_evidence e where e.section_id = s.id);
`;
  return [head, ...inserts, cleanup];
}

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
    fs.writeFileSync(file, `-- KOSHA GUIDE 공개 원문${note}. 다시 실행해도 같은 자료·항목을 갱신합니다.\nbegin;\n\n${statements.join('\n')}\ncommit;\n`);
    return file;
  });
}

function main() {
  const outPath = path.resolve(process.argv[2] || path.join(__dirname, '../local-import/kosha/kosha-guides.sql'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // KOSHA_PDF_DIR keeps downloaded PDFs between runs (the portal often resets connections).
  const dir = process.env.KOSHA_PDF_DIR ? path.resolve(process.env.KOSHA_PDF_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'kosha-'));
  fs.mkdirSync(dir, { recursive: true });
  const list = new Map(guideList().map(item => [item.techGdlnNo, item]));
  const documents = [], failures = [];
  // KOSHA_ONLY=A-G-10-2025,E-G-18-2026 builds SQL for just those guides (e.g. newly added or revised ones).
  const only = new Set(String(process.env.KOSHA_ONLY || '').split(',').map(item => item.trim()).filter(Boolean));
  for (const [number, category, tags] of KOSHA_GUIDES.filter(([number]) => !only.size || only.has(number))) {
    const guide = list.get(number);
    try {
      if (!guide) throw Error('현행 목록에 없음(개정·폐지 확인)');
      const { out, url } = downloadPdf(guide, dir);
      // Image-only PDFs are copied by hand from the page images (no OCR: it misread figures such as 230mm → 2300001)
      // into local-import/kosha/transcribed/<number>.txt with '## <heading>' lines; those files take precedence.
      const transcribedFile = path.join(TRANSCRIBED_DIR, `${number}.txt`);
      const transcribed = fs.existsSync(transcribedFile);
      const sections = transcribed ? transcribedSections(fs.readFileSync(transcribedFile, 'utf8'))
        : guideSections(cleanLines(execFileSync('pdftotext', ['-enc', 'UTF-8', out, '-'], { maxBuffer: 64 << 20 }).toString(), number));
      if (sections.length < 2) throw Error('본문 글을 추출하지 못함(그림 PDF일 수 있음)');
      const date = /^\d{8}$/.test(guide.techGdlnOfancYmd || '') ? guide.techGdlnOfancYmd.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : null;
      documents.push({
        metadata: { title: `KOSHA GUIDE ${number} ${guide.techGdlnNm.trim()}`, source_url: url, category, tags: ['KOSHA GUIDE', ...tags], effective_from: date, transcribed,
          source_version: `KOSHA GUIDE ${number}${date ? ` · 공표 ${date}` : ''}` },
        sections,
      });
      console.log(`${number} ${guide.techGdlnNm.trim()} · 항목 ${sections.length}개${transcribed ? ' (그림 PDF 옮김)' : ''}`);
    } catch (error) { failures.push(`${number}: ${error.message}`); console.log(`실패 ${number}: ${error.message}`); }
  }
  for (const file of writeSqlFiles(documents, outPath)) console.log(`작성: ${path.relative(process.cwd(), file)}`);
  console.log(`자료 ${documents.length}건 · 실패 ${failures.length}건`);
  if (failures.length) console.log(failures.join('\n'));
}

if (require.main === module) main();
module.exports = { KOSHA_GUIDES, cleanLines, guideSections, transcribedSections };
