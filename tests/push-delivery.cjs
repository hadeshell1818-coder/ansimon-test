const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('server.js', 'utf8');
const calls = [];
const routes = {};
const SAFE = { pushSubscriptions: { jip: [{ endpoint: 'https://push.example/jip' }] }, notices: [] };
let sequence = 0;
const context = vm.createContext({
  PUSH_ENABLED: true, SAFE, LEVELS: { urgent: '긴급', caution: '주의', notice: '전달말씀' },
  ensureSafetyCollections() {}, saveSafety() {}, broadcastSafety() {},
  webpush: { async sendNotification(subscription, payload, options) {
    calls.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
  } },
  app: {
    post(path, handler) { routes[`POST ${path}`] = handler; },
    patch(path, handler) { routes[`PATCH ${path}`] = handler; },
    delete(path, handler) { routes[`DELETE ${path}`] = handler; },
  },
  userFromReq: req => req.user, isSafetyCtl: () => true,
  safetyCarrier: user => user?.id === 'jip' ? { id: 'jip' } : null,
  rosterById: id => id === 'jip', nextSafeId: () => `N${++sequence}`,
  console,
});

vm.runInContext(source.slice(source.indexOf('async function sendPush('), source.indexOf("app.post('/api/safety/alerts'")), context);
vm.runInContext(source.slice(source.indexOf("app.patch('/api/safety/alerts/:id'"), source.indexOf("app.get('/api/push/config'")), context);
vm.runInContext(source.slice(source.indexOf("app.post('/api/on/notices'"), source.indexOf("app.post('/api/on/notices/:id/ack'")), context);
vm.runInContext(source.slice(source.indexOf("app.post('/api/safety/alerts/:id/ack'"), source.indexOf("app.post('/api/safety/calls'")), context);
vm.runInContext(source.slice(source.indexOf("app.post('/api/on/notices/:id/ack'"), source.indexOf("app.get('/api/safety/history'")), context);

(async () => {
  for (const level of ['urgent', 'caution', 'notice']) {
    await context.sendSafetyPush({ id: `A-${level}`, level, text: `${level} message`, targets: ['jip'] });
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.payload.url), [
    '/report.html?alert=A-urgent', '/report.html?alert=A-caution', '/report.html?alert=A-notice',
  ]);
  assert.deepEqual(calls.map(call => call.options.urgency), ['high', 'normal', 'normal']);

  const response = { status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  routes['POST /api/on/notices']({
    user: { id: 'control', name: '관제실' },
    body: { title: '근무 안내', body: '오늘 일정 확인', targets: ['jip'] },
  }, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.data.ok, true);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].payload.title, '공지사항 · 근무 안내');
  assert.equal(calls[3].payload.url, '/report.html?notice=N1');
  assert.equal(SAFE.notices[0].repeatUntilAck, true);

  const now = Date.now();
  SAFE.alerts = [{ id: 'A-repeat', level: 'caution', text: '주의 재알림', targets: ['jip', 'done'],
    acks: { done: new Date().toISOString() }, repeatUntilAck: true, lastPushAt: now - 120000 }];
  SAFE.notices[0].lastPushAt = now - 120000;
  await context.resendUnacknowledged(now);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.slice(4).map(call => call.endpoint), [
    'https://push.example/jip', 'https://push.example/jip',
  ]);
  assert.deepEqual(calls.slice(4).map(call => call.options.TTL), [120, 120]);
  await context.resendUnacknowledged(now + 1000);
  assert.equal(calls.length, 6);
  routes['POST /api/safety/alerts/:id/ack']({ user: { id: 'jip' }, params: { id: 'A-repeat' } }, response);
  routes['POST /api/on/notices/:id/ack']({ user: { id: 'jip' }, params: { id: 'N1' } }, response);
  assert.ok(SAFE.alerts[0].acks.jip);
  assert.ok(SAFE.notices[0].acks.jip);
  await context.resendUnacknowledged(now + 120000);
  assert.equal(calls.length, 6);
  assert.equal(SAFE.alerts[0].repeatUntilAck, false);
  assert.equal(SAFE.notices[0].repeatUntilAck, false);
  SAFE.alerts[0].version = 1;
  routes['PATCH /api/safety/alerts/:id']({ user: { name: '관제실' }, params: { id: 'A-repeat' },
    body: { level: 'notice', text: '도로 적체 해소' } }, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(SAFE.alerts[0].version, 2);
  assert.equal(SAFE.alerts[0].text, '도로 적체 해소');
  assert.equal(SAFE.alerts[0].repeatUntilAck, true);
  assert.equal(Object.keys(SAFE.alerts[0].acks).length, 0);
  assert.equal(calls.at(-1).payload.body, '도로 적체 해소');
  routes['POST /api/safety/alerts/:id/ack']({ user: { id: 'jip' }, params: { id: 'A-repeat' },
    body: { version: 1 } }, response);
  assert.equal(response.code, 409);
  assert.equal(Object.keys(SAFE.alerts[0].acks).length, 0);
  routes['DELETE /api/safety/alerts/:id']({ user: { name: '관제실' }, params: { id: 'A-repeat' } }, response);
  assert.ok(SAFE.alerts[0].deletedAt);
  assert.equal(SAFE.alerts[0].repeatUntilAck, false);
  const count = calls.length;
  await context.resendUnacknowledged(now + 240000);
  assert.equal(calls.length, count);
  console.log('PASS: initial push, two-minute repeat, recipient filtering, confirmation stop');
})().catch(error => { console.error(error); process.exitCode = 1; });
