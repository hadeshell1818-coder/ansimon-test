const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const XLSX = require('xlsx-js-style');
const layout = require('../risk-export-layout.cjs');
const { mountKnowledge } = require('../safety-knowledge.cjs');

// Office split (AGENTS.md 1-1): the head office (장흥) and branch offices share one site. A branch sees only its own
// items; its half-year report goes to its own head; once approved the head office sees it per office. Items in a
// pending or approved report are fixed until the head office asks for revision. Printed and exported forms carry an
// approval box (담당 · 국장) at the top right.
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const USERS = {
  hq: { id: 'hq', kind: 'safety_mgr', name: '안전보건담당자', org: '장흥우체국', officeCode: 'jangheung', officeRole: 'manager' },
  dd: { id: 'dd', kind: 'safety_mgr', name: '대덕 담당자', org: '장흥대덕우체국', officeCode: 'daedeok', officeRole: 'manager' },
  ddHead: { id: 'ddHead', kind: 'safety_mgr', name: '대덕 국장', org: '장흥대덕우체국', officeCode: 'daedeok', officeRole: 'head' },
  ys: { id: 'ys', kind: 'safety_mgr', name: '용산 담당자', org: '장흥용산우체국', officeCode: 'yongsan', officeRole: 'manager' },
  carrier: { id: 'carrier', kind: 'carrier', name: '집배원', org: '장흥우체국' },
};
const day = '2026-08-10';
const RISK = { items: [
  { id: 'H1', status: 'assessed', officeCode: 'jangheung', createdAt: day, assessmentStartedAt: day, customProcess: '소포', factor: '총괄국 소포 끼임', riskLevel: '상', evaluator: '안전보건담당자' },
  { id: 'D1', status: 'assessed', officeCode: 'daedeok', createdAt: day, assessmentStartedAt: day, customProcess: '집배', factor: '대덕 계단 넘어짐', riskLevel: '중', evaluator: '대덕 담당자' },
  { id: 'D2', status: 'assessing', officeCode: 'daedeok', createdAt: day, assessmentStartedAt: day, customProcess: '집배', factor: '대덕 이륜차 전도', evaluator: '대덕 담당자' },
  { id: 'Y1', status: 'assessed', officeCode: 'yongsan', createdAt: day, assessmentStartedAt: day, customProcess: '창구', factor: '용산 창구 미끄러짐', riskLevel: '하' },
] };
const app = express(); app.use(express.json());
const context = vm.createContext({
  app, RISK, Date, SAFETY_OFFICE: '장흥우체국', PROCESSES: [], HAZARD_TYPES: {}, procById: () => null,
  userFromReq: req => USERS[req.headers['x-user']] || null, itemForMgr: it => ({ ...it }), ensureRiskDemo() {},
  saveRisk() {}, save() {}, broadcastRisk() {}, syncRiskSource() {},
  XLSXStyle: XLSX, RISK_EXPORT_WIDTHS: layout.WIDTHS, riskExportRows: layout.exportRows, configureRiskExport: layout.configureExport,
});
const load = (start, end) => { const i = source.indexOf(start), j = source.indexOf(end, i); assert.ok(i >= 0 && j > i, start); vm.runInContext(source.slice(i, j), context); };
load('const isSafetyMgr =', '/* 공정:');
load('const RISK_CRITERIA =', 'let RISK =');
load("app.use(['/api/risk/state'", '/* 현장 사진신고 접수');
load("app.post('/api/risk/items/:id/triage'", '/* 안전보건담당자가 현장에서');
load("app.patch('/api/risk/items/:id'", '/* 개선조치 완료');
load('/* 관내국 상·하반기 보고', '/* 청 누적보고');
const isSafetyMgr = vm.runInContext('isSafetyMgr', context), isHeadOfficeManager = vm.runInContext('isHeadOfficeManager', context);
// Library: branch accounts get knowledgeAdmin false, as server.js passes it.
mountKnowledge(app, req => { const u = USERS[req.headers['x-user']]; return isSafetyMgr(u) ? { ...u, knowledgeAdmin: isHeadOfficeManager(u) } : null; }, { SAFETY_KEEPALIVE: 'off' });

