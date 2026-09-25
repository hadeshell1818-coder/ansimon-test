const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync('server.js','utf8');
const routes={};
let seq=0;
const context=vm.createContext({path, RISK:{items:[]}, reports:[],
  nextRiskId:()=>`K${++seq}`, saveRisk(){},broadcastRisk(){},save(){},broadcast(){},
  app:{get:(p,fn)=>routes['GET '+p]=fn,post:(p,fn)=>routes['POST '+p]=fn},
  userFromReq:req=>req.user
});
vm.runInContext(source.slice(source.indexOf('function visibleReports('),source.indexOf('/* ===================== 중복신고 후보 탐지')),context);
const base={id:'R1',carrierId:'jip',type:'safe',region:'장흥군',buildingName:'장흥우체국',addr:'장흥로 15',photoUrl:'/uploads/photo.jpg',item:'시설물 파손·고장'};
for(const type of ['welfare','env']){
  assert.equal(context.reportRoute({...base,type,requestedInternal:true,routeChoice:'internal'}),'external');
}
assert.equal(context.reportRoute({...base,type:null}),'external');
assert.equal(context.reportRoute({...base,type:null,requestedInternal:true}),'internal');
assert.equal(context.reportRoute({...base,buildingName:''}),'external');
assert.equal(context.reportRoute(base),'confirmation');
assert.equal(context.reportRoute({...base,routeChoice:'external'}),'external');
assert.equal(context.reportRoute({...base,buildingName:'',requestedInternal:true}),'internal');
const report={...base};context.reports.push(report);
context.routeReport(report);
const dept={kind:'dept',region:'장흥군',type:'safe'};
assert.equal(context.visibleReports(dept).length,0);
const handler=routes['POST /api/reports/:id/routing'];
function respond(){return {code:200,status(n){this.code=n;return this;},json(data){this.data=data;return this;}};}
let response=respond();
handler({user:{id:'other'},params:{id:'R1'},body:{choice:'internal'}},response);
assert.equal(response.code,404);
response=respond();
handler({user:{id:'jip'},params:{id:'R1'},body:{choice:'internal'}},response);
assert.equal(response.code,200);
assert.equal(report.routing,'internal');
assert.equal(context.RISK.items.length,1);
assert.equal(context.RISK.items[0].fromReport,'R1');
assert.equal(context.RISK.items[0].photoFile,'photo.jpg');
context.routeReport(report);
assert.equal(context.RISK.items.length,1);
assert.equal(context.visibleReports(dept).length,0);
report.routeChoice='external';context.routeReport(report);
assert.equal(context.visibleReports(dept).length,1);
assert.equal(context.RISK.items[0].routingInactive,true);
report.type='env';report.routeChoice='internal';context.routeReport(report);
assert.equal(report.routing,'external');
assert.equal(context.RISK.items[0].routingInactive,true);
console.log('PASS: routing matrix, recipient visibility, owner authorization, linked photo, idempotency, reclassification');
