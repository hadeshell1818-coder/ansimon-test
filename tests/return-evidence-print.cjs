const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync('public/safety.html', 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) new vm.Script(match[1]);
}
let output = '', printed = 0, closed = 0, blocked = false, notice = '';
const context = vm.createContext({
  evidenceData: {
    start: '2026-09-01', end: '2026-09-30',
    daily: [{ date: '2026-09-27', target: 2, reported: 1, missing: 1, ok: 0, healthOnly: 0, equipmentOnly: 0, both: 1 }],
    returns: [
      { id: 'c1', name: '<김집배>', date: '2026-09-27', zoneName: '1구', demo: true, report: {
        at: '2026-09-27T08:00:00Z', source: 'self', bodyIssue: true, bodyDetail: '발목 통증', equipmentIssue: true, equipmentDetail: '브레이크 이상',
        actions: { health: { detail: '진료 안내', owner: '담당자', status: 'done', completedDetail: '치료 완료' }, equipment: { detail: '정비 의뢰', status: 'pending' } },
        history: [{ bodyIssue: false, equipmentIssue: false, at: '2026-09-27T07:00:00Z' }],
      } },
      { id: 'c2', name: '미보고 직원', date: '2026-09-27', zoneName: '2구', report: null },
      { id: 'c3', name: '결원 직원', date: '2026-09-27', zoneName: '3구', absence: { reason: '휴가' }, report: null },
    ],
  },
  esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
  evidenceTime: value => value ? String(value) : '-', actionStatusLabel: value => value || '미기록',
  window: { open: () => blocked ? null : { document: { write: text => { output = text; }, close: () => { closed++; } }, print: () => { printed++; } } },
  toast: value => { notice = value; }, setTimeout: callback => callback(),
});
vm.runInContext(html.slice(html.indexOf('function evidenceReturnRow('), html.indexOf('function evidenceReturnTable(')), context);
context.printReturnEvidence();
for (const text of ['2026-09-01', '2026-09-30', '근무일', '미보고 직원', '미보고', '결원 직원', '휴가', '발목 통증', '브레이크 이상', '진료 안내', '정비 의뢰', '정정 전 보고', '가상 운영 기록', '인원·일']) assert.ok(output.includes(text), text);
assert.ok(output.includes('&lt;김집배&gt;'));
assert.ok(!output.includes('<김집배>'));
const staffTable=output.slice(output.indexOf('<h2>직원별'));
assert.equal((staffTable.match(/<th(?:\s|>)/g)||[]).length,10);
assert.ok(staffTable.includes('<td>1구</td><td>이상 보고</td><td>2026-09-27T08:00:00Z</td><td>본인보고</td><td>이상 · 발목 통증</td><td>이상 · 브레이크 이상</td>'));
assert.ok(staffTable.includes('<td>2구</td><td>미보고</td><td>-</td><td>-</td><td>미보고</td><td>미보고</td>'));
assert.ok(staffTable.includes('<td>3구</td><td>결원 · 휴가</td><td>-</td><td>-</td><td>보고 대상 제외</td><td>보고 대상 제외</td>'));
assert.equal(printed, 1); assert.equal(closed, 1);
context.evidenceData.returns = []; context.evidenceData.daily = [];
context.printReturnEvidence();
assert.ok(output.includes('선택 기간에 귀국보고 기록이 없습니다.'));
blocked = true; context.printReturnEvidence();
assert.ok(notice.includes('출력 창이 차단'));
assert.ok(html.includes('onclick="printReturnEvidence()">귀국보고 출력'));
console.log('PASS: inline syntax, return print summaries/details, missing/absence, both actions, history, demo, escaping, empty results and blocked popup');
