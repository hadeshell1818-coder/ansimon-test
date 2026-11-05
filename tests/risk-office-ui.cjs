const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require('playwright');

// Office screens (per-item approval, 2026-11-05): a branch manager requests the head's approval for one assessment, the
// branch head approves it item by item (and only views the table), and the head office picks an office (no counts in
// the picker), sees approved branch rows read-only and asks for revision. The 결재 tab lists one year. The printed
// approval box shows 담당 and 국장 names; 관내 전체 prints the head office first and the branches after it with no
// page break; branch accounts get the read-only library.
const offices = [{ code: 'jangheung', name: '장흥우체국', head: true, headName: '' }, { code: 'daedeok', name: '장흥대덕우체국', head: false, headName: '대덕 국장' }];
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const branchItem = { id: 'D1', status: 'assessed', officeCode: 'daedeok', officeName: '장흥대덕우체국', createdAt: today, assessmentStartedAt: today,
  customProcess: '집배', factor: '대덕 계단 넘어짐', riskLevel: '중', evaluator: '대덕 담당자', reduction: '미끄럼 방지' };
const hqItem = { id: 'H1', status: 'assessed', officeCode: 'jangheung', officeName: '장흥우체국', createdAt: today, assessmentStartedAt: today,
  customProcess: '소포', factor: '총괄국 소포 끼임', riskLevel: '상', evaluator: '안전보건담당자' };
const approval = status => ({ status, requestedBy: '대덕 담당자', requestedAt: today + 'T01:00:00Z', approvedBy: status === 'approved' ? '대덕 국장' : null,
  approvedAt: today + 'T02:00:00Z', approvedOnce: status === 'approved', history: [] });
const views = {
  manager: { user: { kind: 'safety_mgr', org: '장흥대덕우체국', name: '대덕 담당자', officeCode: 'daedeok', officeRole: 'manager', test: true },
    state: { office: { code: 'daedeok', name: '장흥대덕우체국', head: false, role: 'manager', headName: '대덕 국장' }, registered: [{ ...branchItem, readOnly: false, canImprove: true, approval: null }] } },
  head: { user: { kind: 'safety_mgr', org: '장흥대덕우체국', name: '대덕 국장', officeCode: 'daedeok', officeRole: 'head', test: true },
    state: { office: { code: 'daedeok', name: '장흥대덕우체국', head: false, role: 'head', headName: '대덕 국장' }, registered: [{ ...branchItem, readOnly: true, canImprove: false, approval: approval('pending') }] } },
  hq: { user: { kind: 'safety_mgr', org: '장흥우체국', name: '안전보건담당자', officeCode: 'jangheung', officeRole: 'manager' },
    state: { office: { code: 'jangheung', name: '장흥우체국', head: true, role: 'manager', headName: '' }, registered: [{ ...hqItem, readOnly: false, canImprove: true, approval: null }, { ...branchItem, readOnly: true, canImprove: false, approval: approval('approved') }] } },
};

