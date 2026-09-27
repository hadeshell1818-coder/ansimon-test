// Display-only examples. These records are never submitted to the application API.
const SAFETY_STATS_SAMPLE = [
  { date: '2026-09-22', statuses: ['body', 'equipment', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'absent'] },
  { date: '2026-09-23', statuses: ['body', 'both', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'absent', 'absent'] },
  { date: '2026-09-24', statuses: ['body', 'equipment', 'both', 'normal', 'normal', 'normal', 'normal', 'missing', 'absent', 'absent'] },
].map(day => ({
  date: day.date,
  rows: day.statuses.map((status, index) => ({
    id: 'sample-' + index, rosterIndex:index, name: '', zone: '', status,
    absence: status === 'absent' ? (index === 9 ? '연가' : '교육') : '',
    body: ['body', 'both'].includes(status) ? '발목 통증 보고' : '',
    equipment: ['equipment', 'both'].includes(status) ? '이륜차 브레이크 이상 보고' : '',
    action: status === 'body' ? '건강 상태 확인 · 후속 진료 확인 대기'
      : status === 'equipment' ? '9/24 정비 의뢰 · 정비 완료 9/26, 브레이크 교체 및 시운전 확인'
      : status === 'both' ? '건강 상태 확인 완료 · 대체 장비 인계, 정비 완료 기록'
      : status === 'missing' ? '귀국 여부 확인 연락 예정' : '-',
  })),
  notices: [{ title: '우천 시 배달 안전수칙', targets: day.statuses.filter(s => s !== 'absent').length, confirmed: day.statuses.filter(s => s !== 'absent').length - (day.date === '2026-09-24' ? 1 : 0) }],
  alerts: [
    { title: '예시 1·2구 도로 침수, 우회 안내', targets: 5, confirmed: 4, phoneConfirmed: 1 },
    { title: '예시 3구 공사 구간 서행 안내', targets: 3, confirmed: 3 },
  ],
  calls: [
    { source: '수신 통화', text: '도로 침수 접수 → 예시 1·2구 5명에게 알림 발송' },
    { source: '수신 통화', text: '알림 미확인 직원 1명에게 우회 안내 · 앱 확인과 별도 기록' },
    { source: '앱 전화 요청', text: '전화 버튼 요청 1건 · 실제 통화 완료 여부 별도 확인' },
  ],
}));
function summarizeStatsSample(days) {
  const rows = days.flatMap(day => day.rows), active = rows.filter(r => r.status !== 'absent');
  const reports = active.filter(r => r.status !== 'missing');
  const notices = days.flatMap(day => day.notices), alerts = days.flatMap(day => day.alerts);
  const sum = (items, key) => items.reduce((total, item) => total + (item[key] || 0), 0);
  return {
    total: rows.length, absent: rows.length - active.length, target: active.length, reported: reports.length,
    missing: active.length - reports.length, normal: reports.filter(r => r.status === 'normal').length,
    body: reports.filter(r => r.body).length, equipment: reports.filter(r => r.equipment).length,
    both: reports.filter(r => r.body && r.equipment).length, issue: reports.filter(r => r.body || r.equipment).length,
    notices: notices.length, noticeTargets: sum(notices, 'targets'), noticeConfirmed: sum(notices, 'confirmed'),
    alerts: alerts.length, alertTargets: sum(alerts, 'targets'), alertConfirmed: sum(alerts, 'confirmed'), alertPhoneConfirmed:sum(alerts,'phoneConfirmed'),
    alertUnconfirmed:alerts.reduce((n,a)=>n+a.targets-a.confirmed-(a.phoneConfirmed||0),0),
    calls: days.flatMap(day => day.calls).length,
  };
}
function sampleStaffTable(day) {
  const labels = { body: '건강 이상', equipment: '장비 이상', both: '건강·장비 이상', normal: '이상 없음', missing: '미보고', absent: '결원' };
  return `<div class="sample-table-wrap"><table class="sample-table"><caption>${day.date} 직원별 기록 (가상)</caption><thead><tr><th>직원 / 집배구</th><th>귀국보고</th><th>건강</th><th>장비</th><th>조치 / 결원 사유</th></tr></thead><tbody>${day.rows.map(r => `<tr><td>${esc(r.name)}<br>${esc(r.zone)}</td><td>${labels[r.status]}</td><td>${r.status === 'absent' ? '집계 제외' : r.status === 'missing' ? '미확인' : r.body || '이상 없음'}</td><td>${r.status === 'absent' ? '집계 제외' : r.status === 'missing' ? '미확인' : r.equipment || '이상 없음'}</td><td>${r.absence || r.action}</td></tr>`).join('')}</tbody></table></div>`;
}
function sampleDailyMessages(day) {
  const notices=day.notices.map(n=>`<div class="detailbox"><b>공지 · ${n.title}</b><br>${n.body}<br>대상 ${n.targets}명 · 앱 확인 ${(n.recipientNames||[]).slice(0,n.confirmed).map(esc).join(', ')||'없음'} · 미확인 ${(n.recipientNames||[]).slice(n.confirmed).map(esc).join(', ')||'없음'}</div>`).join('');
  const alerts=day.alerts.map(a=>`<div class="detailbox"><b>배달위험 알림 · ${a.title}</b><br>대상 ${a.targets}명 · 앱 확인 ${(a.recipientNames||[]).slice(0,a.confirmed).map(esc).join(', ')||'없음'} · 전화 안내 ${(a.recipientNames||[]).slice(a.confirmed,a.confirmed+(a.phoneConfirmed||0)).map(esc).join(', ')||'없음'} · 미확인 ${(a.recipientNames||[]).slice(a.confirmed+(a.phoneConfirmed||0)).map(esc).join(', ')||'없음'}<br>전화 안내 완료자는 전화확인으로 분류하고 미확인·재알림 대상에서 제외</div>`).join('');
  const calls=day.calls.map(c=>`<div class="detailbox"><b>통화 메모 · ${c.at}</b><br>${c.text}<br>기록 시각 자동 저장 · 전화 녹음 없음 · 이후 전파 알림과 확인 이력 연결</div>`).join('');
  return `<details open><summary>${day.date} · 공지 ${day.notices.length}건 · 배달위험 알림 ${day.alerts.length}건 · 통화 ${day.calls.length}건</summary>${notices}${alerts}${calls}</details>`;
}
function renderStatsSample(mode = 'day') {
  const roster=(typeof S!=='undefined'&&S?.roster)||[], zones=(typeof S!=='undefined'&&S?.zones)||[];
  const days = (mode === 'month' ? SAFETY_STATS_SAMPLE : SAFETY_STATS_SAMPLE.slice(-1)).map(day=>{
    const priority=day.rows.filter(r=>r.status!=='normal'),normal=day.rows.filter(r=>r.status==='normal');
    const sampleRows=roster.length?([...priority,...normal].slice(0,roster.length)):day.rows;
    const rows=sampleRows.map((r,index)=>{const person=roster[index],zone=person&&zones.find(z=>z.id===person.zone);return {...r,name:person?.name||['김철수','정민수','최은비','윤서진','한지우','오태민','강도현','임재원','박서연','이도윤'][index%10],zone:zone?.name||`예시 ${index%3+1}구`}});
    const active=rows.filter(r=>r.status!=='absent').length;
    const names=rows.map(r=>r.name);
    return {...day,rows,notices:day.notices.map(n=>({...n,body:'우천 시 미끄럼 주의 및 배달로 변경 안내',targets:active,confirmed:Math.max(0,active-(day.date==='2026-09-24'?1:0)),recipientNames:names.slice(0,active)})),alerts:day.alerts.map(a=>{const targets=Math.min(a.targets,names.length),confirmed=Math.min(a.confirmed,targets);return {...a,targets,confirmed,phoneConfirmed:Math.min(a.phoneConfirmed||0,Math.max(0,targets-confirmed)),recipientNames:names.slice(0,targets)}}),calls:day.calls.map((c,index)=>({...c,at:`${day.date} ${index===0?'17:32':'17:48'}`,recipientNames:names.slice(0,index===0?5:1)}))};
  });
  const q = summarizeStatsSample(days), unit = mode === 'month' ? '인원·일' : '명';
  const dailyRows = days.map(day => ({ day, stats: summarizeStatsSample([day]) }));
  const activeDays = dailyRows.filter(x => x.stats.target > 0).length;
  const avgRoster = activeDays ? (q.target / activeDays).toFixed(1) : '0';
  $('sampleDay').setAttribute('aria-pressed', mode === 'day'); $('sampleMonth').setAttribute('aria-pressed', mode === 'month');
  const metrics = mode === 'month' ? [
    ['일평균 근무대상', avgRoster, ''], ['귀국보고', `${q.reported}/${q.target}`, 'returned'], ['미보고', q.missing, 'issue'],
    ['이상 없음', q.normal, 'returned'], ['건강 이상', q.body, 'issue'], ['장비 이상', q.equipment, 'issue'],
    ['건강·장비 동시 이상 인원·일', q.both, 'issue'], ['확인일수', activeDays, ''],
  ] : [
    ['근무대상', q.target, ''], ['귀국보고', q.reported, 'returned'], ['미보고', q.missing, 'issue'],
    ['이상 없음', q.normal, 'returned'], ['건강 이상', q.body, 'issue'], ['장비 이상', q.equipment, 'issue'], ['건강·장비 동시 이상', q.both, 'issue'],
  ];
  $('statsSample').innerHTML = `<p class="sample-note"><b>${mode === 'month' ? '2026년 9월 · 기록이 있는 3일 예시 (22~24일)' : '2026년 9월 24일 · 18:00 기준'}</b></p>
    <div class="sample-metrics">${metrics.map(([label, value, type]) => `<button type="button" class="sample-metric ${type}" onclick="document.getElementById('sampleDetail').scrollIntoView({behavior:'smooth',block:'start'})"><span>${label}</span><b>${value}<small style="font-size:12px;font-weight:400"> ${unit}</small></b></button>`).join('')}</div>
    <p class="sample-note">${mode === 'month' ? `월간 근무대상 ${q.target}인원·일 · 귀국보고 ${q.reported} + 미보고 ${q.missing} = 근무대상 ${q.target}인원·일` : `근무대상 ${q.target}명 · 귀국보고 ${q.reported} + 미보고 ${q.missing} = 근무대상 ${q.target}명`}<br>
    건강·장비 동시 이상 ${q.both}명은 두 항목에 각각 포함됩니다. 미보고는 이상 없음에 포함하지 않습니다.
    ${mode === 'month' ? '<br>월간 숫자는 날짜별 인원·일 합계입니다. 같은 직원의 여러 날 보고는 각 근무일로 계산하며, 건강·장비 이상은 두 항목 모두 이상인 직원을 각각 포함합니다. 결원은 월간 핵심 지표에서 제외합니다.' : ''}</p>
    <div id="sampleDetail">${mode === 'month' ? `<div class="sample-table-wrap"><table class="sample-table"><caption>날짜별 집계</caption><thead><tr><th>날짜</th><th>근무대상</th><th>보고</th><th>미보고</th><th>이상 없음</th><th>건강 이상</th><th>장비 이상</th></tr></thead><tbody>${dailyRows.map(({day,stats:d}) => `<tr><td>${day.date}</td><td>${d.target}</td><td>${d.reported}</td><td>${d.missing}</td><td>${d.normal}</td><td>${d.body}</td><td>${d.equipment}</td></tr>`).join('')}</tbody></table></div>${days.map(sampleDailyMessages).join('')}` : sampleStaffTable(days[0])}
    <h3>공지 · 배달위험 알림 · 통화 기록</h3><div class="sample-activity"><div><b>공지 ${q.notices}건</b><p>대상 ${q.noticeTargets}명 · 앱 확인 ${q.noticeConfirmed}명 · 미확인 ${q.noticeTargets - q.noticeConfirmed}명</p></div>
    <div><b>위험 알림 ${q.alerts}건</b><p>발송별 대상 합계 ${q.alertTargets}명 · 앱 확인 ${q.alertConfirmed}명 · 전화 확인 ${q.alertPhoneConfirmed}명 · 미확인 ${q.alertUnconfirmed}명</p></div>
    <div><b>통화 기록 ${q.calls}건</b><p>수신 통화 ${days.length * 2}건 · 앱 전화 요청 ${days.length}건</p></div></div>
    <p class="sample-note">알림 대상·확인은 발송 건별 합계입니다. 같은 직원에게 두 번 발송하면 각각 집계합니다. 전화 안내 완료는 앱 확인과 구분하되, 후속조치가 기록되면 미확인·재알림 대상에서 제외합니다.</p>
    <div class="sample-table-wrap"><table class="sample-table"><caption>9월 24일 전파·통화 예시 · 가상 이력</caption><thead><tr><th>구분</th><th>내용</th><th>확인자 / 미확인자</th><th>후속 이력</th></tr></thead><tbody><tr><td>음성 위험신고</td><td>${esc(days.at(-1).rows[0]?.name||'집배원')} 신고: 도로 침수 구간 확인, 우회 필요<br>신고 음성 녹음과 변환 문구를 원본에서 확인</td><td>-</td><td>관제실 검토 후 해당 집배구에 위험 알림 전파</td></tr>${days.at(-1).notices.map(n => `<tr><td>공지</td><td>${n.title}<br>${n.body||''}</td><td>${n.recipientNames.slice(0,n.confirmed).map(esc).join(', ')||'명부 없음'} 확인<br>${n.recipientNames.slice(n.confirmed).map(esc).join(', ')||'미확인 없음'} 미확인</td><td>발송 ${n.confirmed}/${n.targets}명 확인</td></tr>`).join('')}${days.at(-1).alerts.map(a => `<tr><td>위험 알림</td><td>${a.title}</td><td>${a.recipientNames.slice(0,a.confirmed).map(esc).join(', ')||'명부 없음'} 앱 확인<br>${a.recipientNames.slice(a.confirmed,a.confirmed+(a.phoneConfirmed||0)).map(esc).join(', ')||'없음'} 전화 확인<br>${a.recipientNames.slice(a.confirmed+(a.phoneConfirmed||0)).map(esc).join(', ')||'미확인 없음'} 미확인</td><td>전화 안내 기록 시 확인 상태 전환 및 재알림 해제</td></tr>`).join('')}${days.at(-1).calls.map(c => `<tr><td>${c.source}</td><td>${c.text}<br>통화 메모 시각 자동 저장 · 녹음 없음</td><td>-</td><td>위험 알림 발송 및 확인 이력 연결</td></tr>`).join('')}</tbody></table></div>
    ${mode === 'month' ? days.map(day => `<details open><summary>${day.date} 직원별 원자료 · 귀국보고·미보고·건강/장비 이상·조치</summary>${sampleStaffTable(day)}</details>`).join('') : ''}</div>`;
}
