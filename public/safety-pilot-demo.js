// Display-only prototype examples. Never persisted, sent or counted as actual confirmations.
const PILOT_DEMO = (() => {
 const zones=['시외통상구 · 대덕읍·회진면','시외통상구 · 관산읍','시외통상구 · 관산읍','시외통상구 · 용산면','시외통상구 · 유치면','시외통상구 · 장평면'];
 const people=zones.map((zoneName,index)=>({id:'prototype-jip'+(index+11),accountId:'jip'+(index+11),name:'집배원'+(index+1),zoneName}));
 const at=(date,time)=>date+'T'+time+':00+09:00';
 const dates=['2026-09-29','2026-09-30','2026-10-01','2026-10-02'];
 const returnMinutes=[[9,18,26,34,43,51],[12,20,27,35,44,53],[8,17,25,33,42,50],[11,19,28,36,45,54]];
 const days=dates.map((date,day)=>({date,returns:people.map((p,index)=>({...p,absence:null,report:{carrierId:p.id,at:at(date,'15:'+String(returnMinutes[day][index]).padStart(2,'0')),source:'self',bodyIssue:false,bodyDetail:'',equipmentIssue:false,equipmentDetail:'',actions:{}}}))}));
 const healthDetail='상담결과 일시적이고 가벼운 증상으로 일단 파스 지급, 내일 경과 다시 지켜보기로 함.';
 const health=days[1].returns[3].report;
 health.bodyIssue=true;health.bodyDetail='허리 근육통 호소';
 health.actions.health={status:'done',owner:'소통실',detail:healthDetail,requestedAt:at(dates[1],'15:42'),at:at(dates[1],'15:42'),updatedAt:at(dates[2],'08:47'),completedAt:at(dates[2],'08:47'),completedDetail:'다행히 큰 문제 없다고 함.',history:[{status:'in_progress',owner:'소통실',detail:healthDetail,at:at(dates[1],'15:42'),updatedAt:at(dates[1],'15:42')}]};
 const titles=['출발 전 장비·이륜차 점검','농기계 통행 주의','환절기 건강관리 안내','배달 중 정차 안전수칙'];
 const bodies=[
  '배달 출발 전 브레이크·타이어·등화장치와 PDA 배터리를 확인하세요. 이상이 있으면 무리하게 운행하지 말고 점검과 조치를 요청하세요.',
  '경운기·트랙터 같은 농기계가 도로에 자주 나옵니다. 무리하게 추월하지 마시고 충분히 거리를 두고 안전운행 하십시오.',
  '아침저녁 일교차가 10도 이상 벌어집니다. 겉옷 잘 챙기시고 환절기 감기 조심하십시오.',
  '배달 중 정차할 때는 꼭 시동을 끄고 사이드스탠드를 확인해 주세요. 내리막길 정차는 특히 조심하셔야 합니다.'
 ];
 const midday=[
  '골목에서 큰길로 나갈 때는 일단 멈춤, 좌우 확인 후 진입하겠습니다. 사고의 상당수가 교차로와 골목 진입에서 납니다.',
  '과속하지 마시고, 물량이 많아도 빠른 배달보다 안전이 우선입니다. 학교 앞과 어린이보호구역은 시속 30km를 꼭 지켜 주세요.'
 ];
 const returnTexts=[
  '귀국보고 및 이상사항 확인 · 배달 종료 후 귀국보고에서 건강과 장비 상태를 각각 확인해 주세요. 이상이 있으면 구체적인 내용을 적고, 소통실은 필요한 후속조치를 확인해 주세요.',
  '배달을 마치면 귀국보고를 제출해 주세요. 건강·장비 이상은 각각 확인하고, 이상이 있으면 소통실에 알려주세요.'
 ];
 const recipients=(date,time,targets=people)=>{const [hour,minute]=time.split(':').map(Number);return targets.map((p,i)=>{const next=hour*60+minute+2+i;return {...p,ackAt:at(date,String(Math.floor(next/60)).padStart(2,'0')+':'+String(next%60).padStart(2,'0')),phoneAck:null,followups:[]}})};
 const message=(id,date,time,targets=people)=>{const rs=recipients(date,time,targets);return {id,demo:true,sender:'소통실',createdAt:at(date,time),targets:rs.map(p=>p.id),recipients:rs,acks:Object.fromEntries(rs.map(p=>[p.id,p.ackAt])),edits:[],followups:[]}};
 const notices=dates.map((date,i)=>({...message('prototype-notice-'+i,date,['08:36','08:43','08:39','08:51'][i]),title:titles[i],body:bodies[i]}));
 const alerts=dates.flatMap((date,i)=>[
  {...message('prototype-midday-'+i,date,['10:17','10:24','10:12','10:31'][i]),level:'caution',text:midday[i%2]},
  {...message('prototype-return-'+i,date,['14:11','14:23','14:07','14:26'][i]),level:'notice',text:returnTexts[i%2]}
 ]);
 const hazardSpecs=[
  {id:'prototype-hazard-leaves',date:dates[0],time:'09:32',sent:'09:35',carrier:people[0],targets:people,text:'낙엽 쌓인 계단이나 마당이 생각보다 미끄럽습니다. 조심하십시오.'},
  {id:'prototype-hazard-road',date:dates[1],time:'09:12',sent:'09:16',carrier:people[3],targets:people.slice(0,4),text:'용산교도소 근방 도로에 낙하물 있습니다. 운행 시 조심하십시오.'}
 ];
 const hazards=hazardSpecs.map(h=>({id:h.id,demo:true,carrier:h.carrier.name,carrierId:h.carrier.id,zoneName:h.carrier.zoneName,createdAt:at(h.date,h.time),transcript:h.text,status:'dispatched',alertId:h.id+'-alert',dispatchedAt:at(h.date,h.sent),dispatchedBy:'소통실'}));
 alerts.push(...hazardSpecs.map(h=>({...message(h.id+'-alert',h.date,h.sent,h.targets),level:'caution',text:h.text,fromHazard:h.id})));
 return {people,days,notices,alerts,hazards,calls:[]};
})();