async function main() {
  const app = express(); app.use(express.static(path.join(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const open = async role => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul' }), errors = [], posts = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('dialog', dialog => dialog.type() === 'prompt' ? dialog.accept('보완 내용') : dialog.accept());
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url()); let data = {};
        if (url.pathname === '/api/me') data = { user: views[role].user };
        if (url.pathname === '/api/risk/state') data = { inbox: [], processes: [], hazardTypes: {}, criteria: { levels: [] }, offices, ...views[role].state };
        if (url.pathname === '/api/safety-knowledge') data = { connected: true, documents: [], candidates: [] };
        if (route.request().method() === 'POST') { posts.push({ path: url.pathname, body: route.request().postDataJSON() }); data = { ok: true }; }
        await route.fulfill({ json: data });
      });
      await page.addInitScript(() => sessionStorage.setItem('cv_risk_token', 'test-only'));
      await page.goto(base + '/risk.html');
      await page.locator('#app').waitFor({ state: 'visible' });
      return { page, errors, posts };
    };

    // Branch manager: request approval for one assessment from its row; the library is read-only.
    const manager = await open('manager');
    assert.match(await manager.page.locator('#who').innerText(), /장흥대덕우체국 · 대덕 담당자 \(시험용\)/);
    await manager.page.locator('#tab-table').click();
    await manager.page.getByRole('button', { name: '국장 결재 요청', exact: true }).first().click();
    await manager.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('결재를 요청'));
    assert.ok(manager.posts.some(p => p.path === '/api/risk/items/D1/approval/request'));
    // The 위험성평가표 form: 담당자 in the evaluation part, 감독자 (default: the office head) in the plan.
    await manager.page.getByRole('button', { name: '보기·수정', exact: true }).click();
    assert.equal(await manager.page.locator('label', { hasText: /^감독자$/ }).count(), 1);
    assert.equal(await manager.page.locator('#e-owner').inputValue(), '대덕 국장');
    assert.equal(await manager.page.locator('#e-report-result').count(), 0, 'no separate reporter-result box');
    await manager.page.getByRole('button', { name: '닫기', exact: true }).click();
    await manager.page.locator('#tab-approval').click();
    assert.match(await manager.page.locator('.report-card').innerText(), /대덕 계단 넘어짐/);
    await manager.page.locator('#tab-library').click();
    assert.equal(await manager.page.getByRole('button', { name: '공식 법령 최신본 적재' }).count(), 0);
    assert.equal(await manager.page.getByRole('button', { name: '근거 자료 백업 내려받기' }).count(), 0);
    assert.deepEqual(manager.errors, []);

    // Branch head: lands on the 결재 tab, approves the item; the table has no edit controls and no add button.
    const head = await open('head');
    assert.equal(await head.page.locator('#tab-inbox').isHidden(), true);
    assert.equal(await head.page.locator('#tab-approval').getAttribute('class').then(c => c.includes('on')), true);
    assert.equal(await head.page.locator('#approvalN').innerText(), '1');
    await head.page.getByRole('button', { name: '결재', exact: true }).first().click();
    await head.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('결재했습니다'));
    assert.ok(head.posts.some(p => p.path === '/api/risk/items/D1/approval/approve'));
    await head.page.locator('#tab-table').click();
    assert.equal(await head.page.locator('.three-step select').count(), 0);
    assert.equal(await head.page.locator('[contenteditable="true"]').count(), 0);
    assert.equal(await head.page.getByRole('button', { name: '위험성평가 추가' }).count(), 0);
    assert.match(await head.page.locator('.locked-row').innerText(), /국장 결재 대기/);
    assert.deepEqual(head.errors, []);

    // Head office: the office picker has names only; own rows editable, approved branch rows read-only, revision request.
    const hq = await open('hq');
    await hq.page.locator('#tab-table').click();
    const picker = hq.page.getByLabel('볼 국');
    assert.deepEqual(await picker.locator('option').allInnerTexts(), ['장흥우체국', '장흥대덕우체국', '관내 전체']);
    assert.equal(await hq.page.locator('.three-step select').count(), 1, 'own row editable');
    await picker.selectOption('daedeok');
    assert.equal(await hq.page.locator('.three-step select').count(), 0);
    assert.equal(await hq.page.getByRole('button', { name: '위험성평가 추가' }).count(), 0);
    // Approval box: the branch names the writer and its head; the head office leaves 국장 blank.
    const boxes = await hq.page.evaluate(() => [approvalBox('daedeok', R.registered.filter(it => it.officeCode === 'daedeok')), approvalBox('jangheung', R.registered.filter(it => it.officeCode === 'jangheung'))]);
    assert.match(boxes[0], /<th>담당<\/th><th>국장<\/th><\/tr><tr><td>대덕 담당자<\/td><td>대덕 국장<\/td>/);
    assert.match(boxes[1], /<td>안전보건담당자<\/td><td><\/td>/);
    // 관내 전체 print: head office first, branch after it, no page break between offices.
    const printed = await hq.page.evaluate(() => { officeView = 'all'; return officeDocuments(assessmentRows(), (code, items) => '<h1>' + officeName(code) + '</h1>'); });
    assert.match(printed, /<h1>장흥우체국<\/h1>[\s\S]*<h1>장흥대덕우체국<\/h1>/);
    assert.doesNotMatch(printed, /break-before:page/);
    await hq.page.evaluate(() => { officeView = ''; });
    await hq.page.locator('#tab-approval').click();
    assert.match(await hq.page.locator('.report-card').innerText(), /장흥대덕우체국/);
    await hq.page.getByRole('button', { name: '보완 요청', exact: true }).click();
    await hq.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('보완을 요청'));
    assert.deepEqual(hq.posts.find(p => p.path === '/api/risk/items/D1/approval/revision').body, { reason: '보완 내용' });
    await hq.page.locator('#tab-library').click();
    assert.equal(await hq.page.getByRole('button', { name: '근거 자료 백업 내려받기' }).count(), 1, 'head office keeps library admin');
    await hq.page.screenshot({ path: path.join(os.tmpdir(), 'risk-office-hq.png'), fullPage: true });
    assert.deepEqual(hq.errors, []);
    console.log('PASS: per-item request from the row, 담당자/감독자 form, head approves item by item and only views, head office picker without counts, read-only branch rows, revision, approval box names, 관내 전체 printed without page breaks, library limits');
  } finally { await browser?.close(); await new Promise(r => server.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
