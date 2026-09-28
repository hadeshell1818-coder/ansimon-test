const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('public/safety.html', 'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const routes = {};
const at = '2026-09-27T01:00:00.000Z';
const SAFE = {
  seq: 5, zones: [], roster: [], returns: {
    '2026-09-27': {
      c1: { source: 'self', at, bodyIssue: true, equipmentIssue: true,
        bodyDetail: '발목 통증', equipmentDetail: '브레이크 이상',
        action: { detail: '점검 의뢰', owner: '소통실', status: 'in_progress', at } },
    },
  }, absences: {}, rosterSnapshots: {}, hazards: [], calls: [],
  alerts: [{ id: 'A1', level: 'urgent', text: '결빙 주의', sender: '소통실', createdAt: at,
    targets: ['c1', 'c2'], acks: { c1: at }, repeatUntilAck: true, lastPushAt: 0, followups: [] }],
  notices: [{ id: 'N1', title: '안전교육', body: '교육 참석', sender: '소통실', createdAt: at,
    targets: ['c1', 'c2'], acks: { c1: at }, repeatUntilAck: true, lastPushAt: 0 }],
};
const ROSTER = [
  { id: 'c1', name: '김집배', zone: 'z1' },
  { id: 'c2', name: '이집배', zone: 'z1' },
];
const ZONES = [{ id: 'z1', name: '1구역' }];
const ctx = vm.createContext({
  SAFE, ROSTER, ZONES, Date, console,
  app: {
    get(path, handler) { routes['GET ' + path] = handler; },
    post(path, handler) { routes['POST ' + path] = handler; },
  },
  userFromReq: req => req.user, isSafetyCtl: user => user?.kind === 'safety',
  rosterById: id => ROSTER.find(r => r.id === id),
  zoneById: id => ZONES.find(z => z.id === id),
  kstDate: (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10),
  saveSafety() {}, broadcastSafety() {}, hazardForCtl: h => h,
  nextSafeId: prefix => prefix + (++SAFE.seq),
  callForCtl: c => ({ ...c, carrier: c.callerName }),
  createAlert: (_user, body) => {
    const alert = { id: 'A-call', targets: body.zones === 'all' ? ROSTER.map(r => r.id) : ['c1'],
      level: body.level, text: body.text };
    SAFE.alerts.push(alert); return alert;
  },
  sendSafetyPush: async () => {},
});
function load(begin, end) {
  vm.runInContext(source.slice(source.indexOf(begin), source.indexOf(end, source.indexOf(begin))), ctx);
}
load('function ensureSafetyCollections(){', "app.get('/api/on/return/me'");
load("app.post('/api/safety/alerts/:id/reminders/stop'", "app.get('/api/push/config'");
load("app.post('/api/safety/alerts'", "app.patch('/api/safety/alerts/:id'");
load("app.post('/api/safety/calls'", "app.post('/api/safety/calls/:id/note'");
load("app.post('/api/on/notices/:id/reminders/stop'", "app.get('/api/safety/history'");
load("app.get('/api/safety/evidence'", "app.get('/api/safety/config'");
const response = () => ({ code: 200, status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; } });
const user = { kind: 'safety', name: '상황실' };

let res = response();
routes['POST /api/safety/alerts/:id/reminders/stop']({
  user, params: { id: 'A1' }, body: { reason: '전화 후속조치로 전환' },
}, res);
assert.equal(res.body.ok, true);
assert.equal(SAFE.alerts[0].repeatUntilAck, false);
assert.equal(SAFE.alerts[0].targets.length, 2);
assert.equal(Object.keys(SAFE.alerts[0].acks).length, 1);
assert.equal(SAFE.alerts[0].reminderStoppedBy, '상황실');

res = response();
routes['POST /api/safety/alerts/:id/followups']({
  user, params: { id: 'A1' }, body: { targetId: 'c2', status: 'contacted', detail: '09:10 전화로 결빙 구간 우회 안내' },
}, res);
assert.equal(res.body.ok, true);
assert.equal(SAFE.alerts[0].followups[0].targetId, 'c2');
assert.equal(SAFE.alerts[0].acks.c2, undefined, 'phone follow-up must not count as app confirmation');

res = response();
routes['POST /api/on/notices/:id/reminders/stop']({
  user, params: { id: 'N1' }, body: { reason: '교육 종료' },
}, res);
assert.equal(res.body.ok, true);
assert.equal(SAFE.notices[0].repeatUntilAck, false);

res = response();
routes['GET /api/safety/evidence']({ user, query: { start: '2026-09-27', end: '2026-09-27' } }, res);
assert.equal(res.body.summary.alertConfirmed, 1);
assert.equal(res.body.summary.alertTargets, 2);
assert.equal(res.body.summary.noticeConfirmed, 1);
assert.equal(res.body.summary.bodyIssues, 1);
assert.equal(res.body.summary.equipmentIssues, 1);
assert.equal(res.body.summary.bothIssues, 1);
assert.equal(res.body.daily[0].target, 2);
assert.equal(res.body.daily[0].missing, 1);
assert.equal(res.body.daily[0].healthOnly + res.body.daily[0].both, 1);
assert.equal(res.body.daily[0].equipmentOnly + res.body.daily[0].both, 1);
assert.equal(res.body.alerts[0].recipients[1].followups[0].detail, '09:10 전화로 결빙 구간 우회 안내');
assert.equal(res.body.returns.find(r => r.id === 'c1').report.action.detail, '점검 의뢰');
assert.equal(res.body.returns.find(r => r.id === 'c2').report, null);
const evidence = res.body;

res = response();
routes['POST /api/safety/calls/manual']({
  user, body: { carrierId: 'c2', note: '결빙 구간 전화 접수' },
}, res);
assert.equal(res.body.ok, true);
assert.equal(SAFE.calls[0].callerName, '이집배');
assert.equal(SAFE.calls[0].source, 'manual_incoming');
res = response();
routes['POST /api/safety/alerts']({
  user, body: { fromCall: SAFE.calls[0].id, zones: 'all', level: 'urgent', text: '결빙 구간 우회' },
}, res);
assert.equal(res.body.ok, true);
assert.equal(SAFE.calls[0].alertId, 'A-call');
assert.equal(SAFE.alerts.at(-1).fromCall, SAFE.calls[0].id);

const elements = {
  statsMonthField: { classList: { contains: name => name === 'hidden' } },
  statsDay: { value: '2026-09-27' }, statsMonth: { value: '2026-09' },
  evResult: { textContent: '', innerHTML: '' },
};
const element = () => ({ value: '', textContent: '', innerHTML: '',
  classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
});
const ui = vm.createContext({
  $: id => elements[id] || (elements[id] = element()), S: { levels: { urgent: '긴급' } }, Date,
  esc: value => String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char])),
  followupLabel: status => status, api: async () => evidence,
});
vm.runInContext(html.slice(html.indexOf('function openEvidence(){'), html.lastIndexOf('</script>')), ui);
ui.runEvidence().then(() => {
  assert.match(elements.evResult.innerHTML, /공지사항.*안전교육/s);
  assert.match(elements.evResult.innerHTML, /결빙 주의/);
  assert.match(elements.evResult.innerHTML, /전화로 결빙 구간 우회 안내/);
  assert.match(elements.evResult.innerHTML, /김집배.*발목 통증.*브레이크 이상.*점검 의뢰/s);
  assert.match(elements.evResult.innerHTML, /이집배.*미보고/s);
  console.log('PASS: reminder stop, call-linked alert, recipient follow-up and daily evidence UI');
}).catch(error => { console.error(error); process.exitCode = 1; });
