// Fixed, display-only pilot fixtures. These are never sent to the server.
const PILOT_DEMO = (() => {
  const people = [
    { id: 'pilot-demo-01', name: '김도윤', zoneName: '시연 1구' },
    { id: 'pilot-demo-02', name: '박서연', zoneName: '시연 1구' },
    { id: 'pilot-demo-03', name: '이준호', zoneName: '시연 2구' },
    { id: 'pilot-demo-04', name: '최은지', zoneName: '시연 2구' },
    { id: 'pilot-demo-05', name: '정민수', zoneName: '시연 3구' },
    { id: 'pilot-demo-06', name: '한지우', zoneName: '시연 3구' },
    { id: 'pilot-demo-07', name: '윤하늘', zoneName: '시연 4구' },
    { id: 'pilot-demo-08', name: '강태훈', zoneName: '시연 4구' },
  ];
  const at = (date, time) => `${date}T${time}:00+09:00`;
  const nextDate = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const action = (detail, status, requestedAt, completedDetail = '', completedAt = null) => ({
    detail, status, owner: '시연 안전관리담당자', requestedAt: at(requestedAt[0], requestedAt[1]),
    completedDetail, completedAt: completedAt ? at(completedAt[0], completedAt[1]) : null,
  });
  const day = (date, states) => ({
    date,
    returns: states.map((state, index) => {
      const p = people[index];
      const absence = state === 'absent' ? { reason: '교육' } : null;
      const bodyIssue = ['health', 'both'].includes(state);
      const equipmentIssue = ['equipment', 'both'].includes(state);
      if (state === 'missing' || state === 'absent') return { ...p, absence, report: null };
      const report = {
        carrierId: p.id, at: at(date, `${17 + (index % 2)}:${String(12 + index * 4).padStart(2, '0')}`), source: 'self',
        bodyIssue, bodyDetail: bodyIssue ? (state === 'both' ? '오른쪽 손목 통증' : '왼쪽 발목 통증') : '',
        equipmentIssue, equipmentDetail: equipmentIssue ? (state === 'both' ? 'PDA 배터리 접촉 불량' : '이륜차 브레이크 이상') : '',
        actions: {},
      };
      if (state === 'health') {
        const complete = date !== '2026-09-25', followupDay = nextDate(date);
        report.actions.health = action('휴식 안내 후 다음 근무일 상태 확인', complete ? 'done' : 'in_progress', [date, '18:05'], complete ? '통증 호전 확인, 추가 진료 안내' : '', complete ? [followupDay, '09:10'] : null);
      }
      if (state === 'equipment') report.actions.equipment = action('정비소 점검 의뢰 및 운행 전 브레이크 확인', date === '2026-09-25' ? 'done' : 'in_progress', [date, '18:12'], date === '2026-09-25' ? '브레이크 패드 교체 및 시운전 완료' : '', date === '2026-09-25' ? ['2026-09-26', '11:30'] : null);
      if (state === 'both') {
        report.actions.health = action('손목 상태 확인 및 무리한 작업 자제 안내', 'in_progress', [date, '18:20']);
        report.actions.equipment = action('PDA 배터리 접점 점검 요청', 'pending', [date, '18:24']);
      }
      return { ...p, absence: null, report };
    }),
  });
  const days = [
    day('2026-09-25', ['health', 'equipment', 'normal', 'both', 'normal', 'missing', 'absent', 'normal']),
    day('2026-09-26', ['normal', 'health', 'equipment', 'equipment', 'normal', 'normal', 'normal', 'missing']),
    day('2026-09-27', ['health', 'equipment', 'both', 'normal', 'normal', 'missing', 'normal', 'absent']),
  ];
  const recipients = (targetIds, ackIds, phoneIds = [], followups = [], date = '2026-09-27') => targetIds.map(id => {
    const person = people.find(p => p.id === id);
    const followup = followups.filter(f => f.targetId === id);
    return { ...person, ackAt: ackIds.includes(id) ? at(date, '17:40') : null,
      phoneAck: phoneIds.includes(id) ? { at: at(date, '17:55'), by: '시연 상황관제담당자' } : null, followups: followup };
  });
  const all = people.map(p => p.id);
  const alerts = [
    { id: 'pilot-alert-01', date: '2026-09-25', level: 'caution', text: '시연 1·2구 배달로 미끄럼 주의, 우회 배달 바랍니다.', sender: '시연 상황관제담당자',
      targets: all, ackIds: all.slice(0, 6), phoneIds: [all[6]], createdAt: at('2026-09-25', '16:42'), fromCall: null, edits: [], followups: [] },
    { id: 'pilot-alert-02', date: '2026-09-26', level: 'urgent', text: '시연 2구 도로 침수 구간 접근 금지, 우회 바랍니다.', sender: '시연 상황관제담당자',
      targets: all.slice(0, 7), ackIds: all.slice(0, 4), phoneIds: [all[4], all[5]], createdAt: at('2026-09-26', '17:08'), fromCall: 'pilot-call-01', edits: [],
      followups: [{ targetId: all[5], status: 'contacted', detail: '미확인자 전화 연락 완료, 우회 안내 전달', by: '시연 상황관제담당자', at: at('2026-09-26', '17:32') }] },
    { id: 'pilot-alert-03', date: '2026-09-27', level: 'notice', text: '시연 3·4구 배달 종료 전 귀국보고를 확인 바랍니다.', sender: '시연 상황관제담당자',
      targets: all, ackIds: all.slice(0, 5), phoneIds: [], createdAt: at('2026-09-27', '16:55'), fromCall: null, edits: [], followups: [] },
  ].map(a => ({ ...a, demo: true, recipients: recipients(a.targets, a.ackIds, a.phoneIds, a.followups || [], a.date) }));
  const notices = [
    { id: 'pilot-notice-01', date: '2026-09-25', title: '우천 시 배달 안전수칙', body: '젖은 계단과 보도에서는 속도를 줄이고 미끄럼에 주의 바랍니다.', sender: '시연 상황관제담당자', createdAt: at('2026-09-25', '08:10'), targets: all, recipients: recipients(all, all.slice(0, 7), [], [], '2026-09-25'), demo: true },
    { id: 'pilot-notice-02', date: '2026-09-27', title: '귀국보고 확인 안내', body: '배달을 마친 뒤 귀국 여부와 건강·장비 이상을 보고해 주세요.', sender: '시연 상황관제담당자', createdAt: at('2026-09-27', '08:05'), targets: all, recipients: recipients(all, all.slice(0, 6), [], [], '2026-09-27'), demo: true },
  ];
  const hazards = [
    { id: 'pilot-voice-01', carrier: people[1].name, zoneName: people[1].zoneName, transcript: '시연 2구 진입로에 물이 차 있어 오토바이 통행이 어렵습니다. 우회가 필요합니다.', createdAt: at('2026-09-26', '17:02'), audioUrl: null, demo: true },
    { id: 'pilot-voice-02', carrier: people[4].name, zoneName: people[4].zoneName, transcript: '시연 3구 보도블록이 들떠 있어 보행 시 걸려 넘어질 위험이 있습니다.', createdAt: at('2026-09-27', '15:18'), audioUrl: null, demo: true },
  ];
  const calls = [
    { id: 'pilot-call-01', source: 'manual_incoming', carrier: people[1].name, callerName: people[1].name, carrierId: people[1].id, zoneName: people[1].zoneName, phone: '010-0000-0001', note: '시연 2구 도로 침수 신고 접수, 우회 필요 안내', at: at('2026-09-26', '17:05'), notedAt: at('2026-09-26', '17:08'), alertIds: ['pilot-alert-02'], demo: true },
    { id: 'pilot-call-02', source: 'control_confirm', carrier: people[5].name, callerName: people[5].name, carrierId: people[5].id, zoneName: people[5].zoneName, phone: '010-0000-0006', note: '미보고자 전화 확인, 귀국 및 건강·장비 이상 없음 확인', at: at('2026-09-27', '18:02'), notedAt: at('2026-09-27', '18:02'), alertIds: [], demo: true },
  ];
  return { people, days, notices, hazards, calls, alerts };
})();
