const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const express=require('express'),{chromium}=require('playwright');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
async function main(){
 const app=express();app.use(express.json());
 const sessions=new Map(),USERS={manager:{kind:'safety_mgr',org:'장흥우체국',name:'담당자'},other:{kind:'carrier',org:'장흥우체국'}};
 const item={id:'K1',status:'inbox',source:'staff',reporter:'직원',createdAt:new Date().toISOString(),factor:'롤파레트 파손',note:'철망 찔림 위험'};
 let writes=0;const context=vm.createContext({app,sessions,USERS,SESSION_TTL_MS:28800000,SAFETY_OFFICE:'장흥우체국',RISK:{items:[item]},Date,
 syncRiskSource(){writes++},saveRisk(){},save(){},broadcastRisk(){}});
 const load=(start,end)=>{const i=source.indexOf(start),j=source.indexOf(end,i);assert.ok(i>=0&&j>i);vm.runInContext(source.slice(i,j),context)};
 load('function tokenFromReq(', 'setInterval(() => {');
 load('const isSafetyMgr =','/* 공정:');
 app.get('/api/me',(req,res)=>{const user=context.userFromReq(req);return user?res.json({user}):res.status(401).json({error:'unauthorized'})});
 app.post('/api/login',(req,res)=>{sessions.set('fresh',{uid:'manager',expiresAt:Date.now()+60000});res.json({token:'fresh',user:USERS.manager})});
 app.post('/api/logout',(req,res)=>res.json({ok:true}));
 load("app.use(['/api/risk/state'", "app.get('/api/risk/state'");
 load("app.post('/api/risk/items/:id/triage'",'/* 안전보건담당자가 현장에서');
 app.get('/api/risk/state',(req,res)=>res.json({inbox:item.status==='inbox'?[item]:[],registered:item.status==='assessing'?[item]:[],processes:[],hazardTypes:{},criteria:{levels:[]}}));
 app.get('/api/safety-knowledge',(req,res)=>res.json({connected:false,documents:[],candidates:[]}));
 app.use(express.static(path.join(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 let browser;
 try{
  const post=token=>fetch(base+'/api/risk/items/K1/triage',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({decision:'promote'})});
  sessions.set('expired',{uid:'manager',expiresAt:Date.now()-1});assert.equal((await post('expired')).status,401);assert.equal(writes,0);
  sessions.set('wrong',{uid:'other',expiresAt:Date.now()+60000});assert.equal((await post('wrong')).status,403);assert.equal(writes,0);
  sessions.set('fresh',{uid:'manager',expiresAt:Date.now()+60000});
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>sessionStorage.setItem('cv_risk_token','fresh'));
  await page.goto(base+'/risk.html');const button=page.getByRole('button',{name:'위험성평가로 등록',exact:true});await button.waitFor();
  sessions.get('fresh').expiresAt=Date.now()-1;
  await button.click();await page.locator('#login').waitFor({state:'visible'});
  assert.match(await page.locator('#lerr').innerText(),/로그인.*만료/);assert.equal(item.status,'inbox');assert.equal(writes,0);
  await page.locator('#lid').fill('manager');await page.locator('#lpw').fill('test-password');await page.evaluate(()=>doLogin());
  await button.waitFor();await button.click();await page.locator('#modalCard h3').getByText('위험성평가표',{exact:true}).waitFor();
  assert.equal(item.status,'assessing');assert.equal(item.evaluator,'담당자');assert.equal(writes,1);assert.deepEqual(errors,[]);
  console.log('PASS: expired session → 401 and login; wrong role → 403; re-login → registration and assessment editor, source synced once');
 }finally{await browser?.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1});