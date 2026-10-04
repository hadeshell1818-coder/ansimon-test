const assert=require('node:assert/strict');
const {createKnowledgeRepository}=require('../safety-knowledge.cjs');
async function main(){
 let failedSearch=false,clarificationCalls=0,lateAmbiguity=false;
 const source={title:'안전 작업 지침',publisher:'안전보건공단',url:'https://www.kosha.or.kr/guide',excerpt:'파손 장비 사용 중지',measure:'파손 장비 격리'};
 const request=async(url,options)=>{
  const body=JSON.parse(options.body);let result;
  if(url.endsWith('/responses')){
   if(failedSearch)return {ok:false,status:400,json:async()=>({error:{param:'tools',message:'Unsupported search configuration'}})};
   return {ok:true,json:async()=>({output:[{type:'web_search_call',action:{sources:[{url:source.url}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify({sources:[source]})}]}]})};
  }
  const prompt=body.messages[0].content;
  if(prompt.startsWith('산업안전 위험 설명'))result={critical:false,queries:['롤파레트 파손'],questions:[]};
  else if(prompt.startsWith('질문 필요성을 재검토')){clarificationCalls++;result={unresolvedMeaning:true,questions:[{question:'어떤 설비의 철망인가요? 예: 롤파레트, 고정 울타리',reason:'설비 종류에 따라 격리·수리·교체 방법이 다릅니다.'}]};}
  else if(prompt.startsWith('당신은 산업안전 위험성평가 초안의 품질'))result=lateAmbiguity?{needsClarification:true,questions:[{question:'어떤 설비인가요?',reason:'대상 식별 필요'}]}:{causalCheck:'pass',legalCheck:'pass',approvedMeasures:['파손 롤파레트 사용을 중지하고 표시·격리한 뒤 담당자가 철망 교체 또는 적정 수리를 확인하고 재사용한다.'],approvedCitations:['external:0']};
  else result={factor:'파손 롤파레트 철망에 찔림',measures:['사용 중지 후 격리·수리'],citations:['external:0']};
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(result)}}]})};
 };
 const repo=createKnowledgeRepository({OPENAI_API_KEY:'test'},request);
 const first=await repo.recommendRisk({description:'파손된 철망·모서리에 긁히거나 찔릴 위험',process:'소포'});
 assert.equal(first.needsClarification,true);assert.equal(first.questions.length,1);assert.match(first.questions[0].question,/어떤 설비/);
 const answer=await repo.recommendRisk({description:'파손된 철망·모서리에 긁히거나 찔릴 위험',answers:[{question:first.questions[0].question,answer:'롤파레트'}]});
 assert.equal(answer.review.passed,true);assert.match(answer.measures[0],/롤파레트.*격리/);assert.equal(clarificationCalls,1);
 const known=await repo.recommendRisk({description:'롤파레트의 파손된 철망에 찔릴 위험'});assert.equal(known.needsClarification,undefined);assert.equal(clarificationCalls,1);
 lateAmbiguity=true;const late=await repo.recommendRisk({description:'파손된 부품의 끝에 찔릴 위험'});assert.equal(late.needsClarification,true);assert.equal(late.questions.length,1);
 lateAmbiguity=false;failedSearch=true;const failed=await repo.recommendRisk({description:'롤파레트의 파손된 철망에 찔릴 위험'});assert.equal(failed.needsClarification,undefined);assert.equal(failed.noEvidence,true);assert.match(failed.externalSearch.error,/400.*현장 정보를 추가해도.*tools/);
 console.log('PASS: unknown wire equipment asks one question, identified equipment does not, answered draft is specific, late review clarification and technical failure diagnosis');
}
main().catch(e=>{console.error(e);process.exitCode=1});
