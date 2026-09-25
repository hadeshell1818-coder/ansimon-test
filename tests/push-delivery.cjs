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
  app: { post(path, handler) { routes[path] = handler; } },
  userFromReq: req => req.user, isSafetyCtl: () => true,
  rosterById: id => id === 'jip', nextSafeId: () => `N${++sequence}`,
  console,
});

vm.runInContext(source.slice(source.indexOf('async function sendPush('), source.indexOf("app.post('/api/safety/alerts'")), context);
vm.runInContext(source.slice(source.indexOf("app.post('/api/on/notices'"), source.indexOf("app.post('/api/on/notices/:id/ack'")), context);

(async () => {
  for (const level of ['urgent', 'caution', 'notice']) {
    await context.sendSafetyPush({ id: `A-${level}`, level, text: `${level} message`, targets: ['jip'] });
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.payload.url), [
    '/report.html?alert=A-urgent', '/report.html?alert=A-caution', '/report.html?alert=A-notice',
  ]);
  assert.deepEqual(calls.map(call => call.options.urgency), ['high', 'normal', 'normal']);

  const response = { json(data) { this.data = data; return this; } };
  routes['/api/on/notices']({
    user: { id: 'control', name: '관제실' },
    body: { title: '근무 안내', body: '오늘 일정 확인', targets: ['jip'] },
  }, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.data.ok, true);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].payload.title, '공지사항 · 근무 안내');
  assert.equal(calls[3].payload.url, '/report.html?notice=N1');
  console.log('PASS: urgent, caution, notice and announcement push delivery');
})().catch(error => { console.error(error); process.exitCode = 1; });
