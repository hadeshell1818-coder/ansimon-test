const assert=require('node:assert/strict');
const path=require('node:path');
const express=require('express');
const {chromium}=require('playwright');
async function main(){
 const app=express();app.use(express.static(path.join(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
  const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  const date=new Date().toISOString().slice(0,10),item={id:'K1',status:'assessing',factor:'소포 운반 작업 중 통로 충돌 위험',customProcess:'소포',createdAt:date,assessmentStartedAt:date};
  let release;const pending=new Promise(resolve=>{release=resolve});let recommendCount=0;
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url());let data={};
   if(url.pathname==='/api/me')data={user:{id:'manager',kind:'safety_mgr',name:'담당자'}};
   if(url.pathname==='/api/risk/state')data={inbox:[],registered:[item],processes:[],hazardTypes:{},criteria:{levels:[{value:'상',allow:false},{value:'중',allow:false},{value:'하',allow:true}]}};
   if(url.pathname==='/api/safety-knowledge')data={connected:false,documents:[],candidates:[],message:'외부 검색 사용 가능'};
   if(url.pathname==='/api/safety-knowledge/recommend'){
    const body=route.request().postDataJSON();requests.push(body);recommendCount++;
    if(recommendCount===1){await pending;data={needsClarification:true,questions:[{question:'운반물 무게와 하루 횟수는?',reason:'노출 부하 확인'}]};}
    else data={factor:item.factor,measures:['담당자가 작업 전 출입구 적재물을 제거하고 보행 동선을 표시한다.'],citations:['external:0'],evidence:[{ref:'external:0',title:'공식 자료',sourceUrl:'https://www.kosha.or.kr/guide',type:'외부 공식자료'}],rationale:'운반 통로를 확보해 충돌 노출을 줄인다.',limitations:'통로 폭은 현장에서 확인',review:{passed:true,needsAttention:false,additionalChecks:['폭 확인']},sourceOrigin:'external',externalSources:[]};
   }
   if(url.pathname==='/api/risk/items/K1'){const body=route.request().postDataJSON();Object.assign(item,body);data={item};}
   await route.fulfill({json:data});
  });
  await page.addInitScript(()=>sessionStorage.setItem('cv_risk_token','test'));
  await page.goto(`http://127.0.0.1:${server.address().port}/risk.html`);
  await page.locator('#tab-table').click();
  await page.evaluate(()=>editRow('K1'));
  await page.locator('#risk-advice-button').click();
  await page.waitForFunction(()=>document.querySelector('#risk-advice-button').textContent==='작성중…');
  assert.equal(await page.locator('#risk-advice-button').isDisabled(),true);
  release();await page.locator('#risk-answer-0').waitFor();
  await page.locator('#risk-answer-0').fill('한 개 10kg, 하루 20회');
  await page.getByRole('button',{name:'답변 검토 후 초안 작성'}).click();
  await page.getByText('개선대책과 관련근거 초안',{exact:true}).waitFor();
  assert.equal(requests[1].answers[0].answer,'한 개 10kg, 하루 20회');
  assert.match(item.referenceText,/https:\/\/www.kosha.or.kr\/guide/);
  assert.equal(item.aiAdvice.answers.length,1);
  assert.equal(await page.locator('#risk-advice-button').isDisabled(),false);
  await page.getByRole('button',{name:'닫기',exact:true}).click();
  await page.evaluate(()=>{window.originalOpen=window.open;window.open=(...args)=>{const w=window.originalOpen(...args);w.print=()=>{};return w}});
  const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'위험성평가표 출력',exact:true}).click();
  const popup=await popupPromise;await popup.waitForLoadState();
  assert.equal(await popup.locator('thead th').count(),9);
  assert.match(await popup.locator('body').innerText(),/담당자가 작업 전 출입구/);
  await popup.screenshot({path:path.join(__dirname,'../risk-assessment-print-preview.png'),fullPage:true});
  await popup.close();assert.deepEqual(errors,[]);
  console.log('PASS: browser busy label, clarification/answer roundtrip, saved advice and sources, 9-column assessment print');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1});
