const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('public/report.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
assert.match(html, /\.sf-overlay \.otext\{[^}]*min-height:0;overflow-y:auto/);
assert.match(html, /\.sf-overlay button\{[^}]*flex:0 0 auto/);
assert.match(html, /\.sf-overlay\{[^}]*background:var\(--urgent\)/);

const classes = () => {
  const values = new Set();
  return { add: value => values.add(value), remove: value => values.delete(value),
    contains: value => values.has(value), toggle: (value, on) => on ? values.add(value) : values.delete(value) };
};
const elements = Object.fromEntries(['sfOverlay', 'sfOHead', 'sfOMeta', 'sfOText', 'sfOCount', 'sfAckBtn', 'sfModal', 'sfSheet', 'sfInlineAck']
  .map(id => [id, { classList: classes(), dataset: {}, textContent: '', disabled: false }]));
const seen = new Set();
const rings = [];
const acks = [];
const a = (id, version, text, at) => ({ id, version, level: 'urgent', text, createdAt: at,
  sender: '관제실', acked: false });
const older = a('A1', 1, '지난 알림', '2026-09-25T00:00:00Z');
const newer = a('A2', 1, '새 알림', '2026-09-25T01:00:00Z');
const context = vm.createContext({
  SF: { alerts: [older, newer] }, sfActiveAlert: null, sfRequestedAlertId: null,
  SF_LV: { urgent: ['긴급', 'red'] },
  sfSeen: () => new Set(seen), sfMarkSeen: ids => ids.forEach(id => seen.add(id)),
  sfRing: (...args) => rings.push(args), sfTime: value => value, sfEsc: value => value,
  $: id => elements[id], document: { visibilityState: 'hidden' },
  location: { href: 'https://example.test/report.html', search: '' },
  history: { replaceState() {} }, URL, URLSearchParams,
  api: async path => { acks.push(path); return { ok: true }; },
  navigator: { vibrate() {} }, speechSynthesis: { cancel() {} },
  sfRenderTicker() {}, sfLoad() {}, toast() {},
});
vm.runInContext(script.slice(script.indexOf('const sfAlertKey='), script.indexOf('let sfBannerTimer=')), context);

(async () => {
  context.sfHandleAlerts();
  assert.equal(seen.size, 0, 'background receipt must not count as displayed');
  context.document.visibilityState = 'visible';
  context.sfHandleAlerts();
  assert.equal(elements.sfOText.textContent, '새 알림');
  assert.equal(rings.length, 1);
  assert.equal(seen.size, 2);
  context.sfHandleAlerts();
  assert.equal(rings.length, 1, 'resume must not replay the same alert');
  await context.sfAck();
  assert.equal(elements.sfOverlay.classList.contains('on'), false);
  assert.equal(elements.sfModal.classList.contains('on'), false);
  context.sfHandleAlerts();
  assert.equal(elements.sfOverlay.classList.contains('on'), false, 'older alert must not reopen');
  newer.acked = false;
  context.sfHandleAlerts();
  assert.equal(elements.sfOverlay.classList.contains('on'), true, 'latest unacknowledged alert must reopen directly');
  await context.sfAck();
  const legacy = a('A0', 0, '기존 알림 재전송', '2026-09-24T01:00:00Z');
  context.SF.alerts = [legacy];
  context.sfRequestedAlertId = 'A0';
  context.sfHandleAlerts();
  assert.equal(elements.sfOText.textContent, '기존 알림 재전송');
  assert.equal(elements.sfOverlay.classList.contains('on'), true);
  await context.sfAck();
  assert.equal(elements.sfOverlay.classList.contains('on'), false);
  const caution = a('A3', 1, '주의 안내', '2026-09-25T03:00:00Z');
  caution.level = 'caution';
  context.SF_LV.caution = ['주의', 'amber'];
  context.SF.alerts = [caution];
  seen.add('A3:1');
  context.sfHandleAlerts();
  assert.equal(elements.sfOverlay.classList.contains('on'), false);
  assert.equal(elements.sfModal.classList.contains('on'), true);
  assert.match(elements.sfSheet.innerHTML, /주의 안전 알림.*주의 안내.*확인했습니다/);
  await context.sfAck();
  assert.equal(elements.sfModal.classList.contains('on'), false);
  const notice = a('A4', 1, '전달 말씀', '2026-09-25T04:00:00Z');
  notice.level = 'notice';
  context.SF_LV.notice = ['전달말씀', 'teal'];
  context.SF.alerts = [notice];
  context.sfHandleAlerts();
  assert.equal(elements.sfModal.classList.contains('on'), true);
  assert.match(elements.sfSheet.innerHTML, /전달말씀 안전 알림.*전달 말씀.*확인했습니다/);
  await context.sfAck();
  assert.equal(elements.sfModal.classList.contains('on'), false);
  context.SF.alerts = [];
  context.sfHandleAlerts();
  assert.equal(elements.sfOverlay.classList.contains('on'), false);
  assert.deepEqual(acks, ['A2', 'A2', 'A0', 'A3', 'A4'].map(id => `/api/safety/alerts/${id}/ack`));
  console.log('PASS: one new alert, one confirmation, no old-alert replay');
})().catch(error => { console.error(error); process.exitCode = 1; });
