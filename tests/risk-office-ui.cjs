const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require('playwright');

// Risk screens by role (2026-11-07): the collector assigns app reports, follows progress before approval, asks for 보완,
// sends the yearly 정기평가 to the 총괄국장 and sets roles; a writer bundles 평가표 and 이행결과서 for the 결재자; the 결재자
// approves the bundle once and only views the table. Printed forms carry □ 공정명 □ 평가일 □ 평가자 and an approval box
// (담당 · 과장 · 국장 at the head office, 담당 · 국장 at a branch) stamped with the names of the steps that happened.
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
const H3 = base('H3', { factor: '번호표 발행기 전선 걸림', assignedTo: 'post', assignedName: '우편팀장(시험)', doneAt: today + 'T03:00:00Z', resultUpdatedAt: today + 'T03:00:00Z', afterRiskLevel: '하',
  approvals: { assessment: { status: 'approved', requestedBy: '우편팀장(시험)', approvedBy: '영업과장(시험)', approvedOnce: true } } });
const D1 = base('D1', { officeCode: 'daedeok', officeName: '장흥대덕우체국', customProcess: '집배', factor: '대덕 계단 넘어짐', assignedTo: 'dd', readOnly: true, canImprove: false,
  approvals: { assessment: { status: 'approved', requestedBy: '대덕 담당자', approvedBy: '대덕 국장', approvedOnce: true } } });
const pendingBundle = { id: 'AB1', kind: 'regular', officeCode: 'jangheung', officeName: '장흥우체국', status: 'pending', requestedBy: '우편팀장(시험)', requestedById: 'post', requestedAt: today + 'T04:00:00Z',
  approverId: 'sales', approverName: '영업과장(시험)', assessmentIds: ['H1'], resultIds: [], items: [{ id: 'H1', process: '접수(창구)', factor: H1.factor, riskLevel: '중' }] };
