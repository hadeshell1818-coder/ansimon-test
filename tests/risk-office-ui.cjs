const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require('playwright');

// Risk screens by role (2026-11-07 decisions): the collector assigns app reports, follows progress before approval in
// the table, asks for 보완 and sets roles; a writer sends the 평가표 with its 이행결과서 in one 결재 from the table's
// 결재 cell (미결재 → 결재중 → 결재완료, no separate 결재 tab); whoever's turn it is approves in that cell or in the
// 「결재할 문서」 box above the table, and only views the table. Printed forms carry □ 공정명 □ 평가일 □ 평가자 and an approval
// box (담당 · 과장 · 우편물류과장 · 국장 at the head office, 담당 · 국장 at a branch) stamped with the names of the steps
// that happened. 청 보고 is a period export; there is no in-app yearly approval.
const offices = [{ code: 'jangheung', name: '장흥우체국', head: true }, { code: 'daedeok', name: '장흥대덕우체국', head: false }];
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const acct = (id, name, officeCode, role) => ({ id, name, officeCode, title: '', collector: false, writer: false, approver: false, chief: false, supervisorId: null, processes: [], ...role });
const accounts = [
  acct('hq', '서무팀장(시험)', 'jangheung', { title: '서무팀장', collector: true, writer: true, supervisorId: 'logi', processes: ['시설 등'] }),
  acct('post', '우편팀장(시험)', 'jangheung', { title: '우편팀장', writer: true, supervisorId: 'sales', processes: ['접수(창구)'] }),
  acct('sales', '영업과장(시험)', 'jangheung', { title: '영업과장', approver: true }),
  acct('logi', '우편물류과장(시험)', 'jangheung', { title: '우편물류과장', approver: true }),
  acct('chief', '총괄국장(시험)', 'jangheung', { title: '총괄국장', chief: true }),
  acct('dd', '대덕 담당자', 'daedeok', { collector: true, writer: true, supervisorId: 'ddHead' }),
  acct('ddHead', '대덕 국장', 'daedeok', { title: '국장', approver: true }),
];
const base = (id, extra) => ({ id, status: 'assessed', officeCode: 'jangheung', officeName: '장흥우체국', createdAt: today, assessmentStartedAt: today, customProcess: '접수(창구)', riskLevel: '중', readOnly: false, canImprove: true, approvals: {}, ...extra });
const H1 = base('H1', { factor: '창구 의자 바퀴 미끄러짐', assignedTo: 'post', assignedName: '우편팀장(시험)' });
const step = (id, name, title, roles, status = 'done') => ({ id, name, title, roles, status, at: status === 'done' ? today + 'T02:00:00Z' : null });
const hqChain = status => [step('sales', '영업과장(시험)', '영업과장', ['supervisor'], status), step('hq', '서무팀장(시험)', '서무팀장', ['collector'], status), step('logi', '우편물류과장(시험)', '우편물류과장', ['logistics'], status), step('chief', '총괄국장(시험)', '총괄국장', ['chief'], status)];
const H3 = base('H3', { factor: '번호표 발행기 전선 걸림', assignedTo: 'post', assignedName: '우편팀장(시험)', doneAt: today + 'T03:00:00Z', resultUpdatedAt: today + 'T03:00:00Z', afterRiskLevel: '하',
  approvals: { assessment: { status: 'approved', requestedBy: '우편팀장(시험)', requestedById: 'post', chain: hqChain('done'), step: 3, approvedBy: '총괄국장(시험)', approvedOnce: true },
    result: { status: 'approved', requestedBy: '우편팀장(시험)', requestedById: 'post', chain: hqChain('done'), step: 3, approvedBy: '총괄국장(시험)', approvedOnce: true } } });
const H4 = base('H4', { factor: '롤파렛트 밑판 미고정', assignedTo: 'post', assignedName: '우편팀장(시험)', doneAt: today + 'T03:00:00Z', resultUpdatedAt: today + 'T03:00:00Z', afterRiskLevel: '하' });
const D1 = base('D1', { officeCode: 'daedeok', officeName: '장흥대덕우체국', customProcess: '집배', factor: '대덕 계단 넘어짐', assignedTo: 'dd', readOnly: true, canImprove: false,
  approvals: { assessment: { status: 'approved', requestedBy: '대덕 담당자', chain: [step('ddHead', '대덕 국장', '국장', ['chief'])], step: 0, approvedBy: '대덕 국장', approvedOnce: true } } });
