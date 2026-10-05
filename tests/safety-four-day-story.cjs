const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const express=require('express'),{chromium}=require('playwright');
const fixture=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/safety-pilot-demo.js'),'utf8')+';PILOT_DEMO');
async function main(){
 assert.deepEqual(Array.from(fixture.days,d=>d.date),['2026-09-29','2026-09-30','2026-10-01','2026-10-02']);
 assert.equal(fixture.days.flatMap(d=>d.returns).length,24);
 assert.equal(fixture.notices.length,4);assert.equal(fixture.alerts.length,10);
 const targeted=fixture.alerts.find(a=>a.fromHazard==='prototype-hazard-road');
 assert.deepEqual(Array.from(targeted.recipients,p=>p.name),['집배원1','집배원2','집배원3','집배원4']);
 assert.equal(fixture.alerts.find(a=>a.fromHazard==='prototype-hazard-leaves').targets.length,6);
 for(const notice of fixture.notices)assert.match(notice.createdAt,/T08:(3\d|4\d|5\d):/);
 for(const alert of fixture.alerts)for(const person of alert.recipients)assert.ok(new Date(person.ackAt)>new Date(alert.createdAt));
 const health=fixture.days[1].returns[3].report;
 assert.equal(health.bodyDetail,'허리 근육통 호소');assert.match(health.actions.health.detail,/파스 지급/);
 assert.match(health.actions.health.completedAt,/2026-10-01/);assert.equal(health.actions.health.completedDetail,'다행히 큰 문제 없다고 함.');
 assert.equal(fixture.days[2].returns[3].report.bodyIssue,false);
 const app=express();app.use(express.static(path.join(__dirname,'../public')));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));let browser;
 try{
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],queries=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{const url=new URL(route.request().url());let data={};
   if(url.pathname==='/api/me')data={user:{kind:'safety',name:'소통실',org:'장흥우체국'}};
   if(url.pathname==='/api/safety/state')data={today:'2026-10-02',hazards:[],calls:[],alerts:[],zones:[],roster:[],levels:{caution:'주의',notice:'전달말씀'}};
   if(url.pathname==='/api/on/returns')data={summary:{total:0,absent:0,target:0,reported:0,selfReported:0,controlConfirmed:0,missing:0,ok:0,healthOnly:0,equipmentOnly:0,both:0},rows:[]};
   if(url.pathname==='/api/safety/evidence'){queries.push(url.searchParams);data={start:url.searchParams.get('start'),end:url.searchParams.get('end'),returns:[],daily:[],notices:[],alerts:[],hazards:[],calls:[],healthLedger:[],equipmentLedger:[],summary:{notices:0,voice:0,calls:0,alerts:0,alertBroadcasts:0,returnTarget:0,returnMissing:0,returnReports:0,normalReturns:0,bodyIssues:0,equipmentIssues:0,bothIssues:0}};}
   if(url.pathname==='/api/safety/ledger')data={rows:[]};
   await route.fulfill({json:data});
  });
  await page.addInitScript(()=>sessionStorage.setItem('cv_safe_token','test'));
  await page.goto(`http://127.0.0.1:${server.address().port}/safety.html`);await page.locator('#app').waitFor({state:'visible'});
  await page.evaluate(()=>showTab('stats'));await page.waitForFunction(()=>typeof evidenceData!=='undefined'&&evidenceData?.returns.length===24);
  assert.equal(queries.at(-1).get('start'),'2026-09-29');assert.equal(queries.at(-1).get('end'),'2026-10-02');
  const result=await page.evaluate(()=>({daily:evidenceData.daily,summary:evidenceData.summary}));
  assert.equal(result.daily.length,4);assert.equal(result.summary.bodyIssues,1);assert.equal(result.summary.normalReturns,23);
  assert.match(await page.locator('.situation-table').innerText(),/용산교도소/);assert.equal(await page.locator('.situation-table tbody tr').count(),16);
  await page.evaluate(()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);w.print=()=>{};return w}});
  let promise=page.waitForEvent('popup');await page.evaluate(()=>printReturnEvidence());let popup=await promise;await popup.waitForLoadState();
  let printed=await popup.locator('body').innerText();for(const term of ['2026-09-29','2026-10-02','허리 근육통 호소','파스 지급','다행히 큰 문제 없다고 함.'])assert.ok(printed.includes(term),term);await popup.close();
  await page.evaluate(()=>showTab('health'));await page.waitForFunction(()=>managementLedgerData.health?.length===24);
  promise=page.waitForEvent('popup');await page.evaluate(()=>printManagementLedger('health','prototype-jip14'));popup=await promise;await popup.waitForLoadState();
  printed=await popup.locator('body').innerText();assert.equal(await popup.locator('tbody tr').count(),4);assert.match(printed,/파스 지급/);assert.match(printed,/다행히 큰 문제 없다고 함/);await popup.close();
  assert.deepEqual(errors,[]);console.log('PASS: 4-day cross-month period, 24 returns, scoped risk recipients, linked next-day health result, situation and ledger/return prints');
 }finally{await browser?.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1});