const me = id => { const a = accounts.find(x => x.id === id); return { id, name: a.name, title: a.title, collector: a.collector, writer: a.writer, approver: a.approver, chief: a.chief, supervisorId: a.supervisorId, processes: a.processes }; };
const views = {
  writer: { user: { kind: 'safety_mgr', org: '장흥우체국', name: '우편팀장(시험)', test: true },
    state: { me: me('post'), office: { code: 'jangheung', name: '장흥우체국', head: true, role: 'writer' }, registered: [H1, H3], bundles: [], submissions: [] } },
  approver: { user: { kind: 'safety_mgr', org: '장흥우체국', name: '영업과장(시험)', test: true },
    state: { me: me('sales'), office: { code: 'jangheung', name: '장흥우체국', head: true, role: 'head' },
      registered: [{ ...H1, readOnly: true, canImprove: false, approvals: { assessment: { status: 'pending', bundleId: 'AB1', requestedBy: '우편팀장(시험)' } } }], bundles: [pendingBundle], submissions: [] } },
  collector: { user: { kind: 'safety_mgr', org: '장흥우체국', name: '서무팀장(시험)', test: true },
    state: { me: me('hq'), office: { code: 'jangheung', name: '장흥우체국', head: true, role: 'collector' },
      inbox: [{ id: 'I1', status: 'inbox', source: 'staff', reporter: '직원', createdAt: today + 'T00:00:00Z', note: '창구 앞 매트 들림', officeCode: 'jangheung' }],
      registered: [{ ...H1, readOnly: true }, { ...H3, readOnly: true }, D1], bundles: [pendingBundle], submissions: [{ officeCode: 'jangheung', writerId: 'post', writerName: '우편팀장(시험)', from: today.slice(0, 4) + '-01-01', to: today, itemCount: 2, at: today + 'T05:00:00Z' }] } },
  branch: { user: { kind: 'safety_mgr', org: '장흥대덕우체국', name: '대덕 담당자', test: true },
    state: { me: me('dd'), office: { code: 'daedeok', name: '장흥대덕우체국', head: false, role: 'collector' }, registered: [{ ...D1, readOnly: false, canImprove: true, approvals: {} }], bundles: [], submissions: [] } },
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
        if (method === 'POST' || method === 'PUT') { sent.push({ method, path: url.pathname, body: route.request().postDataJSON() }); data = { ok: true }; }
        await route.fulfill({ json: data });
      });
      await page.addInitScript(() => sessionStorage.setItem('cv_risk_token', 'test-only'));
      await page.goto(url0 + '/risk.html');
      await page.locator('#app').waitFor({ state: 'visible' });
      return { page, errors, sent };
    };
    const toast = (page, text) => page.waitForFunction(t => document.querySelector('#toast')?.textContent.includes(t), text);

    // Writer: no inbox or settings; bundles the unapproved 평가표 and the written 이행결과서 together for the 결재자.
    const writer = await open('writer');
    assert.equal(await writer.page.locator('#tab-inbox').isHidden(), true, 'app reports go to the collector');
    assert.equal(await writer.page.locator('#tab-roles').isHidden(), true);
    assert.equal(await writer.page.locator('#tab-table').getAttribute('class').then(c => c.includes('on')), true);
    await writer.page.getByRole('button', { name: '보기·수정', exact: true }).first().click();
    assert.equal(await writer.page.locator('#e-owner').inputValue(), '영업과장(시험)', '감독자 defaults to the writer’s 결재자');
    await writer.page.getByRole('button', { name: '닫기', exact: true }).click();
    await writer.page.locator('#tab-approval').click();
    assert.deepEqual(await writer.page.locator('.pick-assessment').evaluateAll(xs => xs.map(x => x.value)), ['H1']);
    assert.deepEqual(await writer.page.locator('.pick-result').evaluateAll(xs => xs.map(x => x.value)), ['H3']);
    assert.equal(await writer.page.locator('#bundle-approver').inputValue(), 'sales');
    await writer.page.getByRole('button', { name: '결재 올리기', exact: true }).click();
    await toast(writer.page, '결재를 올렸습니다');
    const sentBundle = writer.sent.find(p => p.path === '/api/risk/bundles').body;
    assert.deepEqual([sentBundle.kind, sentBundle.assessmentIds, sentBundle.resultIds, sentBundle.approverId], ['regular', ['H1'], ['H3'], 'sales']);
    // 이행결과서: 담당자(성명) with the writer's name.
    await writer.page.locator('#tab-table').click();
    await writer.page.evaluate(() => openImprove('H1'));
    assert.equal(await writer.page.locator('label', { hasText: /^담당자\(성명\)$/ }).count(), 1);
    assert.equal(await writer.page.locator('#i-person').inputValue(), '우편팀장(시험)');
    const resultForm = await writer.page.evaluate(() => resultFormHtml(R.registered.find(it => it.id === 'H3')));
    assert.match(resultForm, /<th>담당자\(성명\)<\/th>/);
    assert.match(resultForm, /approval-box three/);
    assert.deepEqual(writer.errors, []);

    // Approver: lands on 결재, approves the bundle once; the table is view-only.
    const approver = await open('approver');
    assert.equal(await approver.page.locator('#tab-approval').getAttribute('class').then(c => c.includes('on')), true);
    assert.equal(await approver.page.locator('#approvalN').innerText(), '1');
    assert.match(await approver.page.locator('.report-card').first().innerText(), /창구 의자 바퀴 미끄러짐/);
    await approver.page.getByRole('button', { name: '결재', exact: true }).click();
    await toast(approver.page, '결재했습니다');
    assert.ok(approver.sent.some(p => p.path === '/api/risk/bundles/AB1/approve'));
    await approver.page.locator('#tab-table').click();
    assert.equal(await approver.page.locator('.three-step select').count(), 0);
    assert.equal(await approver.page.locator('[contenteditable="true"]').count(), 0);
    assert.equal(await approver.page.getByRole('button', { name: '위험성평가 추가' }).count(), 0);
    assert.match(await approver.page.locator('.locked-row').innerText(), /평가표 결재 대기/);
    assert.deepEqual(approver.errors, []);

    // Collector: assigns an app report, sees progress before approval, asks for 보완, sends the 정기평가, sets roles.
    const collector = await open('collector');
    assert.match(await collector.page.locator('#inboxList').innerText(), /창구 앞 매트 들림/);
    await collector.page.locator('#assign-I1').selectOption('post');
    await collector.page.getByRole('button', { name: '배분', exact: true }).click();
    await toast(collector.page, '배분했습니다');
    assert.deepEqual(collector.sent.find(p => p.path === '/api/risk/items/I1/assign').body, { writerId: 'post' });
    await collector.page.locator('#tab-approval').click();
    const progress = await collector.page.locator('.progress-table').innerText();
    assert.match(progress, /우편팀장 우편팀장\(시험\)[\s\S]*창구 의자 바퀴 미끄러짐[\s\S]*작성 중/);
    assert.match(progress, /이행결과서 결재 전/);
    await collector.page.locator('.progress-table tr', { hasText: 'H3' }).getByRole('button', { name: '보완 요청' }).click();
    await toast(collector.page, '보완을 요청');
    assert.deepEqual(collector.sent.find(p => p.path === '/api/risk/items/H3/reopen').body, { reason: '보완 내용' });
    assert.match(await collector.page.locator('.form-section', { hasText: '정기평가' }).first().innerText(), /우편팀장\(시험\)[\s\S]*2건/);
    await collector.page.getByRole('button', { name: '총괄국장 결재 올리기' }).click();
    await toast(collector.page, '총괄국장 결재를 올렸습니다');
    const annual = collector.sent.find(p => p.path === '/api/risk/bundles' && p.body.kind === 'annual').body;
    assert.equal(annual.approverId, 'chief');
    // Approval box and info line: names only for steps that happened; 평가자 = 관리감독자(과장), 팀장, 담당 직원.
    const head = await collector.page.evaluate(() => { assessmentStart = '2026-01-01'; assessmentEnd = '2026-12-31'; return docHead('장흥우체국 위험성평가표', 'jangheung', R.registered.filter(it => it.id === 'H3'), '접수(창구)'); });
    assert.match(head, /<th>담당<\/th><th>과장<\/th><th>국장<\/th><\/tr><tr><td>우편팀장\(시험\)<\/td><td>영업과장\(시험\)<\/td><td><\/td>/);
    assert.match(head, /□ 공정명: 접수\(창구\).*□ 평가일: 2026-01-01 ~ 2026-12-31.*□ 평가자: 관리감독자\(영업과장\), 우편팀장, 담당 직원/);
    const branchBox = await collector.page.evaluate(() => approvalBox('daedeok', R.registered.filter(it => it.id === 'D1')));
    assert.match(branchBox, /<th>담당<\/th><th>국장<\/th><\/tr><tr><td>대덕 담당자<\/td><td>대덕 국장<\/td>/);
    // Office picker and 관내 전체 print: head office first, branch after it, no page break.
    await collector.page.locator('#tab-table').click();
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
    await branch.page.locator('#tab-approval').click();
    assert.equal(await branch.page.locator('#bundle-approver').inputValue(), 'ddHead');
    assert.equal(await branch.page.getByRole('button', { name: '총괄국장 결재 올리기' }).count(), 0);
    await branch.page.locator('#tab-library').click();
    assert.equal(await branch.page.getByRole('button', { name: '공식 법령 최신본 적재' }).count(), 0);
    assert.equal(await branch.page.getByRole('button', { name: '근거 자료 백업 내려받기' }).count(), 0);
    assert.deepEqual(branch.errors, []);
    console.log('PASS: writer bundles 평가표+이행결과서, 감독자 and 담당자(성명) defaults, approver approves once and only views, collector assigns, follows progress, asks for 보완, sends 정기평가 and sets roles, stamped approval box and 평가자 line, 관내 전체 print, branch limits');
  } finally { await browser?.close(); await new Promise(r => server.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