const pendingDoc = { status: 'pending', requestedBy: '우편팀장(시험)', requestedById: 'post', chain: hqChain('waiting'), step: 0 };
const H1pending = { ...H1, doneAt: today + 'T03:00:00Z', resultUpdatedAt: today + 'T03:00:00Z', readOnly: true, canImprove: false, approvals: { assessment: pendingDoc, result: pendingDoc } };
const me = id => { const a = accounts.find(x => x.id === id); return { id, name: a.name, title: a.title, collector: a.collector, writer: a.writer, approver: a.approver, chief: a.chief, supervisorId: a.supervisorId, processes: a.processes }; };
const views = {
  writer: { user: { kind: 'safety_mgr', org: '장흥우체국', name: '우편팀장(시험)', test: true },
    state: { me: me('post'), office: { code: 'jangheung', name: '장흥우체국', head: true, role: 'writer' }, registered: [H1, H3, H4] } },
  approver: { user: { kind: 'safety_mgr', org: '장흥우체국', name: '영업과장(시험)', test: true },
    state: { me: me('sales'), office: { code: 'jangheung', name: '장흥우체국', head: true, role: 'head' },
      registered: [H1pending] } },
  collector: { user: { kind: 'safety_mgr', org: '장흥우체국', name: '서무팀장(시험)', test: true },
    state: { me: me('hq'), office: { code: 'jangheung', name: '장흥우체국', head: true, role: 'collector' },
      inbox: [{ id: 'I1', status: 'inbox', source: 'staff', reporter: '직원', createdAt: today + 'T00:00:00Z', note: '창구 앞 매트 들림', officeCode: 'jangheung' }],
      registered: [(() => { const doc = { ...pendingDoc, chain: hqChain('waiting').map((s, i) => i === 0 ? { ...s, status: 'done' } : s), step: 1 }; return { ...H1pending, approvals: { assessment: doc, result: doc } }; })(), { ...H3, readOnly: true }, D1] } },
  branch: { user: { kind: 'safety_mgr', org: '장흥대덕우체국', name: '대덕 담당자', test: true },
    state: { me: me('dd'), office: { code: 'daedeok', name: '장흥대덕우체국', head: false, role: 'collector' }, registered: [{ ...D1, readOnly: false, canImprove: true, approvals: {} }] } },
};

