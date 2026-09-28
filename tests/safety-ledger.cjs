const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('public/safety.html', 'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
assert.doesNotMatch(html, /rdeadline_|DueStart|DueEnd|조치 기한|기한 초과/);
const routes = {};
const report = { bodyIssue: true, equipmentIssue: true, bodyDetail: '발목 통증', equipmentDetail: '브레이크 이상', at: '2026-09-27T09:00:00Z', actions: {
  health: { status: 'in_progress', detail: '진료 안내', dueDate: '2026-10-10', history: [], requestedAt: '2026-09-27T10:00:00Z' },
  equipment: { status: 'in_progress', detail: '정비 의뢰' },
} };
const SAFE = { returns: { '2026-09-27': { c1: report, c2: { ...report, bodyIssue: false, equipmentIssue: false, bodyDetail: '', equipmentDetail: '' } }, '2026-09-28': { c1: { ...report } } } };
const ctx = vm.createContext({ SAFE, Date, app: {
  get: (path, handler) => routes[path] = handler,
  post: (path, handler) => routes[path] = handler,
}, userFromReq: req => req.user, isSafetyCtl: u => u?.kind === 'safety',
ensureSafetyCollections() {}, saveSafety() {}, broadcastSafety() {},
  returnRows: date => Object.entries(SAFE.returns[date]).map(([id, report]) => ({ id, name: id === 'c1' ? '김직원' : '박직원', zoneName: '1구', report })),
});
function load(begin, end) { vm.runInContext(source.slice(source.indexOf(begin), source.indexOf(end, source.indexOf(begin))), ctx); }
load("app.get('/api/safety/ledger'", "app.post('/api/safety/config/zones'");
load("app.post('/api/on/returns/:cid/action'", "app.get('/api/on/notices'");
const user = { kind: 'safety', name: '담당자' };
function call(path, req) {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  routes[path](req, res); return res;
}
const query = { kind: 'health', start: '2026-09-27', end: '2026-09-27' };
let res = call('/api/safety/ledger', { user, query });
assert.equal(res.body.rows.length, 2, 'include normal reports and filter by report date, not action deadline');
assert.equal(res.body.rows[0].date, '2026-09-27');
assert.equal(res.body.rows.find(row => row.id === 'c2').report.bodyIssue, false, 'normal report is present in the ledger');
assert.equal(call('/api/safety/ledger', { query }).code, 403);
assert.equal(call('/api/safety/ledger', { user, query: { ...query, start: '2026-10-01' } }).code, 400);
const actionRequest = { user, params: { cid: 'c1' }, body: { date: '2026-09-27', kind: 'health', detail: '진료 후 상태 확인', status: 'done', completedDetail: '치료 완료' } };
res = call('/api/on/returns/:cid/action', actionRequest);
assert.equal(res.body.ok, true);
assert.equal(report.actions.health.dueDate, undefined);
assert.equal(report.actions.health.history[0].detail, '진료 안내');
assert.ok(report.actions.health.completedAt);
assert.equal(report.actions.equipment.detail, '정비 의뢰');
assert.equal(call('/api/on/returns/:cid/action', { ...actionRequest, body: { ...actionRequest.body, completedDetail: '' } }).code, 400);

const elements = { includePilotDemo: { checked: false } };
for (const kind of ['health', 'equipment']) {
  elements[kind + 'Start'] = { value: '2026-09-27' };
  elements[kind + 'End'] = { value: '2026-09-27' };
  elements[kind + 'LedgerView'] = { innerHTML: '', textContent: '' };
}
let printed = '', prints = 0, blocked = false, message = '';
const ui = vm.createContext({ Date, URLSearchParams, S: { roster: Array.from({length:8},(_,i)=>({id:`c${i+1}`,name:`집배원${i+1}`,zone:`z${i+1}`})), zones: [] }, $: id => elements[id],
  managementLedgerData: { health: [], equipment: [] }, managementLedgerRanges: { health: {}, equipment: {} },
  esc: text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  evidenceTime: t => t ? new Date(t).toISOString() : '-', actionStatusLabel: s => s || '미기록',
  toast: text => message = text,
  api: async path => {
    const query = Object.fromEntries(new URL(path, 'https://local.test').searchParams);
    const res = call('/api/safety/ledger', { user, query });
    return { ...res.body, rows: [...res.body.rows, { ...res.body.rows[0], id: 'c2', name: '다른직원' }] };
  },
  window: { open: () => blocked ? null : ({ closed: false, focus() {}, print() { prints++; },
    document: { write: text => printed = text, close() {}, fonts: { ready: Promise.resolve() } } }) },
});
vm.runInContext(fs.readFileSync('public/safety-pilot-demo.js', 'utf8'), ui);
vm.runInContext(html.slice(html.indexOf('function pilotRosterPerson('), html.lastIndexOf('</script>')), ui);
(async () => {
  await ui.runManagementLedger('health');
  assert.match(elements.healthLedgerView.innerHTML, /개별 출력/);
  assert.match(elements.healthLedgerView.innerHTML, /조치 수정/);
  elements.healthStart.value = '2026-10-01'; // Unsubmitted changes must not relabel the printout.
  await ui.printManagementLedger('health', 'c1');
  assert.equal(prints, 1);
  assert.match(printed, /건강관리대장/);
  assert.match(printed, /2026-09-27 ~ 2026-09-27/);
  assert.match(printed, /치료 완료/);
  assert.match(printed, /진료 안내/);
  assert.doesNotMatch(printed, /다른직원|브레이크|정비 의뢰|기한/);
  await ui.runManagementLedger('equipment');
  report.equipmentDetail = '<img src=x onerror=alert(1)>';
  await ui.printManagementLedger('equipment', 'c1');
  assert.match(printed, /장비관리대장/);
  assert.match(printed, /&lt;img/);
  assert.doesNotMatch(printed, /<img|발목|치료 완료|진료 안내|다른직원/);
  blocked = true;
  await ui.printManagementLedger('health', 'c1');
  assert.match(message, /팝업/);
  elements.includePilotDemo.checked = true;
  await ui.clearLedgerDates('health');
  assert.ok(ui.managementLedgerData.health.some(r => r.demo));
  elements.healthStart.value = elements.healthEnd.value = '2026-09-26';
  await ui.runManagementLedger('health');
  assert.ok(ui.managementLedgerData.health.filter(r => r.demo).every(r => r.date === '2026-09-26'));
  console.log('PASS: ledger report-date filtering, deadline-free actions, individual health/equipment printing and escaping');
})().catch(error => { console.error(error); process.exitCode = 1; });