async function main() {
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-user': user, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const ids = async user => (await call(user, 'GET', '/api/risk/state')).body.registered.map(it => it.id).sort();
  try {
    assert.equal(isSafetyMgr(USERS.carrier), false);
    // Each office sees only its own items; the head office sees no branch item before approval.
    assert.deepEqual(await ids('hq'), ['H1']);
    assert.deepEqual(await ids('dd'), ['D1', 'D2']);
    assert.deepEqual(await ids('ddHead'), ['D1', 'D2']);
    assert.deepEqual(await ids('ys'), ['Y1']);
    const state = (await call('dd', 'GET', '/api/risk/state')).body;
    assert.equal(state.office.code, 'daedeok'); assert.equal(state.office.head, false);
    assert.equal(state.offices.length, 10); assert.ok(state.offices.some(o => o.name === '장흥대덕우체국'));
    assert.equal((await call('ddHead', 'GET', '/api/risk/state')).body.registered.every(it => it.readOnly), true, 'a head only views');

    // Edits: other offices are refused, heads cannot edit, own office can.
    assert.equal((await call('hq', 'PATCH', '/api/risk/items/D1', { owner: '총괄' })).status, 404);
    assert.equal((await call('ys', 'PATCH', '/api/risk/items/D1', { owner: '용산' })).status, 404);
    assert.equal((await call('ddHead', 'PATCH', '/api/risk/items/D1', { owner: '국장' })).status, 403);
    assert.equal((await call('dd', 'PATCH', '/api/risk/items/D1', { owner: '대덕 담당' })).status, 200);

    // Half-year report: only the branch manager requests; the head office and the head cannot.
    assert.equal((await call('hq', 'POST', '/api/risk/office-reports', { half: '2026-H2' })).status, 400);
    assert.equal((await call('ddHead', 'POST', '/api/risk/office-reports', { half: '2026-H2' })).status, 403);
    assert.equal((await call('dd', 'POST', '/api/risk/office-reports', { half: '2026-H1' })).status, 400, 'no items in the first half');
    let report = (await call('dd', 'POST', '/api/risk/office-reports', { half: '2026-H2' })).body.report;
    assert.equal(report.status, 'pending'); assert.deepEqual([...report.itemIds].sort(), ['D1', 'D2']); assert.equal(report.preparedBy, '대덕 담당자');
    assert.equal((await call('dd', 'PATCH', '/api/risk/items/D1', { owner: 'x' })).status, 409, 'fixed while awaiting approval');
    assert.equal((await call('dd', 'POST', '/api/risk/office-reports', { half: '2026-H2' })).status, 409);
    assert.deepEqual(await ids('hq'), ['H1'], 'pending is not visible to the head office');
    assert.equal((await call('ys', 'POST', `/api/risk/office-reports/${report.id}/approve`)).status, 404, 'another branch cannot see it');
    assert.equal((await call('dd', 'POST', `/api/risk/office-reports/${report.id}/approve`)).status, 403, 'the preparer cannot approve');

    // Withdraw, request again, reject (reason required), request again, approve.
    assert.equal((await call('dd', 'POST', `/api/risk/office-reports/${report.id}/withdraw`)).body.report.status, 'draft');
    assert.equal((await call('dd', 'PATCH', '/api/risk/items/D1', { owner: '대덕 담당' })).status, 200);
    await call('dd', 'POST', '/api/risk/office-reports', { half: '2026-H2' });
    assert.equal((await call('ddHead', 'POST', `/api/risk/office-reports/${report.id}/reject`, { reason: '' })).status, 400);
    report = (await call('ddHead', 'POST', `/api/risk/office-reports/${report.id}/reject`, { reason: '대책 보완' })).body.report;
    assert.equal(report.status, 'rejected'); assert.equal(report.rejectReason, '대책 보완');
    await call('dd', 'POST', '/api/risk/office-reports', { half: '2026-H2' });
    report = (await call('ddHead', 'POST', `/api/risk/office-reports/${report.id}/approve`)).body.report;
    assert.equal(report.status, 'approved'); assert.equal(report.approvedBy, '대덕 국장');
    assert.deepEqual(report.history.map(h => h.action), ['request', 'withdraw', 'request', 'reject', 'request', 'approve']);

    // Approved: the head office sees the branch items (read-only) and the report; other branches still do not.
    assert.deepEqual(await ids('hq'), ['D1', 'D2', 'H1']);
    const hqState = (await call('hq', 'GET', '/api/risk/state')).body;
    assert.equal(hqState.registered.find(it => it.id === 'D1').readOnly, true);
    assert.equal(hqState.registered.find(it => it.id === 'H1').readOnly, false);
    assert.deepEqual(hqState.reports.map(r => [r.officeName, r.halfLabel, r.status]), [['장흥대덕우체국', '2026년 하반기', 'approved']]);
    assert.deepEqual(await ids('ys'), ['Y1']);
    assert.equal((await call('hq', 'PATCH', '/api/risk/items/D1', { owner: '총괄' })).status, 403);
    assert.equal((await call('dd', 'PATCH', '/api/risk/items/D1', { owner: 'x' })).status, 409, 'fixed after approval');

    // Export: branch approval box carries the preparer and the head; the head office box leaves 국장 blank.
    const sheetRows = async (user, query) => {
      const res = await call(user, 'GET', '/api/risk/export.xlsx' + query);
      assert.equal(res.status, 200);
      const book = XLSX.read(res.body, { type: 'buffer' });
      return book.SheetNames.map(name => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 }));
    };
    const [branchSheet] = await sheetRows('hq', '?from=2026-07-01&to=2026-12-31&office=daedeok');
    assert.match(branchSheet[0][0], /^장흥대덕우체국 위험성평가표/);
    assert.deepEqual([branchSheet[0][7], branchSheet[0][8], branchSheet[1][7], branchSheet[1][8]], ['담당', '국장', '대덕 담당자', '대덕 국장']);
    const [hqSheet] = await sheetRows('hq', '?from=2026-07-01&to=2026-12-31');
    assert.deepEqual([hqSheet[1][7], hqSheet[1][8] ?? ''], ['안전보건담당자', '']);
    assert.equal((await sheetRows('hq', '?from=2026-07-01&to=2026-12-31&office=all')).length, 2, 'all offices: head office and approved branch sheets');
    assert.equal((await sheetRows('hq', '?from=2026-07-01&to=2026-12-31&office=yongsan'))[0].length <= 4, true, 'unapproved branch exports nothing');

    // Revision: only the head office asks (reason required); the branch edits and requests approval again.
    assert.equal((await call('dd', 'POST', `/api/risk/office-reports/${report.id}/revision`, { reason: 'x' })).status, 403);
    assert.equal((await call('hq', 'POST', `/api/risk/office-reports/${report.id}/revision`, { reason: '' })).status, 400);
    report = (await call('hq', 'POST', `/api/risk/office-reports/${report.id}/revision`, { reason: '개선예정일 기재' })).body.report;
    assert.equal(report.status, 'revision');
    assert.deepEqual(await ids('hq'), ['D1', 'D2', 'H1'], 'still visible to the head office during revision');
    assert.equal((await call('dd', 'PATCH', '/api/risk/items/D1', { dueDate: '12.31' })).status, 200);
    await call('dd', 'POST', '/api/risk/office-reports', { half: '2026-H2' });
    report = (await call('ddHead', 'POST', `/api/risk/office-reports/${report.id}/approve`)).body.report;
    assert.equal(report.status, 'approved');

    // Library: branch accounts read and draft, but cannot back up or change the library.
    assert.equal((await call('dd', 'GET', '/api/safety-knowledge/backup')).status, 403);
    assert.equal((await call('ddHead', 'POST', '/api/safety-knowledge/index-embeddings')).status, 403);
    assert.notEqual((await call('dd', 'GET', '/api/safety-knowledge')).status, 403);
    assert.notEqual((await call('hq', 'GET', '/api/safety-knowledge/backup')).status, 403);
    console.log('PASS: office scope, head view-only, half-year request/withdraw/reject/approve, head office sees approved branches read-only, revision, approval box in export, library limits');
  } finally { await new Promise(r => server.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
