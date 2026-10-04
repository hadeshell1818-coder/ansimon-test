// Display-only prototype examples. Never persisted, sent or counted as actual confirmations.
const PILOT_DEMO = (() => {
 const zones=['시외통상구 · 대덕읍·회진면','시외통상구 · 관산읍','시외통상구 · 관산읍','시외통상구 · 용산면','시외통상구 · 유치면','시외통상구 · 장평면'];
 const people=zones.map((zoneName,index)=>({id:'prototype-jip'+(index+11),accountId:'jip'+(index+11),name:'집배원'+(index+1),zoneName}));
 const at=(date,time)=>date+'T'+time+':00+09:00';
 const dates=['2026-09-28','2026-09-29','2026-09-30'];
 const days=dates.map(date=>({date,returns:people.map((p,index)=>({...p,absence:null,report:{carrierId:p.id,at:at(date,'15:'+String(10+index*7)),source:'self',bodyIssue:false,bodyDetail:'',equipmentIssue:false,equipmentDetail:'',actions:{}}}))}));
 const titles=['환절기 건강관리 안내','출발 전 장비·이륜차 점검','귀국보고 및 이상사항 확인'];
 const bodies=[
  '아침·저녁 기온 차에 대비해 겉옷을 준비하고, 작업 중 충분히 수분을 섭취하세요. 몸 상태가 좋지 않으면 소통실에 알려주세요.',
  '배달 출발 전 브레이크·타이어·등화장치와 PDA 배터리를 확인하세요. 이상이 있으면 무리하게 운행하지 말고 점검과 조치를 요청하세요.',
  '배달 종료 후 귀국보고에서 건강과 장비 상태를 각각 확인해 주세요. 이상이 있으면 구체적인 내용을 적고, 소통실은 필요한 후속조치를 확인해 주세요.'
 ];
 const texts=[
  '환절기에는 일교차에 대비해 겉옷을 준비하세요. 출발 전 오늘의 날씨와 시간대별 강수 예보를 확인해 주세요.',
  '교차로와 골목길에서는 주변을 확인하고 서행하세요. 낙엽·젖은 노면 등 미끄러운 구간은 안전하게 통과해 주세요.',
  '배달을 마치면 귀국보고를 제출해 주세요. 건강·장비 이상은 각각 확인하고, 이상이 있으면 소통실에 알려주세요.'
 ];
 const recipients=(date,time)=>people.map(p=>({...p,ackAt:at(date,time),phoneAck:null,followups:[]}));
 const notices=dates.map((date,i)=>({id:'prototype-notice-'+i,demo:true,title:titles[i],body:bodies[i],sender:'상황실',createdAt:at(date,'08:30'),targets:people.map(p=>p.id),recipients:recipients(date,'08:40'),acks:Object.fromEntries(people.map(p=>[p.id,at(date,'08:40')])),edits:[],followups:[]}));
 const alerts=dates.map((date,i)=>({id:'prototype-alert-'+i,demo:true,text:texts[i],sender:'상황실',level:'caution',createdAt:at(date,'09:00'),targets:people.map(p=>p.id),recipients:recipients(date,'09:10'),acks:Object.fromEntries(people.map(p=>[p.id,at(date,'09:10')])),edits:[],followups:[]}));
 return {people,days,notices,alerts,hazards:[],calls:[]};
})();