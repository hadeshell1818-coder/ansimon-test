const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const XLSX = require('xlsx-js-style');
const layout = require('../risk-export-layout.cjs');
const { mountKnowledge } = require('../safety-knowledge.cjs');

// Risk workflow (2026-11-07 user decisions, AGENTS.md 1-1):
// - The collector (서무팀장; a branch's 담당자) receives app reports and assigns them to process writers. Writers see and
//   edit only their own items; their 결재자 (과장; a branch's 국장) sees the items of the writers they approve.
// - Routine approval: a writer bundles unapproved 평가표 and 이행결과서 together and sends them once; the approver approves
//   or rejects once. Approved steps are fixed until the collector asks for 보완.
// - Yearly 정기평가: each writer submits the period; the head-office collector sends the whole office plus approved branch
//   items to the 총괄국장 in one document, approved once.
// - The approval box stamps names only for steps that happened: 담당 (sender) · 과장 (approver) · 국장 (yearly approver);
//   a branch box is 담당 · 국장. The info line carries □ 공정명 □ 평가일 □ 평가자.
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const mgr = (name, org, officeCode, riskRole) => ({ kind: 'safety_mgr', name, org, officeCode, riskRole });
const USERS = {
  hq: mgr('서무팀장', '장흥우체국', 'jangheung', { title: '서무팀장', collector: true, writer: true, supervisorId: 'logi' }),
  post: mgr('우편팀장', '장흥우체국', 'jangheung', { title: '우편팀장', writer: true, supervisorId: 'sales', processes: ['접수(창구)'] }),
  sales: mgr('영업과장', '장흥우체국', 'jangheung', { title: '영업과장', approver: true }),
  logi: mgr('우편물류과장', '장흥우체국', 'jangheung', { title: '우편물류과장', approver: true }),
  chief: mgr('총괄국장', '장흥우체국', 'jangheung', { title: '총괄국장', chief: true }),
  dd: mgr('대덕 담당자', '장흥대덕우체국', 'daedeok', { title: '대덕 담당', collector: true, writer: true, supervisorId: 'ddHead' }),
  ddHead: mgr('대덕 국장', '장흥대덕우체국', 'daedeok', { title: '국장', approver: true }),
  carrier: { kind: 'carrier', name: '집배원', org: '장흥우체국' },
};
const day = '2026-08-10';
const item = (id, officeCode, assignedTo, extra) => ({ id, officeCode, assignedTo, assignedName: assignedTo && USERS[assignedTo].name, status: 'assessed', createdAt: day, assessmentStartedAt: day, ...extra });
const RISK = { items: [
  { id: 'I1', status: 'inbox', officeCode: 'jangheung', createdAt: day, factor: '창구 앞 매트 들림', source: 'staff' },
  item('H1', 'jangheung', 'post', { customProcess: '접수(창구)', factor: '창구 의자 바퀴 미끄러짐', riskLevel: '중' }),
  item('H2', 'jangheung', 'hq', { customProcess: '시설 등', factor: '계단 미끄럼 방지 탈락', riskLevel: '상' }),
  item('D1', 'daedeok', 'dd', { customProcess: '집배', factor: '대덕 계단 넘어짐', riskLevel: '중' }),
  item('D2', 'daedeok', 'dd', { status: 'assessing', customProcess: '집배', factor: '대덕 이륜차 전도' }),
] };
const app = express(); app.use(express.json());
const context = vm.createContext({
  app, RISK, Date, SAFETY_OFFICE: '장흥우체국', USERS, path: require('node:path'), savePhoto() { throw new Error('no photo in test'); }, PROCESSES: [], HAZARD_TYPES: {}, procById: () => null,
  userFromReq: req => USERS[req.headers['x-user']] ? { id: req.headers['x-user'], ...USERS[req.headers['x-user']] } : null, itemForMgr: it => ({ ...it }), ensureRiskDemo() {},
  saveRisk() {}, save() {}, broadcastRisk() {}, syncRiskSource() {},
  XLSXStyle: XLSX, RISK_EXPORT_WIDTHS: layout.WIDTHS, riskExportRows: layout.exportRows, configureRiskExport: layout.configureExport,
});
const load = (start, end) => { const i = source.indexOf(start), j = source.indexOf(end, i); assert.ok(i >= 0 && j > i, start); vm.runInContext(source.slice(i, j), context); };
load('const isSafetyMgr =', '/* 공정:');
load('const RISK_CRITERIA =', 'let RISK =');
load("app.use(['/api/risk/state'", '/* 현장 사진신고 접수');
load("app.post('/api/risk/items/:id/triage'", '/* 안전보건담당자가 현장에서');
load("app.patch('/api/risk/items/:id'", '/* 개선조치 완료');
load('/* 개선조치 완료', '/* 위험성평가 결재 묶음');
load('/* 위험성평가 결재 묶음', '/* 청 누적보고');
const isSafetyMgr = vm.runInContext('isSafetyMgr', context), isHeadOfficeManager = vm.runInContext('isHeadOfficeManager', context);
mountKnowledge(app, req => { const id = req.headers['x-user'], u = USERS[id] && { id, ...USERS[id] }; return isSafetyMgr(u) ? { ...u, knowledgeAdmin: isHeadOfficeManager(u) } : null; }, { SAFETY_KEEPALIVE: 'off' });

