const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const handlers = {};
const calls = [];
const context = vm.createContext({
  URL,
  self: {
    location: { origin: 'https://ansimon.example' },
    addEventListener(type, handler) { handlers[type] = handler; },
    registration: { showNotification(title, options) { calls.push({ title, options }); } },
  },
  clients: {
    async openWindow(url) { calls.push({ opened: url }); return {
      async focus() { calls.push({ focused: 'opened' }); },
      postMessage(message) { calls.push({ message }); },
    }; },
    async matchAll() { throw Error('Existing windows should not be needed'); },
  },
});
vm.runInContext(fs.readFileSync('public/sw.js', 'utf8'), context);

(async () => {
  let pending;
  handlers.push({
    data: { json: () => ({ title: '안심ON · 긴급', body: '점검', type: 'urgent', alertId: 'A1', url: '/report.html?alert=A1' }) },
    waitUntil(promise) { pending = promise; },
  });
  await pending;
  assert.equal(calls[0].options.icon, '/icons/icon-192.png');
  assert.equal(calls[0].options.badge, '/icons/notification-badge.png');

  handlers.notificationclick({
    notification: { data: { url: '/report.html?alert=A1' }, close() { calls.push({ closed: true }); } },
    waitUntil(promise) { pending = promise; },
  });
  await pending;
  assert.equal(calls.find(call => call.opened)?.opened, 'https://ansimon.example/report.html?alert=A1');
  assert.ok(calls.some(call => call.focused === 'opened'));
  assert.ok(calls.some(call => call.message?.alertId === 'A1'));

  context.clients.openWindow = async () => { throw Error('Opening blocked'); };
  context.clients.matchAll = async () => [{
    url: 'https://ansimon.example/report.html',
    async focus() { calls.push({ focused: 'existing' }); },
    async navigate(url) { calls.push({ navigated: url }); },
    postMessage(message) { calls.push({ message }); },
  }];
  handlers.notificationclick({
    notification: { data: { url: '/report.html?notice=N1' }, close() {} },
    waitUntil(promise) { pending = promise; },
  });
  await pending;
  assert.ok(calls.some(call => call.focused === 'existing'));
  assert.ok(calls.some(call => call.navigated === 'https://ansimon.example/report.html?notice=N1'));
  assert.ok(calls.some(call => call.message?.noticeId === 'N1'));
  console.log('PASS: ON badge and notification tap opens or focuses report');
})().catch(error => { console.error(error); process.exitCode = 1; });
