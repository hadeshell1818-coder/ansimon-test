const assert = require('node:assert/strict');
const { cleanLines, guideSections, transcribedSections } = require('../scripts/prepare-kosha-guides.cjs');

// Shaped like pdftotext output of a KOSHA GUIDE: contents page, a heading split over two lines,
// a quoted law excerpt with numbered items and an annex, an inline appendix reference, then appendices.
const text = [
  'KOSHA GUIDE', 'X - G - 1 - 2026', '목 차',
  '1. 목 적 ··········· 1', '2. 적용범위 ··········· 1', '3. 관련 법적 필수사항 ·········· 2', '3.1 추락 방지 ········ 2', '4. 사다리 작업 ········· 3',
  '- 1 -', '\f', 'KOSHA GUIDE', 'X - G - 1 - 2026',
  '1. 목', '적', '이 지침은 사다리 작업의 안전을 정함을 목적으로 한다.',
  '2. 적용범위', '사다리를 쓰는 모든 작업장에 적용한다.',
  '3. 이동식 사다리 관련 법적 필수사항',
  '제42조(추락의 방지) ④ 사업주는 다음 각 호의 사항을 준수하도록 조치해야 한다.',
  '4. 이동식 사다리를 설치한 바닥면에서 높이 3.5미터 이하의 장소에서만 작업할 것',
  '[별표 4] 사전조사 및 작업계획서 내용',
  '- 2 -',
  '4. 사다리 작업', '4.1 설치', '평탄하고 견고한 바닥에 설치한다. 자세한 점검표는', '<부록 1>과 같다.',
  '4.2 사용', '최상부 발판에 올라서지 않는다.',
  '<부록 1> 사다리 점검표', '(1) 발판 손상 여부',
].join('\n');

const sections = guideSections(cleanLines(text, 'X-G-1-2026'));
assert.deepEqual(sections.map(section => section.locator), ['1. 목적', '2. 적용범위', '3. 이동식 사다리 관련 법적 필수사항', '4.1 설치', '4.2 사용', '부록 1 사다리 점검표']);
assert.match(sections[0].body, /^1\. 목적\n이 지침은/, 'split heading is joined and its stray syllable dropped');
assert.match(sections[2].body, /4\. 이동식 사다리를 설치한[\s\S]*\[별표 4\]/, 'quoted law items and annexes stay inside the law section');
assert.match(sections[3].body, /^\[4\. 사다리 작업\]\n4\.1 설치\n[\s\S]*<부록 1>과 같다\./, 'subsections carry their part heading; inline appendix references are text');
assert(!sections.some(section => /KOSHA GUIDE|X - G|- \d -/.test(section.body)), 'running headers and page numbers removed');
assert(sections.every(section => /^[0-9a-f]{64}$/.test(section.content_hash)));
assert.deepEqual(guideSections(cleanLines('그림으로만 된 PDF\n- 1 -', 'X-G-2-2026')), [], 'image-only PDFs yield no sections instead of guesses');
// A heading number alone on its line ("1." / "목적") still opens the section (W-26-2023 layout).
const split = guideSections(['1.', '목적', '이 지침은 환기에 관한 사항을 정한다.', '2. 적용 범위', '이 지침은 급식시설에 적용한다.']);
assert.deepEqual(split.map(section => section.locator), ['1. 목적', '2. 적용 범위']);
// Hand-copied image PDFs: '## heading' lines become sections; empty headings are dropped.
const copied = transcribedSections('## 4.1 넘어짐\n(1) 위험요소\n## 빈 제목\n## 5.1 사업주의 책무\n(1) 정기 점검');
assert.deepEqual(copied.map(section => section.locator), ['4.1 넘어짐', '5.1 사업주의 책무']);
assert.match(copied[0].body, /^4\.1 넘어짐\n\(1\) 위험요소$/);
console.log('PASS: KOSHA GUIDE sections follow the contents page, keep quoted law text and inline references, skip image-only PDFs');
