const assert=require('node:assert/strict');
const {legalReferences,conciseReferences,searchableEvidence}=require('../public/risk-reference.js');
const evidence=[
 {ref:'external:0',status:'pending',title:'산업안전보건법 시행규칙',locator:'제37조 제2항',sourceUrl:'https://www.law.go.kr/법령/산업안전보건법시행규칙'},
 {ref:'external:1',title:'검색 불가 법령',locator:'제3조'},
 {ref:'external:2',title:'작업 지침',sourceUrl:'https://www.kosha.or.kr/guide'},
 {ref:'doc:one',title:'산업안전보건법',locator:'제36조',status:'approved'},
 {ref:'doc:two',title:'산업안전보건법',locator:'제38조',status:'pending'},
 {ref:'external:3',title:'산업안전보건법',locator:'제99조',sourceUrl:'https://law.go.kr.example.com/fake'}
];
assert.deepEqual(legalReferences({evidence}),['산업안전보건법 시행규칙 제37조 제2항','산업안전보건법 제36조']);
// Official notices count as legal references only when their text comes from law.go.kr.
const notices=[
 {ref:'doc:notice',status:'approved',title:'위험기계·기구 방호조치 기준',locator:'제4조(방호조치)',sourceUrl:'https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=1'},
 {ref:'doc:internal',status:'approved',title:'우정사업본부 위험성평가 표준지침서',locator:'제3조(평가 시기)'}
];
assert.deepEqual(legalReferences({evidence:notices}),['위험기계·기구 방호조치 기준 제4조(방호조치)']);
// Numbered sections of official technical standards are cited by section number.
assert.deepEqual(legalReferences({evidence:[{ref:'doc:nftc',status:'approved',title:'소화기구 및 자동소화장치의 화재안전기술기준(NFTC 101)',locator:'2.1 설치기준',sourceUrl:'https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=2'},{ref:'doc:memo',status:'approved',title:'내부 점검 기준',locator:'2.1 점검'}]}),['소화기구 및 자동소화장치의 화재안전기술기준(NFTC 101) 2.1']);
assert.deepEqual(legalReferences({evidence:[{ref:'doc:annex',status:'approved',title:'산업안전보건법 시행규칙 별표 6·7·8 (안전보건표지)',locator:'별표 7 안전보건표지의 종류별 용도 — 경고표지',sourceUrl:'https://www.law.go.kr/법령/x#별표6-8'},{ref:'doc:copy',status:'approved',title:'사내 안전보건표지 안내',locator:'별표 1 표지'}]}),['산업안전보건법 시행규칙 별표 7']);
assert.equal(searchableEvidence({evidence}).length,3);
assert.equal(conciseReferences('1. 산업안전보건법 제36조 · 법제처 국가법령정보센터 · https://www.law.go.kr/법령/산업안전보건법'),'1. 산업안전보건법 제36조');
console.log('PASS: only searchable legal clauses, official notices and numbered standards from law.go.kr, approved internal references, unavailable and spoofed sources excluded, concise existing references');
