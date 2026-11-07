const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const XLSX=require('xlsx-js-style');
const layout=require('../risk-export-layout.cjs');
const source=fs.readFileSync('server.js','utf8'),routes={};
const item={id:'K1',status:'assessing',createdAt:'2026-10-03',customProcess:'소포',factor:'소포 운반 충돌 위험',riskLevel:'상'};
const context=vm.createContext({
 app:{get:(path,handler)=>{routes['GET '+path]=handler},patch:(path,handler)=>{routes['PATCH '+path]=handler}},
 RISK:{items:[item]},PROCESSES:[],HAZARD_TYPES:{},RISK_CRITERIA:{levels:[{value:'상'},{value:'중'},{value:'하'}]},
 XLSXStyle:XLSX,RISK_EXPORT_WIDTHS:layout.WIDTHS,riskExportRows:layout.exportRows,configureRiskExport:layout.configureExport,
 userFromReq:()=>({id:'mgr',kind:'safety_mgr',name:'담당자',riskRole:{collector:true,writer:true}}),isSafetyMgr:()=>true,procById:()=>null,
 syncRiskSource(){},saveRisk(){},save(){},broadcastRisk(){},itemForMgr:it=>it,
});
function load(start,end){const i=source.indexOf(start);vm.runInContext(source.slice(i,source.indexOf(end,i)),context)}
load('/* 국 구분(관내국)','/* 공정:');
load("app.get('/api/risk/export.xlsx'",'/* 현장 사진신고 접수');
load("app.patch('/api/risk/items/:id'",'/* 개선조치 완료');
let payload;
const res={setHeader(){},send:value=>{payload=value},json:value=>{payload=value},status(){return this}};
routes['PATCH /api/risk/items/:id']({params:{id:'K1'},body:{reduction:'통로 확보 및 적재물 정리. '.repeat(100),referenceText:'공식자료 https://www.kosha.or.kr/guide',aiAdvice:{description:item.factor,answers:[{question:'운반물 무게?',answer:'10kg'}],review:{summary:'현장 검토'},sourceOrigin:'external'}}},res);
assert.ok(item.reduction.length>500,'realistic measures are not truncated at the previous 500-character limit');
assert.equal(item.aiAdvice.answers[0].answer,'10kg');assert.equal(item.aiAdvice.by,'담당자');
// PATCH stamps assessmentStartedAt with today, so the export range must include today.
routes['GET /api/risk/export.xlsx']({query:{from:'2026-10-01',to:new Date(Date.now()+9*3600000).toISOString().slice(0,10)}},res);
assert.ok(Buffer.isBuffer(payload));
const book=XLSX.read(payload,{type:'buffer'}),sheet=book.Sheets['소포'];
assert.ok(sheet);const data=XLSX.utils.sheet_to_json(sheet,{header:1});
// Rows 0–1 hold the title and the approval box (담당 · 과장 · 국장 at the head office) at the top right; row 2 is
// □ 공정명 □ 평가일 □ 평가자; row 3 is the header, data from row 4. Names appear only once a step happens (none yet).
assert.deepEqual([data[0][6],data[0][7],data[0][8]],['담당','과장','국장']);assert.deepEqual([data[1][6]||'',data[1][7]||'',data[1][8]||''],['','',''],'no names before anyone sent or approved it');
assert.match(String(data[2][0]),/□ 공정명: 소포 .*□ 평가일: 2026-10-01 ~ .*□ 평가자: .*담당 직원/);
assert.equal(data[3][3],'개선대책');
assert.equal(data.slice(4).map(row=>row[3]).join('').replace(/\n/g,''),item.reduction);
console.log('PASS: API preserves detailed measures and clarification audit, exports actual compact workbook without losing content');
