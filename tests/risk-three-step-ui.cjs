const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const express=require('express');
const {chromium}=require('playwright');
const {criteria,item}=require('./risk-three-step.cjs');
async function main(){
 const app=express();app.use(express.static(path.join(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url());let data={};
   if(url.pathname==='/api/me')data={user:{id:'test',kind:'safety_mgr',org:'시험 우체국',name:'김담당'}};
   if(url.pathname==='/api/risk/state')data={inbox:[],registered:[item],processes:[{id:'support',name:'시설물'}],hazardTypes:{},criteria};
   if(url.pathname==='/api/safety-knowledge')data={connected:false,documents:[],candidates:[]};
   await route.fulfill({json:data});
  });
  await page.addInitScript(()=>sessionStorage.setItem('cv_risk_token','test-only'));
  await page.goto(`http://127.0.0.1:${server.address().port}/risk.html`);
  await page.locator('#tab-table').click();
  await page.getByText('위험성평가 작성기준',{exact:true}).click();
  assert.equal(await page.locator('.criteria-table tbody tr').count(),3);
  assert.equal(await page.locator('.three-step thead th').count(),10);
  assert.equal(await page.locator('.three-step select').inputValue(),'상');
  assert.equal(await page.getByRole('button',{name:'전체 보기',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'3개월',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'공정별 출력',exact:true}).count(),1);
  await page.screenshot({path:path.join(os.tmpdir(),'risk-three-step-desktop.png'),fullPage:true});
  // A written assessment opens with what was written (2026-11-05): risk level, measures and references are in the form.
  await page.getByRole('button',{name:/^(작성|보기·수정)$/}).click();
  assert.equal(await page.locator('#e-level').inputValue(),'상');
  assert.equal(await page.locator('#e-reduction').count(),1);
  assert.equal(await page.locator('#e-red').count(),0);
  assert.equal(await page.getByRole('button',{name:'AI로 초안 작성',exact:true}).count(),1);
  await page.getByRole('button',{name:'닫기',exact:true}).click();
  await page.getByRole('button',{name:'이행결과서 열기',exact:true}).click();
  assert.equal(await page.locator('.result-photo').count(),2);
  assert.match(await page.locator('.result-plan').innerText(),/담당자\(관리감독자\)/);
  await page.screenshot({path:path.join(os.tmpdir(),'risk-three-step-result.png'),fullPage:true});
  // The print window closes itself after printing (afterprint). Making the PDF fires afterprint too, so the test records
  // the close instead of letting it happen, then closes the window itself.
  await page.evaluate(()=>{const open=window.open;window.open=(...args)=>{const w=open.apply(window,args);if(w){w.print=()=>{};w.close=()=>{w.__closedAfterPrint=true}}return w}});
  const popupEvent=page.waitForEvent('popup');
  await page.getByRole('button',{name:'인쇄',exact:true}).click();
  const popup=await popupEvent;await popup.waitForLoadState();
  await popup.evaluate(()=>{window.__closedAfterPrint=false});
  await popup.pdf({path:path.join(os.tmpdir(),'risk-three-step-result.pdf'),preferCSSPageSize:true});
  assert.equal(await popup.locator('.result-form').count(),1);
  assert.equal(await popup.locator('.ratable').count(),0,'result print must exclude the background assessment');
  await popup.evaluate(()=>dispatchEvent(new Event('afterprint')));
  assert.equal(await popup.evaluate(()=>window.__closedAfterPrint),true,'the print window closes after printing');
  await popup.close();
  await page.getByRole('button',{name:'닫기',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile page overflow');
  await page.screenshot({path:path.join(os.tmpdir(),'risk-three-step-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'이행결과서 열기',exact:true}).click();
  assert.ok(await page.locator('#modalCard').evaluate(el=>el.scrollWidth<=el.clientWidth),'mobile result overflow');
  assert.deepEqual(errors,[]);
  console.log('PASS: desktop/mobile, period filters, compact editor, 10-column form and isolated result printing');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1});
