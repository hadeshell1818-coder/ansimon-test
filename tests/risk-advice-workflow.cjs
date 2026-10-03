const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');
const catalog = require('../seed-assets/safety-reference-catalog.json');
async function main() {
  assert.equal(catalog.titles.length, 74);
  const calls = [];
  let questions = true, critical = true, searchFail = false, internalMode = false, sufficient = false;
  const request = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({url:String(url),body});
    if (String(url).includes('supabase')) {
      if(!internalMode)throw Error('repository unavailable');
      const parsed=new URL(url),table=parsed.pathname.split('/').pop();
      const result=table==='safety_documents'?[{id:'law',kind:'law',title:'법령',review_status:'approved'}]:table==='safety_document_sections'?[{id:'law-section',document_id:'law',body:'안전 통로 확보',locator:'제3조'}]:[];
      return {ok:true,json:async()=>result};
    }
    if (String(url).endsWith('/responses')) {
      assert.match(body.input, /근골격계 부담작업/);
      assert.equal(body.tool_choice, 'required');
      assert.equal(body.model, 'gpt-4.1-mini');
      if(searchFail) return {ok:false,status:503};
      const source = {title:'공식 작업 지침',publisher:'안전보건공단',url:'https://www.kosha.or.kr/guide',excerpt:'작업 동선을 분리',measure:'통행로 분리'};
      return {ok:true,json:async()=>({output:[{type:'web_search_call',action:{sources:[{url:source.url}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify({sources:[source,{...source,url:'https://www.kosha.or.kr/invented'}],limitations:'내부 업무편람 원문 제공 필요'})}]}]})};
    }
    const prompt=body.messages[0].content;
    let result;
    if(prompt.startsWith('검색 근거가 실제'))result={sufficient,reason:'현장 적용성 검토'};
    else if(prompt.startsWith('산업안전 위험 설명')) result={queries:['운반 작업'],critical,questions:questions?[{question:'설명한 운반 작업은 차량 운행인가요, 수작업 운반인가요?',reason:'서로 다른 위험 대상이라 안전대책의 적용 대상을 해석할 수 없습니다.'},{question:'추가 질문',reason:'추가 이유'}]:[]};
    else if(prompt.startsWith('당신은 산업안전 위험성평가 초안의 품질')) result={causalCheck:'pass',legalCheck:'pass',approvedMeasures:['담당자가 출입구 앞 적재물을 옮기고 보행 통로 표시를 확인한다.'],approvedCitations:['external:0'],reviewSummary:'현장 대책 검토',additionalChecks:[]};
    else { assert.match(body.messages.at(-1).content,/운반 작업/); result={factor:'운반 동선 충돌',measures:['담당자가 출입구 앞 적재물을 옮기고 보행 통로 표시를 확인한다.'],citations:['external:0','invented'],rationale:'공개 지침을 우체국 통로에 적용',limitations:'통로 폭 현장 확인'}; }
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(result)}}]})};
  };
  const repo=createKnowledgeRepository({OPENAI_API_KEY:'test-key'},request);
  const first=await repo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(first.needsClarification,true);assert.equal(calls.length,1);assert.equal(first.questions.length,1);
  const second=await repo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험',answers:[{question:first.questions[0].question,answer:'한 개 10kg, 하루 20회'}]});
  assert.equal(second.sourceOrigin,'external');assert.equal(second.externalSources.length,1);
  assert.equal(second.answers[0].answer,'한 개 10kg, 하루 20회');assert.deepEqual(second.citations,['external:0']);
  assert.equal(second.externalSearch.used,true);
  assert.notEqual(second.needsClarification,true,'답변 후에는 모델이 추가 질문을 반환해도 초안 작성');
  critical=false;
  const optional=await repo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.notEqual(optional.needsClarification,true,'일반적인 정보 부족은 초안 작성을 차단하지 않음');
  critical=true;
  const unknown=await repo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험',answers:[{question:'운반 방식',answer:'모름'}]});
  assert.notEqual(unknown.needsClarification,true,'모름에도 반복 질문하지 않음');
  questions=false;
  const failingRepo=createKnowledgeRepository({OPENAI_API_KEY:'test-key',SAFETY_SUPABASE_URL:'https://test.supabase.co',SAFETY_SUPABASE_SERVICE_KEY:'key'},request);
  const fallback=await failingRepo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(fallback.sourceOrigin,'external');assert.ok(fallback.internalSearch.errors.length);
  internalMode=true;
  failingRepo.search=async()=>({cases:[{id:'case',review_status:'approved',reduction_measures:'운반 동선 분리'}],results:[{title:'운반 작업',kind:'guideline',review_status:'approved',sections:[{id:'section',body:'운반 보조기구 사용'}]}]});
  const mixed=await failingRepo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(mixed.sourceOrigin,'mixed');assert.equal(mixed.externalSearch.attempted,true);
  sufficient=true;
  const enough=await failingRepo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(enough.sourceOrigin,'internal');assert.equal(enough.externalSearch.attempted,false);
  searchFail=true;
  const unavailable=await repo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(unavailable.noEvidence,true);assert.equal(unavailable.review.passed,false);assert.match(unavailable.externalSearch.error,/503/);
  const html=fs.readFileSync('public/risk.html','utf8');
  for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
  console.log('PASS: clarification before draft, offline/failing Supabase fallback, reference catalog, real search URL filtering, answers, review and inline syntax');
}
main().catch(e=>{console.error(e);process.exitCode=1});
