// Display-only examples. These records are never submitted to the application API.
const SAFETY_STATS_SAMPLE = [
  { date: '2026-09-22', statuses: ['body', 'equipment', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'absent'] },
  { date: '2026-09-23', statuses: ['body', 'both', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'absent', 'absent'] },
  { date: '2026-09-24', statuses: ['body', 'equipment', 'both', 'normal', 'normal', 'normal', 'normal', 'missing', 'absent', 'absent'] },
].map(day => ({
  date: day.date,
  rows: day.statuses.map((status, index) => ({
    id: 'sample-' + index, name: '가상직원 ' + String(index + 1).padStart(2, '0'), zone: '예시 ' + (index % 3 + 1) + '구', status,
    absence: status === 'absent' ? (index === 9 ? '연가' : '교육') : '',
    body: ['body', 'both'].includes(status) ? '발목 통증 보고' : '',
    equipment: ['equipment', 'both'].includes(status) ? '이륜차 브레이크 이상 보고' : '',
    action: status === 'body' ? '상태 확인 및 후속 확인 기록 · 조치 중'
      : status === 'equipment' ? '차량 사용 중지 및 정비 의뢰 · 조치 중'
      : status === 'both' ? '건강 상태 확인, 대체 장비 인계 · 조치 완료'
      : status === 'missing' ? '귀국 여부 확인 연락 예정' : '-',
  })),
  notices: [{ title: '우천 시 배달 안전수칙', targets: day.statuses.filter(s => s !== 'absent').length, confirmed: day.statuses.filter(s => s !== 'absent').length - (day.date === '2026-09-24' ? 1 : 0) }],
  alerts: [
    { title: '예시 1·2구 도로 침수, 우회 안내', targets: 5, confirmed: 4 },
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
  const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
  return {
    total: rows.length, absent: rows.length - active.length, target: active.length, reported: reports.length,
    missing: active.length - reports.length, normal: reports.filter(r => r.status === 'normal').length,
    body: reports.filter(r => r.body).length, equipment: reports.filter(r => r.equipment).length,
    both: reports.filter(r => r.body && r.equipment).length, issue: reports.filter(r => r.body || r.equipment).length,
    notices: notices.length, noticeTargets: sum(notices, 'targets'), noticeConfirmed: sum(notices, 'confirmed'),
    alerts: alerts.length, alertTargets: sum(alerts, 'targets'), alertConfirmed: sum(alerts, 'confirmed'),
    calls: days.flatMap(day => day.calls).length,
  };
}
function sampleStaffTable(day) {
  const labels = { body: '건강 이상', equipment: '장비 이상', both: '건강·장비 이상', normal: '이상 없음', missing: '미보고', absent: '결원' };
  return `<div class="sample-table-wrap"><table class="sample-table"><caption>${day.date} 직원별 기록 (가상)</caption><thead><tr><th>직원 / 집배구</th><th>귀국보고</th><th>건강</th><th>장비</th><th>조치 / 결원 사유</th></tr></thead><tbody>${day.rows.map(r => `<tr><td>${r.name}<br>${r.zone}</td><td>${labels[r.status]}</td><td>${r.status === 'absent' ? '집계 제외' : r.status === 'missing' ? '미확인' : r.body || '이상 없음'}</td><td>${r.status === 'absent' ? '집계 제외' : r.status === 'missing' ? '미확인' : r.equipment || '이상 없음'}</td><td>${r.absence || r.action}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderStatsSample(mode = 'day') {
  const days = mode === 'month' ? SAFETY_STATS_SAMPLE : SAFETY_STATS_SAMPLE.slice(-1);
  const q = summarizeStatsSample(days), unit = mode === 'month' ? '인원·일' : '명';
  $('sampleDay').setAttribute('aria-pressed', mode === 'day'); $('sampleMonth').setAttribute('aria-pressed', mode === 'month');
  const metrics = [
    ['총원', q.total, ''], ['결원', q.absent, ''], ['현원', q.target, ''], ['귀국보고', q.reported, 'returned'], ['미보고', q.missing, 'issue'],
    ['이상 없음', q.normal, 'returned'], ['건강 이상', q.body, 'issue'], ['장비 이상', q.equipment, 'issue'], ['건강·장비 동시 이상', q.both, 'issue'], ['이상 보고자 (중복 제외)', q.issue, 'issue'],
  ];
  $('statsSample').innerHTML = `<p class="sample-note"><b>${mode === 'month' ? '2026년 9월 · 기록이 있는 3일 합계 (22~24일)' : '2026년 9월 24일 · 18:00 기준'}</b></p>
    <div class="sample-metrics">${metrics.map(([label, value, type]) => `<div class="sample-metric ${type}"><span>${label}</span><b>${value}<small style="font-size:12px;font-weight:400"> ${unit}</small></b></div>`).join('')}</div>
    <p class="sample-note">총원 ${q.total} − 결원 ${q.absent} = <b>현원 ${q.target}</b> · 귀국보고 ${q.reported} + 미보고 ${q.missing} = 현원 ${q.target}<br>
    건강 이상 ${q.body} + 장비 이상 ${q.equipment} − 동시 이상 ${q.both} = <b>이상 보고자 ${q.issue}</b>. 미보고는 이상 없음에 포함하지 않습니다.
    ${mode === 'month' ? '<br>월별 인원·일은 날짜별 인원의 합입니다. 같은 직원이 3일 보고하면 3인원·일이며, 서로 다른 직원 3명을 뜻하지 않습니다.' : ''}</p>
    ${mode === 'month' ? `<div class="sample-table-wrap"><table class="sample-table"><caption>날짜별 집계</caption><thead><tr><th>날짜</th><th>총원</th><th>결원</th><th>현원</th><th>보고</th><th>미보고</th><th>건강 이상</th><th>장비 이상</th></tr></thead><tbody>${days.map(day => { const d = summarizeStatsSample([day]); return `<tr><td>${day.date}</td><td>${d.total}</td><td>${d.absent}</td><td>${d.target}</td><td>${d.reported}</td><td>${d.missing}</td><td>${d.body}</td><td>${d.equipment}</td></tr>`; }).join('')}</tbody></table></div>` : sampleStaffTable(days[0])}
    <h3>공지 · 배달위험 알림 · 통화 기록</h3><div class="sample-activity"><div><b>공지 ${q.notices}건</b><p>대상 ${q.noticeTargets}명 · 앱 확인 ${q.noticeConfirmed}명 · 미확인 ${q.noticeTargets - q.noticeConfirmed}명</p></div>
    <div><b>위험 알림 ${q.alerts}건</b><p>발송별 대상 합계 ${q.alertTargets}명 · 앱 확인 ${q.alertConfirmed}명 · 미확인 ${q.alertTargets - q.alertConfirmed}명</p></div>
    <div><b>통화 기록 ${q.calls}건</b><p>수신 통화 ${days.length * 2}건 · 앱 전화 요청 ${days.length}건</p></div></div>
    <p class="sample-note">알림 대상·확인은 발송 건별 합계입니다. 같은 직원에게 두 번 발송하면 각각 집계합니다. 전화로 안내해도 앱 미확인은 자동으로 확인 처리되지 않습니다.</p>
    <div class="sample-table-wrap"><table class="sample-table"><caption>9월 24일 알림·통화 예시</caption><thead><tr><th>구분</th><th>내용</th><th>확인 / 대상</th></tr></thead><tbody>${SAFETY_STATS_SAMPLE[2].notices.map(n => `<tr><td>공지</td><td>${n.title}</td><td>${n.confirmed} / ${n.targets}명</td></tr>`).join('')}${SAFETY_STATS_SAMPLE[2].alerts.map(a => `<tr><td>위험 알림</td><td>${a.title}</td><td>${a.confirmed} / ${a.targets}명</td></tr>`).join('')}${SAFETY_STATS_SAMPLE[2].calls.map(c => `<tr><td>${c.source}</td><td>${c.text}</td><td>-</td></tr>`).join('')}</tbody></table></div>
    ${mode === 'month' ? days.map(day => `<details><summary>${day.date} 직원별 원자료</summary>${sampleStaffTable(day)}</details>`).join('') : ''}`;
}
