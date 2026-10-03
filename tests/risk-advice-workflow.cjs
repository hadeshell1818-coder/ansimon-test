const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');
const catalog = require('../seed-assets/safety-reference-catalog.json');
async function main() {
  assert.equal(catalog.titles.length, 74);
  const calls = [];
  let questions = true, critical = true, unresolvedMeaning = true, searchFail = false, internalMode = false;
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
    if(prompt.startsWith('질문 필요성을 재검토'))result={unresolvedMeaning:unresolvedMeaning && questions,queries:['운반 작업'],questions:[{question:'운반 방식은?',reason:'위험 대상 해석 불가'},{question:'설명한 설비는?',reason:'대상 설비 해석 불가'},{question:'세 번째 질문',reason:'제외해야 함'}]};
    else if(prompt.startsWith('산업안전 위험 설명')) result={queries:['운반 작업'],critical,questions:questions?[{question:'설명한 운반 작업은 차량 운행인가요, 수작업 운반인가요?',reason:'서로 다른 위험 대상이라 안전대책의 적용 대상을 해석할 수 없습니다.'},{question:'추가 질문',reason:'추가 이유'}]:[]};
    else if(prompt.startsWith('당신은 산업안전 위험성평가 초안의 품질')) result={approvedReply:'수작업 조건에서 적재물 제거와 동선 분리를 검토하세요.',causalCheck:'pass',legalCheck:'pass',approvedMeasures:['담당자가 출입구 앞 적재물을 옮기고 보행 통로 표시를 확인한다.'],approvedCitations:['external:0'],reviewSummary:'현장 대책 검토',additionalChecks:[]};
    else { assert.match(body.messages.at(-1).content,/운반 작업/); result={factor:'운반 동선 충돌',measures:['담당자가 출입구 앞 적재물을 옮기고 보행 통로 표시를 확인한다.'],citations:['external:0','invented'],rationale:'공개 지침을 우체국 통로에 적용',limitations:'통로 폭 현장 확인'}; }
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(result)}}]})};
  };
  const repo=createKnowledgeRepository({OPENAI_API_KEY:'test-key'},request);
  const first=await repo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(first.needsClarification,true);assert.equal(calls.length,2);assert.equal(first.questions.length,2);
  assert.match(calls[1].body.messages[0].content,/질문 필요성을 재검토/);
  unresolvedMeaning=false;
  const resolved=await repo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.notEqual(resolved.needsClarification,true,'재검토에서 의미를 이해하면 질문 없이 작성');
  unresolvedMeaning=true;
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
  const chat=await repo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험',feedback:'차량이 아니라 수작업입니다. 대안을 제안해주세요.',currentDraft:{measures:'차량 분리'},conversation:[{role:'user',text:'작업 공간을 넓힐 수 없습니다.'}]});
  assert.match(chat.chatReply,/수작업/);
  assert.equal(chat.needsClarification,undefined);
  const chatDraft=calls.find(call=>call.body.messages?.[0]?.content.startsWith('feedback')&&JSON.parse(call.body.messages.at(-1).content).feedback);
  assert.ok(chatDraft);
  assert.equal(JSON.parse(chatDraft.body.messages.at(-1).content).currentDraft.measures,'차량 분리');
  const failingRepo=createKnowledgeRepository({OPENAI_API_KEY:'test-key',SAFETY_SUPABASE_URL:'https://test.supabase.co',SAFETY_SUPABASE_SERVICE_KEY:'key'},request);
  const fallback=await failingRepo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(fallback.sourceOrigin,'external');assert.ok(fallback.internalSearch.errors.length);
  internalMode=true;
  failingRepo.search=async()=>({cases:[{id:'case',review_status:'approved',reduction_measures:'운반 동선 분리'}],results:[{title:'운반 작업',kind:'guideline',review_status:'approved',sections:[{id:'section',body:'운반 보조기구 사용'}]}]});
  const mixed=await failingRepo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(mixed.sourceOrigin,'mixed');assert.equal(mixed.externalSearch.attempted,true);
  const enough=await failingRepo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(enough.sourceOrigin,'mixed');assert.equal(enough.externalSearch.attempted,true);
  const draftCall=calls.find(call=>call.body.messages?.some(message=>message.content.startsWith?.('근거 검토와 해결책의 틀')));
  assert.ok(draftCall,'단계별 근거·해결책 설계 지시');
  const draftContext=JSON.parse(draftCall.body.messages.at(-1).content);
  assert.deepEqual(draftContext.evidenceFramework.map(stage=>stage.level),['법','시행령','규칙','고시·공시','지침·매뉴얼·사례']);
  const mixedReview=calls.find(call=>call.body.messages?.[0]?.content.startsWith('당신은 산업안전 위험성평가 초안의 품질')&&JSON.parse(call.body.messages.at(-1).content).evidence.some(item=>item.ref.startsWith('doc:')));
  assert.ok(mixedReview,'품질 재검토에 내부·외부 근거 함께 전달');
  assert.ok(JSON.parse(mixedReview.body.messages.at(-1).content).evidence.some(item=>item.ref.startsWith('external:')));
  searchFail=true;
  const unavailable=await repo.recommendRisk({description:'소포 운반 작업 중 통로가 좁아 충돌 위험'});
  assert.equal(unavailable.noEvidence,true);assert.equal(unavailable.review.passed,false);assert.match(unavailable.externalSearch.error,/503/);
  const html=fs.readFileSync('public/risk.html','utf8');
  for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
  console.log('PASS: clarification before draft, offline/failing Supabase fallback, reference catalog, real search URL filtering, answers, review and inline syntax');
}
main().catch(e=>{console.error(e);process.exitCode=1});
