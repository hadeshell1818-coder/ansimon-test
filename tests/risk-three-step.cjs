const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('public/risk.html', 'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const routes = {};
const legacy = { id: 'RA1', status: 'assessed', frequency: 4, severity: 3, afterRisk: 4, factor: '계단 파손으로 넘어짐 위험', createdAt: new Date().toISOString() };
const RISK = { items: [legacy] };
const ctx = vm.createContext({ RISK, Date, process, console,
  app: { patch: (p,h) => routes[p] = h, post: (p,h) => routes[p] = h, get: (p,h) => routes[p] = h, delete: (p,h) => routes['DELETE '+p] = h },
  userFromReq: req => req.user, isSafetyMgr: u => u?.kind === 'safety_mgr',
  procById: () => ({ name: '시설물' }), PROCESSES: [], HAZARD_TYPES: {}, SAFETY_OFFICE: '시험 우체국',
  saveRisk() {}, broadcastRisk() {}, syncRiskSource() {}, reports: [], SAFE: { hazards: [] }, save() {}, broadcast() {}, saveSafety() {}, broadcastSafety() {}, signedRiskUrl: () => '/photo', nextRiskId: () => 'RA2',
});
function load(start,end){ const i=source.indexOf(start); assert.ok(i>=0); const j=source.indexOf(end,i); assert.ok(j>i); vm.runInContext(source.slice(i,j),ctx); }
load('const RISK_CRITERIA =', 'let RISK =');
load('function itemForMgr(', '/* 이미지 서명');
load("app.post('/api/risk/items/manual'", "app.get('/api/risk/files/:id/:kind'");
const criteria=vm.runInContext('RISK_CRITERIA',ctx);
assert.deepEqual(Array.from(criteria.levels,x=>[x.value,x.allow]),[['상',false],['중',false],['하',true]]);
assert.equal(ctx.itemForMgr(legacy).riskValue,null);
assert.equal(ctx.itemForMgr(legacy).legacyReviewRequired,true);
const user={kind:'safety_mgr',name:'시험 담당자'};
function call(path,body={},actor=user){const res={code:200,status(c){this.code=c;return this},json(b){this.body=b;return this}};routes[path]({user:actor,params:{id:'RA1'},body,query:{}},res);return res}
assert.equal(call('/api/risk/items/:id',{riskLevel:'상'},null).code,403);
assert.equal(call('/api/risk/items/:id',{riskLevel:3}).code,400);
assert.equal(call('/api/risk/items/:id',{frequency:3}).code,400);
const manual=call('/api/risk/items/manual',{customProcess:'집배',factor:'계단 파손으로 넘어짐 위험'});
assert.equal(manual.code,200);assert.equal(manual.body.item.source,'safety_mgr');assert.equal(manual.body.item.assessmentTarget,'집배');
for(const value of ['상','중','하']){
  const res=call('/api/risk/items/:id',{riskLevel:value,assessmentTarget:'계단',evaluator:'김담당',referenceText:'현장 확인'});
  assert.equal(res.code,200);assert.equal(res.body.item.allow,value==='하');
}
assert.equal(legacy.frequency,4,'legacy scores must be preserved, not converted');
assert.equal(legacy.assessmentHistory.length,3);
call('/api/risk/items/:id',{riskLevel:'상'});
const result={afterRiskLevel:'하',completedDate:'2026-09-28',resultNote:'보수 후 통행 상태 확인',reduction:'파손부 교체',improvementSteps:'통제 후 보수',owner:'김담당',dueDate:'2026-09-28'};
assert.equal(call('/api/risk/items/:id/improve',{...result,afterRiskLevel:4}).code,400);
assert.equal(call('/api/risk/items/:id/improve',{...result,completedDate:'2026-02-30'}).code,400);
assert.equal(call('/api/risk/items/:id/improve',{...result,resultNote:''}).code,400);
assert.equal(call('/api/risk/items/:id/improve',{...result,afterRiskLevel:'중'}).code,200);
assert.equal(legacy.status,'assessed','unacceptable residual risk must not close the task');
assert.equal(call('/api/risk/items/:id/improve',result).code,200);
assert.equal(legacy.status,'done');
assert.equal(legacy.afterRisk,4);
assert.equal(legacy.afterRiskLevel,'하');
assert.equal(legacy.completedDate,'2026-09-28');
assert.equal(legacy.improvementHistory.at(-1).afterRiskLevel,'중');
const summary=call('/api/risk/report-summary').body;
assert.equal(summary.highRisk,1);assert.equal(summary.highRiskDone,1);
assert.equal(summary.improved[0].before,'상');assert.equal(summary.improved[0].after,'하');
// Deleting one assessment keeps the original report and records who removed it.
const report={id:'R9',riskId:'RA9'};ctx.reports.push(report);
const linked={id:'RA9',fromReport:'R9',status:'assessed',factor:'바닥 파손',createdAt:new Date().toISOString()};RISK.items.push(linked);
const del=(id,actor=user)=>{const res={code:200,status(c){this.code=c;return this},json(b){this.body=b;return this}};routes['DELETE /api/risk/items/:id']({user:actor,params:{id},body:{},query:{}},res);return res};
assert.equal(del('RA9',null).code,403);
assert.equal(del('RA9').code,200);
assert.equal(RISK.items.some(it=>it.id==='RA9'),false);
assert.equal(ctx.reports[0],report);assert.equal(report.riskId,null);assert.equal(report.riskAssessmentDeletedId,'RA9');
assert.equal(del('RA9').code,404);
console.log('PASS: three-step levels, legacy preservation, dates, residual risk, summary and single assessment deletion');
module.exports={criteria,item:ctx.itemForMgr(legacy)};
