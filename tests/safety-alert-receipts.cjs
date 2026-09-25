const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('public/safety.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);

const elements = Object.fromEntries(['pushStatus', 'alertSentList'].map(id => [id, {
  textContent: '', innerHTML: '', classList: { toggle() {} },
}]));
let dialog = '';
const context = vm.createContext({
  $: id => elements[id],
  S: {
    push: { enabled: true, subscribed: 1 },
    roster: [{ id: 'jip1', name: '김집배', zone: 'z1' }, { id: 'jip2', name: '이집배', zone: 'z1' }],
    zones: [{ id: 'z1', name: '장흥읍' }],
    levels: { urgent: '긴급', caution: '주의' },
    alerts: [
      { id: 'A1', level: 'urgent', text: '긴급 점검', createdAt: '2026-09-25T00:00:00Z', targets: ['jip1', 'jip2'], acks: { jip1: '2026-09-25T00:01:00Z' } },
      { id: 'A2', level: 'caution', text: '주의 안내', createdAt: '2026-09-25T00:00:00Z', targets: ['jip1', 'jip2'], acks: {} },
    ],
  },
  H: null,
  esc: value => String(value),
  hm: () => '09:00',
  modal: value => { dialog = value; },
  toast() {},
});
vm.runInContext(script.slice(script.indexOf('function renderAlertSent()'), script.indexOf('function voiceDetail(')), context);
context.renderAlertSent();
assert.match(elements.alertSentList.innerHTML, /확인 1\/2명/);
assert.match(elements.alertSentList.innerHTML, /미확인자 1명/);
assert.match(elements.alertSentList.innerHTML, /주의.*확인 0\/2명.*미확인자 2명/);
context.showAlertMissing('A1');
assert.match(dialog, /이집배/);
assert.doesNotMatch(dialog, /김집배/);
console.log('PASS: sent alert receipt count and missing recipient list');
