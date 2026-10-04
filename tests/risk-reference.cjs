const assert=require('node:assert/strict');
const {legalReferences,conciseReferences,searchableEvidence}=require('../public/risk-reference.js');
const evidence=[
 {ref:'external:0',title:'산업안전보건법 시행규칙',locator:'제37조 제2항',sourceUrl:'https://www.law.go.kr/법령/산업안전보건법시행규칙'},
 {ref:'external:1',title:'검색 불가 법령',locator:'제3조'},
 {ref:'external:2',title:'작업 지침',sourceUrl:'https://www.kosha.or.kr/guide'},
 {ref:'doc:one',title:'산업안전보건법',locator:'제36조',status:'approved'},
 {ref:'doc:two',title:'산업안전보건법',locator:'제38조',status:'pending'},
 {ref:'external:3',title:'산업안전보건법',locator:'제99조',sourceUrl:'https://law.go.kr.example.com/fake'}
];
assert.deepEqual(legalReferences({evidence}),['산업안전보건법 시행규칙 제37조 제2항','산업안전보건법 제36조']);
assert.equal(searchableEvidence({evidence}).length,3);
assert.equal(conciseReferences('1. 산업안전보건법 제36조 · 법제처 국가법령정보센터 · https://www.law.go.kr/법령/산업안전보건법'),'1. 산업안전보건법 제36조');
console.log('PASS: only searchable legal clauses, approved internal references, unavailable and spoofed sources excluded, concise existing references');
