const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const XLSX = require('xlsx-js-style');
const layout = require('../risk-export-layout.cjs');
const { mountKnowledge } = require('../safety-knowledge.cjs');

// Risk workflow (2026-11-07 user decisions, AGENTS.md 1-1; 2nd decision replaced the period bundles):
// - The collector (서무팀장; a branch's 담당자) receives app reports and assigns them to process writers. Writers see and
//   edit only their own items; reviewers see the items on their 결재선.
// - Each 위험성평가표 and each 이행결과서 goes up one by one. Head office: writer → own 과장 → 서무팀장 confirms →
//   우편물류과장 (the collector's 결재자) → 총괄국장; a person appearing twice signs once (the later step). Branch:
//   writer → 국장. Only the person whose turn it is approves or rejects (several at once from the queue). The 이행결과서
//   goes up after the 평가표 is approved. Approved documents are fixed until the collector asks for 보완.
// - 청 보고 is a period export attached to the official 결재 outside the app (no in-app yearly approval).
// - The approval box stamps names only for steps that happened: 담당 · 과장 · 우편물류과장 · 국장 (branch 담당 · 국장).
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const mgr = (name, org, officeCode, riskRole) => ({ kind: 'safety_mgr', name, org, officeCode, riskRole });
const USERS = {
  hq: mgr('서무팀장', '장흥우체국', 'jangheung', { title: '서무팀장', collector: true, writer: true, supervisorId: 'logi' }),
  post: mgr('우편팀장', '장흥우체국', 'jangheung', { title: '우편팀장', writer: true, supervisorId: 'sales', processes: ['접수(창구)'] }),
  comm: mgr('소통팀장', '장흥우체국', 'jangheung', { title: '소통팀장', writer: true, supervisorId: 'logi', processes: ['구분', '발착', '집배'] }),
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
  item('H3', 'jangheung', 'comm', { customProcess: '구분', factor: '컨베이어 손끼임', riskLevel: '하' }),
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
load('/* 개선조치 완료', '/* 위험성평가 결재(');
load('/* 위험성평가 결재(', '/* 청 누적보고');
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
  const steps = id => RISK.items.find(it => it.id === id).approvals || {};
  const sheetRows = async (user, query) => {
    const res = await call(user, 'GET', '/api/risk/export.xlsx' + query);
    assert.equal(res.status, 200);
    const book = XLSX.read(res.body, { type: 'buffer' });
    return book.SheetNames.map(name => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 }));
  };
  const act = (user, id, doc, action, reason) => call(user, 'POST', `/api/risk/items/${id}/approval/${doc}/${action}`, reason === undefined ? {} : { reason });
  const decide = (user, action, items, reason) => call(user, 'POST', '/api/risk/approvals/decide', { action, items, reason });
  const chainOf = (id, doc = 'assessment') => Array.from(steps(id)[doc].chain || [], s => `${s.id}:${s.roles.join('+')}`);
  try {
    assert.equal(isSafetyMgr(USERS.carrier), false);
    // Visibility: writers see their own, the collector all of the office; reviewers (과장·국장·총괄국장) see nothing until
    // an item is sent up to them; the head office sees no branch item before approval; app reports reach only the collector.
    assert.deepEqual(await ids('post'), ['H1']);
    assert.deepEqual(await ids('comm'), ['H3']);
    assert.deepEqual(await ids('sales'), []);
    assert.deepEqual(await ids('logi'), []);
    assert.deepEqual(await ids('hq'), ['H1', 'H2', 'H3']);
    assert.deepEqual(await ids('chief'), []);
    assert.deepEqual(await ids('dd'), ['D1', 'D2']);
    assert.deepEqual(await ids('ddHead'), [], 'the 국장 sees nothing before the 담당자 sends it');
    assert.deepEqual((await state('hq')).inbox.map(it => it.id), ['I1']);
    assert.deepEqual((await state('post')).inbox, []);
    const hqState = await state('hq');
    assert.equal(hqState.office.role, 'collector'); assert.equal(hqState.me.title, '서무팀장');
    assert.equal(hqState.bundles, undefined, 'no period bundles any more');
    assert.ok(hqState.accounts.some(a => a.id === 'ddHead'));

    // 배분: only the collector, only to a writer of the same office.
    assert.equal((await call('post', 'POST', '/api/risk/items/I1/assign', { writerId: 'post' })).status, 404);
    assert.equal((await call('hq', 'POST', '/api/risk/items/I1/assign', { writerId: 'sales' })).status, 400);
    assert.equal((await call('hq', 'POST', '/api/risk/items/I1/assign', { writerId: 'dd' })).status, 400);
    assert.equal((await call('hq', 'POST', '/api/risk/items/I1/assign', { writerId: 'post' })).status, 200);
    assert.equal(RISK.items.find(it => it.id === 'I1').status, 'assessing');
    assert.deepEqual(await ids('post'), ['H1', 'I1']);

    // Edits: only the assigned writer.
    assert.equal((await patch('hq', 'H1', { owner: 'x' })).status, 403);
    assert.equal((await patch('sales', 'H1', { owner: 'x' })).status, 404, 'not visible before it is sent up');
    assert.equal((await patch('logi', 'H1', { owner: 'x' })).status, 404);
    assert.equal((await patch('post', 'H1', { owner: '영업과장' })).status, 200);

    // 결재선: 우편팀장 → 영업과장 → 서무팀장 확인 → 우편물류과장 → 총괄국장, one step at a time.
    assert.equal((await act('sales', 'H1', 'assessment', 'request')).status, 404, 'a reviewer cannot even see it before it is sent');
    assert.equal((await act('post', 'I1', 'assessment', 'request')).status, 400, 'a risk level first');
    assert.equal((await act('post', 'H1', 'assessment', 'request')).status, 200);
    assert.deepEqual(chainOf('H1'), ['sales:supervisor', 'hq:collector', 'logi:logistics', 'chief:chief']);
    assert.equal((await patch('post', 'H1', { owner: 'x' })).status, 409, 'fixed while pending');
    assert.equal((await act('post', 'H1', 'assessment', 'request')).status, 409);
    assert.ok((await ids('logi')).includes('H1'), 'the 우편물류과장 sees what is on their 결재선');
    assert.deepEqual(await ids('sales'), ['H1']); assert.deepEqual(await ids('chief'), ['H1']);
    assert.equal((await state('sales')).registered.every(it => it.readOnly), true, 'a 과장 only views');
    assert.equal((await patch('sales', 'H1', { owner: 'x' })).status, 403);
    assert.equal((await act('logi', 'H1', 'assessment', 'approve')).status, 403, 'not their turn yet');
    assert.equal((await act('post', 'H1', 'assessment', 'approve')).status, 403);
    for (const who of ['sales', 'hq', 'logi']) assert.equal((await act(who, 'H1', 'assessment', 'approve')).status, 200, who);
    assert.equal(steps('H1').assessment.status, 'pending'); assert.equal(steps('H1').assessment.step, 3);
    assert.equal((await act('chief', 'H1', 'assessment', 'approve')).status, 200);
    assert.equal(steps('H1').assessment.status, 'approved'); assert.equal(steps('H1').assessment.approvedBy, '총괄국장');
    assert.equal((await patch('post', 'H1', { owner: 'x' })).status, 409, 'fixed after approval');

    // A person on the line twice signs once: 서무팀장 → 우편물류과장 → 국장; 소통팀장 → 서무팀장 → 우편물류과장(과장 겸) → 국장.
    await act('hq', 'H2', 'assessment', 'request'); await act('comm', 'H3', 'assessment', 'request');
    assert.deepEqual(chainOf('H2'), ['logi:supervisor+logistics', 'chief:chief']);
    assert.deepEqual(chainOf('H3'), ['hq:collector', 'logi:supervisor+logistics', 'chief:chief']);
    // 선택 결재: several at once; an item that is not the user's turn is reported, the rest go through.
    let batch = (await decide('logi', 'approve', [{ id: 'H2', doc: 'assessment' }, { id: 'H3', doc: 'assessment' }])).body;
    assert.equal(batch.done, 1); assert.match(batch.results.find(r => r.id === 'H3').error, /서무팀장/);
    assert.equal((await decide('hq', 'approve', [{ id: 'H3', doc: 'assessment' }])).body.done, 1);
    assert.equal((await decide('logi', 'approve', [{ id: 'H3', doc: 'assessment' }])).body.done, 1);
    batch = (await decide('chief', 'approve', [{ id: 'H2', doc: 'assessment' }, { id: 'H3', doc: 'assessment' }])).body;
    assert.equal(batch.done, 2);
    assert.deepEqual([steps('H2').assessment.status, steps('H3').assessment.status], ['approved', 'approved']);

    // Reject (reason required) goes back to the writer; sending again starts the line again; withdraw.
    assert.equal((await patch('post', 'I1', { riskLevel: '하', reduction: '1. 매트 교체' })).status, 200);
    await act('post', 'I1', 'assessment', 'request');
    assert.equal((await act('sales', 'I1', 'assessment', 'reject', '')).status, 400);
    assert.equal((await decide('sales', 'reject', [{ id: 'I1', doc: 'assessment' }], '대책 보완')).body.done, 1);
    assert.equal(steps('I1').assessment.status, 'rejected'); assert.equal(steps('I1').assessment.rejectReason, '대책 보완');
    assert.equal((await patch('post', 'I1', { reduction: '1. 매트 교체 2. 미끄럼 방지' })).status, 200);
    await act('post', 'I1', 'assessment', 'request');
    assert.equal(steps('I1').assessment.step, 0); assert.ok(steps('I1').assessment.chain.every(s => s.status === 'waiting'));
    assert.equal((await act('sales', 'I1', 'assessment', 'withdraw')).status, 403);
    assert.equal((await act('post', 'I1', 'assessment', 'withdraw')).status, 200);
    assert.equal(steps('I1').assessment.status, null);

    // 이행결과서: written after the 평가표, sent after its approval, same line.
    assert.equal((await act('post', 'H1', 'result', 'request')).status, 400, 'write it first');
    assert.equal((await call('post', 'POST', '/api/risk/items/I1/improve', { afterRiskLevel: '하', completedDate: '2026-08-21', resultNote: '매트 교체 확인' })).status, 200);
    assert.equal((await act('post', 'I1', 'result', 'request')).status, 400, 'its 평가표 is not approved');
    const improve = await call('post', 'POST', '/api/risk/items/H1/improve', { afterRiskLevel: '하', completedDate: '2026-08-21', resultNote: '바퀴 고정 확인', resultPerson: '우편팀장' });
    assert.equal(improve.status, 200, JSON.stringify(improve.body));
    assert.equal(RISK.items.find(it => it.id === 'H1').resultPerson, '우편팀장');
    assert.equal((await act('post', 'H1', 'result', 'request')).status, 200);
    for (const who of ['sales', 'hq', 'logi', 'chief']) assert.equal((await decide(who, 'approve', [{ id: 'H1', doc: 'result' }])).body.done, 1, who);
    assert.equal(steps('H1').result.status, 'approved');

    // Export: names of the steps that happened; 과장 and 우편물류과장 cells both carry the 우편물류과장 for 소통팀장's item.
    const sheets = await sheetRows('hq', '?from=2026-07-01&to=2026-12-31&office=jangheung');
    const sheetOf = process => sheets.find(rows => String(rows[2]?.[0] || '').includes(`□ 공정명: ${process}`));
    const s1 = sheetOf('접수(창구)'), s3 = sheetOf('구분');
    assert.ok(s1 && s3);
    assert.deepEqual(s1[0].slice(5, 9), ['담당', '과장', '우편물류과장', '국장']);
    assert.deepEqual(s1[1].slice(5, 9).map(v => v ?? ''), ['우편팀장', '영업과장', '우편물류과장', '총괄국장']);
    assert.deepEqual(s3[1].slice(5, 9).map(v => v ?? ''), ['소통팀장', '우편물류과장', '우편물류과장', '총괄국장']);
    assert.match(s1[2][0], /□ 평가일: 2026-07-01 ~ 2026-12-31.*□ 평가자: 관리감독자\(영업과장\), 우편팀장, 담당 직원/);

    // Branch: the writer sends to the 국장; once approved the head office sees it, read-only.
    assert.equal((await act('dd', 'D2', 'assessment', 'request')).status, 400, 'no risk level');
    await act('dd', 'D1', 'assessment', 'request');
    assert.deepEqual(chainOf('D1'), ['ddHead:chief']);
    assert.deepEqual(await ids('ddHead'), ['D1'], 'the 국장 sees it once sent, D2 stays hidden');
    assert.ok(!(await ids('hq')).includes('D1'), 'pending branch items stay hidden');
    assert.equal((await act('ddHead', 'D1', 'assessment', 'approve')).status, 200);
    assert.ok((await ids('hq')).includes('D1'));
    assert.equal((await state('hq')).registered.find(it => it.id === 'D1').readOnly, true);
    assert.ok(!(await ids('post')).includes('D1'));
    const [branchSheet] = await sheetRows('hq', '?from=2026-07-01&to=2026-12-31&office=daedeok');
    assert.match(branchSheet[0][0], /^장흥대덕우체국 위험성평가표/);
    assert.deepEqual([branchSheet[0][7], branchSheet[0][8], branchSheet[1][7], branchSheet[1][8]], ['담당', '국장', '대덕 담당자', '대덕 국장']);
    assert.equal((await call('hq', 'POST', '/api/risk/bundles', { kind: 'annual' })).status, 404, 'no in-app yearly approval');

    // 보완 요청: only the collector; it reopens approved documents so the writer can correct and send again.
    assert.equal((await call('post', 'POST', '/api/risk/items/H1/reopen', { reason: 'x' })).status, 403);
    assert.equal((await call('hq', 'POST', '/api/risk/items/H1/reopen', { reason: '' })).status, 400);
    assert.equal((await call('hq', 'POST', '/api/risk/items/H1/reopen', { reason: '개선예정일 기재' })).status, 200);
    assert.deepEqual([steps('H1').assessment.status, steps('H1').result.status], ['reopened', 'reopened']);
    const reopenedSheet = (await sheetRows('hq', '?from=2026-07-01&to=2026-12-31&office=jangheung')).find(rows => String(rows[2]?.[0] || '').includes('□ 공정명: 접수(창구)'));
    assert.deepEqual(reopenedSheet[1].slice(5, 9).map(v => v ?? ''), ['', '', '', ''], 'no names while reopened');
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
    console.log('PASS: roles and visibility, 배분, writer-only edits, per-document 결재선 (과장 → 서무팀장 → 우편물류과장 → 총괄국장, no double signing), turn checks, 선택 결재, reject/resend/withdraw, 이행결과서 after the 평가표, stamped 4-cell box, branch 국장 approval, 보완 요청, settings, library limits');
  } finally { await new Promise(r => server.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
