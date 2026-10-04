const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
async function main(){
 const server=fs.readFileSync('server.js','utf8'),html=fs.readFileSync('public/safety.html','utf8'),routes={},writes=[];
 let failing=false,broadcasts=0;
 const context=vm.createContext({structuredClone,ZONES:[{id:'z1',name:'1구'}],POSTAL_PROTOTYPE:require('../seed-assets/postal-prototype.json'),ROSTER:[{id:'jip',name:'이전 이름',zone:'z1'}],SAFE:{rosterSnapshots:{today:[]}},userFromReq:()=>({kind:'safety'}),isSafetyCtl:()=>true,zoneById:id=>id==='z1'?{id,name:'1구'}:null,app:Object.fromEntries(['post','patch','delete'].map(method=>[method,(path,fn)=>routes[method+path]=fn])),broadcastSafety:()=>broadcasts++});
 context.rosterById=id=>context.ROSTER.find(r=>r.id===id);
 context.ensureSafetyCollections=()=>{context.SAFE.roster=context.ROSTER;context.SAFE.rosterSnapshots.today=structuredClone(context.ROSTER)};
 context.saveSafety=opts=>{assert.equal(opts.strict,true);if(failing)throw Error('disk');writes.push(structuredClone(context.SAFE));};
 const start=server.indexOf('function saveRosterConfig('),end=server.indexOf('\nloadSafety();',start);
 vm.runInContext(server.slice(start,end),context);
 const invoke=(method,path,body={},id)=>{const response={code:200,status(n){this.code=n;return this},json(data){this.data=data;return this}};routes[method+path]({body,params:{id}},response);return response};
 assert.equal(invoke('post','/api/safety/config/roster',{id:'new',name:'새 직원',zone:'z1'}).code,200);
 assert.equal(writes.at(-1).roster.length,2);assert.equal(context.SAFE.rosterSnapshots.today.length,2);
 assert.equal(invoke('patch','/api/safety/config/roster/:id',{name:'수정 이름'},'jip').code,200);assert.equal(writes.at(-1).roster[0].name,'수정 이름');
 assert.equal(invoke('patch','/api/safety/config/roster/:id',{zone:'wrong'},'jip').code,400);
 failing=true;const count=broadcasts;assert.equal(invoke('patch','/api/safety/config/roster/:id',{name:'저장 실패 이름'},'jip').code,500);assert.equal(context.ROSTER[0].name,'수정 이름');assert.equal(broadcasts,count);
 failing=false;invoke('delete','/api/safety/config/roster/:id',{},'jip');invoke('delete','/api/safety/config/roster/:id',{},'new');assert.equal(writes.at(-1).roster.length,0);
 assert.equal(invoke('post','/api/safety/config/prototype-layout').code,200);assert.equal(context.ROSTER.length,6);assert.equal(context.ZONES.length,8);assert.equal(context.ROSTER.filter(r=>r.zone==='gs').length,2);
 // Empty saved rosters must survive restart instead of reviving seeded names.
 const load=vm.createContext({fs:{existsSync:()=>true,readFileSync:()=>JSON.stringify({roster:[],zones:[]})},SAFETY_FILE:'test',SAFE:{},ROSTER:[{id:'seed'}],ZONES:[{id:'seed'}],console});
 vm.runInContext(server.slice(server.indexOf('function loadSafety()'),server.indexOf('const nextSafeId')),load);assert.equal(load.loadSafety(),true);assert.equal(load.ROSTER.length,0);
 const elements={configError:{textContent:''},healthView:{classList:{contains:()=>true}},equipmentView:{classList:{contains:()=>true}}};let refreshes=0,errors=false;
 const ui=vm.createContext({$:id=>elements[id],api:async()=>{if(errors)throw Error('이미 등록된 계정 ID입니다.');return{ok:true}},load:async()=>refreshes++,openConfig:async()=>refreshes++,runEvidence:async()=>refreshes++,runManagementLedger:async()=>{},evidenceData:{},toast:()=>{}});
 vm.runInContext(html.slice(html.indexOf('async function changeRoster('),html.indexOf('async function saveRoster(')),ui);
 await ui.changeRoster('','POST',{});assert.equal(refreshes,3);errors=true;await ui.changeRoster('','POST',{});assert.match(elements.configError.textContent,/이미 등록/);assert.equal(refreshes,3);
 console.log('PASS: roster add/edit/delete persistence, today snapshot, validation, failed-save rollback, empty restart, UI refresh and visible errors');
}
main().catch(e=>{console.error(e);process.exitCode=1});
