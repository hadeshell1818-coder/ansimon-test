const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/report.html', 'utf8');
for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script);
const source = html.slice(html.indexOf('function normalizeAddressQuery('), html.indexOf('function resetMapEl('));
let options, embedded, applied;
const elements = Object.fromEntries(['addrTyped','addrMsg','addr','coord'].map(id=>[id,{value:'',textContent:'',appendChild(){}}]));
const context = vm.createContext({
  window:{kakao:{Postcode:function(opts){options=opts;this.embed=(host,config)=>{embedded=config;};},maps:{services:{}}}},
  document:{createElement:()=>({style:{}})},
  $:id=>elements[id], cur:{lat:1,lng:2}, kakaoReady:true,
  setTimeout,clearTimeout,setLocReady(){},ensureKakao:cb=>cb(),
  applySearchedLocation:(...args)=>{applied=args;}
});
context.kakao=context.window.kakao;
context.kakao.maps.services.Status={OK:'OK'};
context.kakao.maps.services.Geocoder=function(){this.addressSearch=(q,cb)=>cb([{x:'126.9',y:'34.6'}],'OK');};
vm.runInContext(source,context);
(async()=>{
  for(const [input,expected] of [['장흥로15','장흥로 15'],['장흥로','장흥로'],['장흥읍 장흥로15','장흥읍 장흥로 15'],['흥성로15-2','흥성로 15-2']]){
    elements.addrTyped.value=input;
    await context.searchAddr();
    assert.equal(embedded.q,expected);
  }
  options.oncomplete({userSelectedType:'R',roadAddress:'전남 장흥군 장흥읍 장흥로 15',sigungu:'장흥군'});
  assert.equal(applied[2],'전남 장흥군 장흥읍 장흥로 15');
  assert.equal(applied[3],'장흥군');
  applied=null;
  elements.addrTyped.value='다른 검색';
  options.oncomplete({userSelectedType:'R',roadAddress:'이전 결과'});
  assert.equal(applied,null);
  elements.addrTyped.value='장흥로';
  await context.searchAddr();
  context.kakaoReady=false;
  options.oncomplete({userSelectedType:'R',roadAddress:'선택한 주소',sigungu:'장흥군'});
  assert.equal(context.cur.addr,'선택한 주소');
  assert.equal(context.cur.lat,null);
  assert.match(elements.addrMsg.textContent,/접수할 수/);
  vm.runInContext(html.slice(html.indexOf('async function submitWithManualLocation('),html.indexOf('async function quickSubmit(')),context);
  let sent,completed=false;
  elements.saveBtn={};
  context.me={region:'장흥군'};
  context.api=async(path,opts)=>{sent=JSON.parse(opts.body);return {report:{id:'R1'}};};
  context.reportRoutingScreen=async()=>{completed=true;};
  context.toast=()=>{};
  await context.submitWithManualLocation();
  assert.equal(sent.addr,'선택한 주소');
  assert.equal(sent.lat,null);
  assert.equal(sent.lng,null);
  assert.equal(completed,true);
  sent=null;
  context.cur={};elements.addr.value='';
  await context.submitWithManualLocation();
  assert.equal(sent,null);
  context.cur={lat:34.6,lng:126.9};
  await context.submitWithManualLocation();
  assert.equal(sent.lat,34.6);
  console.log('PASS: short queries, road-only search, selection, stale result, map failure; inline syntax');
})().catch(error=>{console.error(error);process.exitCode=1;});