async function main() {
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-user': user, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const state = async user => (await call(user, 'GET', '/api/risk/state')).body;
  const ids = async user => (await state(user)).registered.map(it => it.id).sort();
  const patch = (user, id, body) => call(user, 'PATCH', '/api/risk/items/' + id, body);
  const bundle = (user, body) => call(user, 'POST', '/api/risk/bundles', body);
  const decide = (user, id, action, reason) => call(user, 'POST', `/api/risk/bundles/${id}/${action}`, reason === undefined ? {} : { reason });
  const steps = id => RISK.items.find(it => it.id === id).approvals || {};
  const sheetRows = async (user, query) => {
    const res = await call(user, 'GET', '/api/risk/export.xlsx' + query);
    assert.equal(res.status, 200);
    const book = XLSX.read(res.body, { type: 'buffer' });
    return book.SheetNames.map(name => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 }));
  };
  try {
    assert.equal(isSafetyMgr(USERS.carrier), false);
    // Visibility: writers see their own, approvers the items of the writers they approve, the collector and chief all
    // of the office; the head office sees no branch item before approval; app reports reach only the collector.
    assert.deepEqual(await ids('post'), ['H1']);
    assert.deepEqual(await ids('sales'), ['H1']);
    assert.deepEqual(await ids('logi'), ['H2']);
    assert.deepEqual(await ids('hq'), ['H1', 'H2']);
    assert.deepEqual(await ids('chief'), ['H1', 'H2']);
    assert.deepEqual(await ids('dd'), ['D1', 'D2']);
    assert.deepEqual(await ids('ddHead'), ['D1', 'D2']);
    assert.deepEqual((await state('hq')).inbox.map(it => it.id), ['I1']);
    assert.deepEqual((await state('post')).inbox, []);
    const hqState = await state('hq');
    assert.equal(hqState.office.role, 'collector'); assert.equal(hqState.me.title, '서무팀장');
    assert.ok(hqState.accounts.some(a => a.id === 'ddHead'), 'the head office lists branch accounts for settings and the yearly report');
    assert.equal((await state('dd')).accounts.every(a => a.officeCode === 'daedeok'), true);
    assert.equal((await state('sales')).registered.every(it => it.readOnly), true, 'an approver only views');

    // 배분: only the collector, only to a writer of the same office.
    assert.equal((await call('post', 'POST', '/api/risk/items/I1/assign', { writerId: 'post' })).status, 404, 'a writer does not see unassigned reports');
    assert.equal((await call('hq', 'POST', '/api/risk/items/I1/assign', { writerId: 'sales' })).status, 400);
    assert.equal((await call('hq', 'POST', '/api/risk/items/I1/assign', { writerId: 'dd' })).status, 400);
    assert.equal((await call('hq', 'POST', '/api/risk/items/I1/assign', { writerId: 'post' })).status, 200);
    assert.equal(RISK.items.find(it => it.id === 'I1').status, 'assessing');
    assert.deepEqual(await ids('post'), ['H1', 'I1']);
    assert.equal((await state('hq')).registered.find(it => it.id === 'I1').readOnly, true, 'the collector follows progress but does not edit others’ items');

    // Edits: only the assigned writer.
    assert.equal((await patch('hq', 'H1', { owner: 'x' })).status, 403);
    assert.equal((await patch('sales', 'H1', { owner: 'x' })).status, 403);
    assert.equal((await patch('logi', 'H1', { owner: 'x' })).status, 404);
    assert.equal((await patch('post', 'H1', { owner: '영업과장' })).status, 200);
    assert.equal((await call('sales', 'POST', '/api/risk/items/manual', { customProcess: '접수(창구)', factor: '결재자 작성 시도' })).status, 403);

    // Routine bundle: only own items, a risk level is needed, the approver must be an office approver.
    assert.equal((await bundle('sales', { assessmentIds: ['H1'] })).status, 403);
    assert.equal((await bundle('post', { assessmentIds: ['H1', 'I1'], approverId: 'sales' })).status, 400, 'I1 has no risk level yet');
    assert.equal((await bundle('post', { assessmentIds: ['H2'], approverId: 'sales' })).status, 400, 'not my item');
    assert.equal((await bundle('post', { assessmentIds: ['H1'], approverId: 'chief' })).status, 400, 'the chief is not a routine approver');
    let b1 = (await bundle('post', { assessmentIds: ['H1'] })).body.bundle;
    assert.equal(b1.status, 'pending'); assert.equal(b1.approverName, '영업과장', 'defaults to the writer’s 결재자');
    assert.equal((await patch('post', 'H1', { owner: 'x' })).status, 409, 'fixed while awaiting approval');
    assert.equal((await bundle('post', { assessmentIds: ['H1'] })).status, 400, 'already pending');
    assert.notEqual((await decide('logi', b1.id, 'approve')).status, 200, 'only the chosen approver');
    assert.equal((await decide('post', b1.id, 'approve')).status, 403);
    assert.equal((await decide('post', b1.id, 'withdraw')).body.bundle.status, 'withdrawn');
    assert.equal(steps('H1').assessment.status, null);
    assert.equal((await patch('post', 'H1', { reduction: '1. 의자 바퀴 고정' })).status, 200);
    b1 = (await bundle('post', { assessmentIds: ['H1'], approverId: 'sales' })).body.bundle;
    assert.equal((await decide('sales', b1.id, 'approve')).body.bundle.status, 'approved');
    assert.equal(steps('H1').assessment.status, 'approved'); assert.equal(steps('H1').assessment.approvedBy, '영업과장');
    assert.equal((await patch('post', 'H1', { owner: 'x' })).status, 409, 'fixed after approval');

    // Reject (reason required) and send again; 평가표 and 이행결과서 travel together.
    let b2 = (await bundle('hq', { assessmentIds: ['H2'] })).body.bundle;
    assert.equal(b2.approverName, '우편물류과장');
    assert.equal((await decide('logi', b2.id, 'reject', '')).status, 400);
    assert.equal((await decide('logi', b2.id, 'reject', '대책 보완')).body.bundle.status, 'rejected');
    assert.equal(steps('H2').assessment.status, 'rejected');
    assert.equal((await patch('hq', 'H2', { reduction: '1. 미끄럼 방지 테이프 재부착' })).status, 200, 'a rejected item can be fixed');
    const improveH2 = await call('hq', 'POST', '/api/risk/items/H2/improve', { afterRiskLevel: '하', completedDate: '2026-08-20', resultNote: '테이프 재부착 확인', resultPerson: '서무팀장' });
    assert.equal(improveH2.status, 200, JSON.stringify(improveH2.body));
    assert.equal(RISK.items.find(it => it.id === 'H2').resultPerson, '서무팀장', '이행결과서 담당자(성명)');
    assert.equal((await bundle('hq', { resultIds: ['H2'] })).status, 400, 'a 이행결과서 needs its 평가표 approved or sent with it');
    b2 = (await bundle('hq', { assessmentIds: ['H2'], resultIds: ['H2'] })).body.bundle;
    assert.deepEqual([b2.assessmentIds, b2.resultIds], [['H2'], ['H2']]);
    await decide('logi', b2.id, 'approve');
    assert.deepEqual([steps('H2').assessment.status, steps('H2').result.status], ['approved', 'approved']);

    // The 이행결과서 is written after the 평가표 approval and sent on its own.
    assert.equal((await state('post')).registered.find(it => it.id === 'H1').canImprove, true);
    assert.equal((await call('post', 'POST', '/api/risk/items/H1/improve', { afterRiskLevel: '하', completedDate: '2026-08-21', resultNote: '바퀴 고정 확인' })).status, 200);
    const b3 = (await bundle('post', { resultIds: ['H1'] })).body.bundle;
    await decide('sales', b3.id, 'approve');
    assert.equal(steps('H1').result.status, 'approved');

    // Export (head office): 담당 · 과장 · 국장 with the names of the steps that happened; info line with 평가자 titles.
    const [hqSheet] = await sheetRows('hq', '?from=2026-07-01&to=2026-12-31&office=jangheung');
    const block = hqSheet.findIndex(row => row[0] === '장흥우체국 위험성평가표' && hqSheet[hqSheet.indexOf(row) + 2]?.[0]?.includes('접수(창구)'));
    assert.ok(block >= 0);
    assert.deepEqual(hqSheet[block].slice(6, 9), ['담당', '과장', '국장']);
    assert.deepEqual([hqSheet[block + 1][6], hqSheet[block + 1][7], hqSheet[block + 1][8] ?? ''], ['우편팀장', '영업과장', ''], '국장 stays blank until the yearly approval');
    assert.match(hqSheet[block + 2][0], /□ 공정명: 접수\(창구\).*□ 평가일: 2026-07-01 ~ 2026-12-31.*□ 평가자: 관리감독자\(영업과장\), 우편팀장, 담당 직원/);

    // Branch: the branch writer sends to the branch head; once approved the head office sees the item, read-only.
    assert.equal((await bundle('dd', { assessmentIds: ['D2'] })).status, 400, 'no risk level');
    const b4 = (await bundle('dd', { assessmentIds: ['D1'] })).body.bundle;
    assert.equal(b4.approverName, '대덕 국장');
    assert.deepEqual(await ids('hq'), ['H1', 'H2', 'I1'], 'pending branch items stay hidden');
    await decide('ddHead', b4.id, 'approve');
    assert.deepEqual(await ids('hq'), ['D1', 'H1', 'H2', 'I1']);
    assert.equal((await state('hq')).registered.find(it => it.id === 'D1').readOnly, true);
    assert.deepEqual(await ids('post'), ['H1', 'I1'], 'a head-office writer never sees branch items');
    const [branchSheet] = await sheetRows('hq', '?from=2026-07-01&to=2026-12-31&office=daedeok');
    assert.match(branchSheet[0][0], /^장흥대덕우체국 위험성평가표/);
    assert.deepEqual([branchSheet[0][7], branchSheet[0][8], branchSheet[1][7], branchSheet[1][8]], ['담당', '국장', '대덕 담당자', '대덕 국장']);

    // 정기평가: every writer item in the period must be approved before submitting; then the collector sends one
    // document for the office plus approved branch items, approved once by the 총괄국장.
    assert.equal((await call('post', 'POST', '/api/risk/annual-submissions', { from: '2026-01-01', to: '2026-12-31' })).status, 400, 'I1 is not approved');
    assert.equal((await patch('post', 'I1', { riskLevel: '하', reduction: '1. 매트 교체' })).status, 200);
    const b5 = (await bundle('post', { assessmentIds: ['I1'] })).body.bundle; await decide('sales', b5.id, 'approve');
    assert.equal((await call('post', 'POST', '/api/risk/annual-submissions', { from: '2026-01-01', to: '2026-12-31' })).status, 200);
    assert.equal((await state('hq')).submissions.length, 1);
    RISK.items.push(item('H9', 'jangheung', 'hq', { customProcess: '시설 등', factor: '결재 전 항목', riskLevel: '하' }));
    assert.equal((await bundle('hq', { kind: 'annual', from: '2026-01-01', to: '2026-12-31' })).status, 400, 'every 평가표 is approved first');
    RISK.items.pop();
    assert.equal((await bundle('post', { kind: 'annual', from: '2026-01-01', to: '2026-12-31' })).status, 403);
    assert.equal((await bundle('dd', { kind: 'annual', from: '2026-01-01', to: '2026-12-31' })).status, 403, 'a branch has no yearly bundle of its own');
    const annual = (await bundle('hq', { kind: 'annual', from: '2026-01-01', to: '2026-12-31' })).body.bundle;
    assert.equal(annual.approverName, '총괄국장');
    assert.deepEqual([...annual.items.map(x => x.id)].sort(), ['D1', 'H1', 'H2', 'I1'], 'the whole office and approved branch items, D2 excluded');
    assert.equal((await bundle('hq', { kind: 'annual', from: '2026-01-01', to: '2026-12-31' })).status, 409);
    assert.equal((await decide('sales', annual.id, 'approve')).status, 404);
    await decide('chief', annual.id, 'approve');
    assert.equal(steps('D1').annual.status, 'approved');
    const [annualSheet] = await sheetRows('hq', '?from=2026-07-01&to=2026-12-31&office=jangheung');
    const top = annualSheet.findIndex(row => row[0] === '장흥우체국 위험성평가표');
    assert.equal(annualSheet[top + 1][8], '총괄국장', 'the 국장 cell is stamped after the yearly approval');

    // 보완 요청: only the collector; it reopens approved steps so the writer can correct and send again.
    assert.equal((await call('post', 'POST', '/api/risk/items/H1/reopen', { reason: 'x' })).status, 403);
    assert.equal((await call('hq', 'POST', '/api/risk/items/H1/reopen', { reason: '' })).status, 400);
    assert.equal((await call('hq', 'POST', '/api/risk/items/H1/reopen', { reason: '개선예정일 기재' })).status, 200);
    assert.deepEqual([steps('H1').assessment.status, steps('H1').result.status, steps('H1').annual.status], ['reopened', 'reopened', 'reopened']);
    assert.equal((await patch('post', 'H1', { dueDate: '12.31' })).status, 200);
    assert.equal((await call('hq', 'POST', '/api/risk/items/D1/reopen', { reason: '사진 보완' })).status, 200, 'the head office asks a branch for 보완');
    assert.equal((await patch('dd', 'D1', { dueDate: '12.31' })).status, 200);

    // Settings: only the head-office collector; changes are recorded; handing over the collector role needs confirmation.
    assert.equal((await call('post', 'GET', '/api/risk/roles')).status, 403);
    assert.equal((await call('dd', 'GET', '/api/risk/roles')).status, 403);
    assert.ok((await call('hq', 'GET', '/api/risk/roles')).body.accounts.some(a => a.id === 'ddHead'));
    assert.equal((await call('hq', 'PUT', '/api/risk/roles/post', { supervisorId: 'chief' })).status, 400, 'a supervisor must be an approver');
    assert.equal((await call('hq', 'PUT', '/api/risk/roles/post', { title: '우편팀장', processes: ['접수(창구)', '우편 창구'] })).status, 200);
    assert.deepEqual([...(await state('post')).me.processes], ['접수(창구)', '우편 창구']);
    assert.equal((await call('hq', 'PUT', '/api/risk/roles/post', { collector: true })).status, 400);
    assert.equal((await call('hq', 'GET', '/api/risk/roles')).body.history.length, 1);

    // Library: branch accounts read and draft, but cannot back up or change the library.
    assert.equal((await call('dd', 'GET', '/api/safety-knowledge/backup')).status, 403);
    assert.equal((await call('ddHead', 'POST', '/api/safety-knowledge/index-embeddings')).status, 403);
    assert.notEqual((await call('dd', 'GET', '/api/safety-knowledge')).status, 403);
    assert.notEqual((await call('hq', 'GET', '/api/safety-knowledge/backup')).status, 403);
    console.log('PASS: roles and visibility, 배분, writer-only edits, bundles (평가표+이행결과서) with withdraw/reject/approve, branch approval, 정기평가 once by the 총괄국장, stamped approval box and 평가자 line, 보완 요청, settings, library limits');
  } finally { await new Promise(r => server.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