async function main() {
  const app = express(); app.use(express.static(path.join(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const url0 = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const open = async role => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul' }), errors = [], sent = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('dialog', dialog => dialog.type() === 'prompt' ? dialog.accept('보완 내용') : dialog.accept());
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url()), method = route.request().method(); let data = {};
        if (url.pathname === '/api/me') data = { user: views[role].user };
        if (url.pathname === '/api/risk/state') data = { inbox: [], processes: [], hazardTypes: {}, criteria: { levels: [] }, offices, accounts: role === 'branch' ? accounts.filter(a => a.officeCode === 'daedeok') : accounts, ...views[role].state };
        if (url.pathname === '/api/risk/roles') data = { accounts: accounts.map(a => ({ ...a, officeName: offices.find(o => o.code === a.officeCode).name })), history: [] };
        if (url.pathname === '/api/safety-knowledge') data = { connected: true, documents: [], candidates: [] };
        if (method === 'POST' || method === 'PUT') { const body = route.request().postDataJSON(); sent.push({ method, path: url.pathname, body }); data = { ok: true, done: (body?.items || []).length, results: [] }; }
        await route.fulfill({ json: data });
      });
      await page.addInitScript(() => sessionStorage.setItem('cv_risk_token', 'test-only'));
      await page.goto(url0 + '/risk.html');
      await page.locator('#app').waitFor({ state: 'visible' });
      return { page, errors, sent };
    };
    const toast = (page, text) => page.waitForFunction(t => document.querySelector('#toast')?.textContent.includes(t), text);

    // Writer: no inbox or settings; sends each document up from the 결재 tab or the form.
    const writer = await open('writer');
    assert.equal(await writer.page.locator('#tab-inbox').isHidden(), true, 'app reports go to the collector');
    assert.equal(await writer.page.locator('#tab-roles').isHidden(), true);
    assert.equal(await writer.page.locator('#tab-table').getAttribute('class').then(c => c.includes('on')), true);
    // The table: header line with 평가일·평가자 (no old 「안전관리 담당자」), 담당자(성명) column with the employee's name.
    const group = writer.page.locator('.process-group').first();
    assert.match(await group.locator('header').innerText(), /□ 평가일: .*□ 평가자: 관리감독자\(영업과장\), 우편팀장, 담당 직원/);
    assert.doesNotMatch(await group.locator('header').innerText(), /안전관리 담당자/);
    assert.match(await group.locator('thead').innerText(), /담당자\s*\(성명\)/);
    await writer.page.getByRole('button', { name: '보기·수정', exact: true }).first().click();
    assert.equal(await writer.page.locator('label', { hasText: /^담당자\(성명\)$/ }).count(), 1);
    assert.equal(await writer.page.locator('#e-evaluator').inputValue(), '우편팀장(시험)', '담당자(성명) is the employee, not whoever opens it');
    assert.equal(await writer.page.locator('label', { hasText: /^감독자\(성명\)$/ }).count(), 1);
    assert.equal(await writer.page.locator('#e-owner').inputValue(), '영업과장(시험)', '감독자 defaults to the writer’s 결재자');
    assert.equal(await writer.page.locator('#modalCard').getByRole('button', { name: /결재 올리기/ }).count(), 0, 'sending is done in the 결재 cell');
    await writer.page.getByRole('button', { name: '닫기', exact: true }).click();
    // No separate 결재 tab: the table carries a 결재 cell (미결재 → 결재중 → 결재완료); one 결재 after the 이행결과서.
    assert.equal(await writer.page.locator('#tab-approval').count(), 0);
    assert.match(await group.locator('thead').innerText(), /결재/);
    const cell = (page, factor) => page.locator('.three-step tr', { hasText: factor }).locator('.approval-cell');
    assert.match(await cell(writer.page, '창구 의자 바퀴 미끄러짐').innerText(), /미결재[\s\S]*이행결과서 작성 후 결재/);
    assert.equal(await cell(writer.page, '창구 의자 바퀴 미끄러짐').getByRole('button').count(), 0);
    assert.match(await cell(writer.page, '번호표 발행기 전선 걸림').innerText(), /결재완료/);
    await cell(writer.page, '롤파렛트 밑판 미고정').getByRole('button', { name: '결재 올리기' }).click();
    await toast(writer.page, '결재를 올렸습니다');
    assert.ok(writer.sent.some(p => p.path === '/api/risk/items/H4/approval/both/request'));
    assert.doesNotMatch(await writer.page.evaluate(() => assessmentPrintTable(R.registered)), /<th>결재<\/th>/, 'printouts leave the 결재 cell out');
    // 이행결과서: 담당자(성명) with the writer's name; its box has four cells.
    await writer.page.locator('#tab-table').click();
    await writer.page.evaluate(() => openImprove('H1'));
    assert.equal(await writer.page.locator('label', { hasText: /^담당자\(성명\)$/ }).count(), 1);
    assert.equal(await writer.page.locator('#i-person').inputValue(), '우편팀장(시험)');
    const resultForm = await writer.page.evaluate(() => resultFormHtml(R.registered.find(it => it.id === 'H3')));
    assert.match(resultForm, /<th>담당자\(성명\)<\/th>/);
    assert.match(resultForm, /approval-box four/);
    assert.equal(await writer.page.evaluate(() => reopenButton(R.registered.find(it => it.id === 'H3'))), '', 'a writer fixes their own document directly');
    // 담당 is the writer once the document exists; a returned document shows its reason at the top.
    assert.match(await writer.page.evaluate(() => approvalBox('jangheung', [R.registered.find(it => it.id === 'H1')])), /<td>우편팀장\(시험\)<\/td><td><\/td><td><\/td><td><\/td>/);
    assert.match(await writer.page.evaluate(() => returnNotice({ approvals: { assessment: { status: 'rejected', rejectedBy: '영업과장(시험)', rejectReason: '대책 보완' } } }, 'assessment')), /반려\(영업과장\(시험\)\): 대책 보완 — 이 창에서 고친 뒤 다시 결재를 올리세요/);
    assert.deepEqual(writer.errors, []);

    // Approver: sees what is their turn above the table and in the 결재 cell, approves both documents at once.
    const approver = await open('approver');
    assert.equal(await approver.page.locator('#tab-table').getAttribute('class').then(c => c.includes('on')), true);
    assert.equal(await approver.page.locator('#approvalN').innerText(), '1');
    assert.match(await approver.page.locator('.approval-banner').innerText(), /결재할 문서 1건[\s\S]*창구 의자 바퀴 미끄러짐/);
    assert.match(await cell(approver.page, '창구 의자 바퀴 미끄러짐').innerText(), /결재중[\s\S]*영업과장 검토 대기/);
    await approver.page.locator('.approval-banner').getByRole('button', { name: '검토', exact: true }).click();
    await toast(approver.page, '결재(검토)했습니다');
    assert.ok(approver.sent.some(p => p.path === '/api/risk/items/H1/approval/both/approve'));
    assert.equal(await approver.page.locator('.three-step select').count(), 0);
    assert.equal(await approver.page.locator('[contenteditable="true"]').count(), 0);
    assert.equal(await approver.page.getByRole('button', { name: '위험성평가 추가' }).count(), 0);
    assert.deepEqual(approver.errors, []);

    // Collector: assigns an app report, sees progress (whose turn) before approval, asks for 보완, sets roles.
    const collector = await open('collector');
    assert.match(await collector.page.locator('#inboxList').innerText(), /창구 앞 매트 들림/);
    await collector.page.locator('#assign-I1').selectOption('post');
    await collector.page.getByRole('button', { name: '배분', exact: true }).click();
    await toast(collector.page, '배분했습니다');
    assert.deepEqual(collector.sent.find(p => p.path === '/api/risk/items/I1/assign').body, { writerId: 'post' });
    await collector.page.locator('#tab-table').click();
    assert.match(await collector.page.locator('.approval-banner').innerText(), /창구 의자 바퀴 미끄러짐[\s\S]*확인/, 'the 서무팀장 confirms in turn');
    assert.match(await cell(collector.page, '창구 의자 바퀴 미끄러짐').innerText(), /결재중[\s\S]*서무팀장 확인 대기/, 'progress shows in the table');
    assert.match(await cell(collector.page, '번호표 발행기 전선 걸림').innerText(), /결재완료/);
    assert.equal(await collector.page.locator('.three-step').getByRole('button', { name: /보완 요청/ }).count(), 0, 'no 보완 요청 marks in the list');
    assert.equal(await collector.page.evaluate(() => reopenButton(R.registered.find(it => it.id === 'D1'))), '', 'no 보완 요청 on branch items');
    await collector.page.evaluate(() => editRow('H3'));
    await collector.page.getByRole('button', { name: '보완 요청 보내기' }).click();
    await toast(collector.page, '보완을 요청');
    assert.deepEqual(collector.sent.find(p => p.path === '/api/risk/items/H3/reopen').body, { reason: '보완 내용' });
    // Approval box and info line: names only for steps that happened.
    const head = await collector.page.evaluate(() => { assessmentStart = '2026-01-01'; assessmentEnd = '2026-12-31'; return docHead('장흥우체국 위험성평가표', 'jangheung', R.registered.filter(it => it.id === 'H3'), '접수(창구)'); });
    assert.match(head, /<th>담당<\/th><th>과장<\/th><th>우편물류과장<\/th><th>국장<\/th><\/tr><tr><td>우편팀장\(시험\)<\/td><td>영업과장\(시험\)<\/td><td>우편물류과장\(시험\)<\/td><td>총괄국장\(시험\)<\/td>/);
    assert.match(head, /□ 공정명: 접수\(창구\).*□ 평가일: 2026-01-01 ~ 2026-12-31.*□ 평가자: 관리감독자\(영업과장\), 우편팀장, 담당 직원/);
    const pendingBox = await collector.page.evaluate(() => approvalBox('jangheung', R.registered.filter(it => it.id === 'H1')));
    assert.match(pendingBox, /<td>우편팀장\(시험\)<\/td><td>영업과장\(시험\)<\/td><td><\/td><td><\/td>/, 'only the steps done so far');
    const branchBox = await collector.page.evaluate(() => approvalBox('daedeok', R.registered.filter(it => it.id === 'D1')));
    const branchResultBox = await collector.page.evaluate(() => { const d = R.registered.find(it => it.id === 'D1'); return approvalBox('daedeok', [{ ...d, doneAt: '2026-11-07T02:00:00Z', resultPerson: '대덕 담당자', approvals: { ...d.approvals, result: { ...d.approvals.assessment } } }], 'result'); });
    assert.match(branchResultBox, /<td>대덕 담당자<\/td><td>대덕 국장<\/td>/, 'the 이행결과서 box carries the writer and the approving 국장');
    // Queue: both documents of one item at my turn are one row, decided together.
    const grouped = await collector.page.evaluate(() => { const it = R.registered.find(x => x.id === 'H1'); const a = it.approvals.assessment; R.registered.push({ ...it, id: 'H9', approvals: { assessment: a, result: { ...a } } }); const q = myQueue().find(x => x.it.id === 'H9'); R.registered.pop(); return q.docs; });
    assert.deepEqual(grouped, ['assessment', 'result']);
    assert.match(branchBox, /<th>담당<\/th><th>국장<\/th><\/tr><tr><td>대덕 담당자<\/td><td>대덕 국장<\/td>/);
    // Office picker and 관내 전체 print: head office first, branch after it, no page break.
    assert.deepEqual(await collector.page.getByLabel('볼 국').locator('option').allInnerTexts(), ['장흥우체국', '장흥대덕우체국', '관내 전체']);
    const printed = await collector.page.evaluate(() => { officeView = 'all'; return officeDocuments(assessmentRows(), (code, items) => '<h1>' + officeName(code) + '</h1>'); });
    assert.match(printed, /<h1>장흥우체국<\/h1>[\s\S]*<h1>장흥대덕우체국<\/h1>/);
    assert.doesNotMatch(printed, /break-before:page/);
    await collector.page.evaluate(() => { officeView = ''; });
    // Settings.
    assert.equal(await collector.page.locator('#tab-roles').isHidden(), false);
    await collector.page.locator('#tab-roles').click();
    const row = collector.page.locator('tr[data-id="post"]');
    await row.locator('.r-proc').fill('접수(창구), 우편 창구');
    await row.getByRole('button', { name: '저장' }).click();
    await toast(collector.page, '저장했습니다');
    const put = collector.sent.find(p => p.method === 'PUT');
    assert.equal(put.path, '/api/risk/roles/post'); assert.deepEqual(put.body.processes, ['접수(창구)', '우편 창구']); assert.equal(put.body.supervisorId, 'sales');
    await collector.page.locator('#tab-library').click();
    assert.equal(await collector.page.getByRole('button', { name: '근거 자료 백업 내려받기' }).count(), 1, 'head office keeps library admin');
    await collector.page.screenshot({ path: path.join(os.tmpdir(), 'risk-office-hq.png'), fullPage: true });
    assert.deepEqual(collector.errors, []);

    // Branch: its 담당자 is collector and writer; no settings; the library is read-only.
    const branch = await open('branch');
    assert.equal(await branch.page.locator('#tab-roles').isHidden(), true);
    assert.equal(await branch.page.locator('#tab-approval').count(), 0, 'no 결재할 문서·내 건·진행 현황 page');
    await branch.page.locator('#tab-table').click();
    assert.equal(await branch.page.locator('.approval-banner').count(), 0);
    assert.match(await cell(branch.page, '대덕 계단 넘어짐').innerText(), /미결재[\s\S]*이행결과서 작성 후 결재/);
    await branch.page.locator('#tab-library').click();
    assert.equal(await branch.page.getByRole('button', { name: '공식 법령 최신본 적재' }).count(), 0);
    assert.equal(await branch.page.getByRole('button', { name: '근거 자료 백업 내려받기' }).count(), 0);
    assert.deepEqual(branch.errors, []);
    console.log('PASS: 결재 cell in the table (미결재/결재중/결재완료, one 결재 after the 이행결과서, left out of printouts), no 결재 tab, 결재할 문서 box above the table, 감독자 and 담당자(성명) defaults, view-only table for reviewers, collector assigns, confirms in turn, follows progress, asks for 보완 and sets roles, stamped 4-cell box and 평가자 line, 관내 전체 print, branch limits');
  } finally { await browser?.close(); await new Promise(r => server.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
