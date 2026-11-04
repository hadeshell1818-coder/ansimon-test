const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require('playwright');

// Office screens: a branch manager requests approval per half-year, the branch head approves (and only views the
// table), and the head office picks an office, sees approved branch rows read-only and asks for revision. The printed
// approval box shows 담당 and 국장 names; branch accounts get the read-only library.
const offices = [{ code: 'jangheung', name: '장흥우체국', head: true }, { code: 'daedeok', name: '장흥대덕우체국', head: false }];
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const half = `${today.slice(0, 4)}-H${Number(today.slice(5, 7)) <= 6 ? 1 : 2}`;
const branchItem = { id: 'D1', status: 'assessed', officeCode: 'daedeok', officeName: '장흥대덕우체국', createdAt: today, assessmentStartedAt: today,
  customProcess: '집배', factor: '대덕 계단 넘어짐', riskLevel: '중', evaluator: '대덕 담당자', reduction: '미끄럼 방지' };
const hqItem = { id: 'H1', status: 'assessed', officeCode: 'jangheung', officeName: '장흥우체국', createdAt: today, assessmentStartedAt: today,
  customProcess: '소포', factor: '총괄국 소포 끼임', riskLevel: '상', evaluator: '안전보건담당자' };
const report = status => ({ id: 'OR1', officeCode: 'daedeok', officeName: '장흥대덕우체국', half, halfLabel: '반기', itemIds: ['D1'], itemCount: 1, status,
  preparedBy: '대덕 담당자', requestedAt: today + 'T01:00:00Z', approvedBy: status === 'approved' ? '대덕 국장' : null, approvedAt: today + 'T02:00:00Z', approvedOnce: status === 'approved', history: [] });
const views = {
  manager: { user: { kind: 'safety_mgr', org: '장흥대덕우체국', name: '대덕 담당자', officeCode: 'daedeok', officeRole: 'manager', test: true },
    state: { office: { code: 'daedeok', name: '장흥대덕우체국', head: false, role: 'manager' }, registered: [{ ...branchItem, readOnly: false }], reports: [] } },
  head: { user: { kind: 'safety_mgr', org: '장흥대덕우체국', name: '대덕 국장', officeCode: 'daedeok', officeRole: 'head', test: true },
    state: { office: { code: 'daedeok', name: '장흥대덕우체국', head: false, role: 'head' }, registered: [{ ...branchItem, readOnly: true, reportStatus: 'pending' }], reports: [report('pending')] } },
  hq: { user: { kind: 'safety_mgr', org: '장흥우체국', name: '안전보건담당자', officeCode: 'jangheung', officeRole: 'manager' },
    state: { office: { code: 'jangheung', name: '장흥우체국', head: true, role: 'manager' }, registered: [{ ...hqItem, readOnly: false }, { ...branchItem, readOnly: true, reportStatus: 'approved' }], reports: [report('approved')] } },
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

    // Branch manager: request approval for the current half-year; the library is read-only.
    const manager = await open('manager');
    assert.match(await manager.page.locator('#who').innerText(), /장흥대덕우체국 · 대덕 담당자 \(시험용\)/);
    await manager.page.locator('#tab-approval').click();
    await manager.page.getByRole('button', { name: '국장 결재 요청', exact: true }).first().click();
    await manager.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('결재를 요청'));
    assert.deepEqual(manager.posts.find(p => p.path === '/api/risk/office-reports').body, { half });
    await manager.page.locator('#tab-library').click();
    assert.equal(await manager.page.getByRole('button', { name: '공식 법령 최신본 적재' }).count(), 0);
    assert.equal(await manager.page.getByRole('button', { name: '근거 자료 백업 내려받기' }).count(), 0);
    assert.deepEqual(manager.errors, []);

    // Branch head: lands on the report tab, approves; the table has no edit controls and no add button.
    const head = await open('head');
    assert.equal(await head.page.locator('#tab-inbox').isHidden(), true);
    assert.equal(await head.page.locator('#tab-approval').getAttribute('class').then(c => c.includes('on')), true);
    await head.page.getByRole('button', { name: '결재', exact: true }).click();
    await head.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('결재했습니다'));
    assert.ok(head.posts.some(p => p.path === '/api/risk/office-reports/OR1/approve'));
    await head.page.locator('#tab-table').click();
    assert.equal(await head.page.locator('.three-step select').count(), 0);
    assert.equal(await head.page.locator('[contenteditable="true"]').count(), 0);
    assert.equal(await head.page.getByRole('button', { name: '위험성평가 추가' }).count(), 0);
    assert.match(await head.page.locator('.locked-row').innerText(), /국장 결재 대기/);
    assert.deepEqual(head.errors, []);

    // Head office: own rows editable, approved branch rows read-only under the office picker, revision request.
    const hq = await open('hq');
    await hq.page.locator('#tab-table').click();
    const picker = hq.page.getByLabel('볼 국');
    assert.deepEqual(await picker.locator('option').allInnerTexts(), ['장흥우체국 (총괄)', '장흥대덕우체국 · 결재 1건', '관내 전체']);
    assert.equal(await hq.page.locator('.three-step select').count(), 1, 'own row editable');
    await picker.selectOption('daedeok');
    assert.equal(await hq.page.locator('.three-step select').count(), 0);
    assert.equal(await hq.page.getByRole('button', { name: '위험성평가 추가' }).count(), 0);
    // Approval box for printing: the branch report names the preparer and the head; the head office leaves 국장 blank.
    const boxes = await hq.page.evaluate(() => {
      const [from, to] = halfRange(halfOf(localDate())); assessmentStart = from; assessmentEnd = to;
      return [approvalBox('daedeok', R.registered.filter(it => it.officeCode === 'daedeok')), approvalBox('jangheung', R.registered.filter(it => it.officeCode === 'jangheung'))];
    });
    assert.match(boxes[0], /<th>담당<\/th><th>국장<\/th><\/tr><tr><td>대덕 담당자<\/td><td>대덕 국장<\/td>/);
    assert.match(boxes[1], /<td>안전보건담당자<\/td><td><\/td>/);
    await hq.page.locator('#tab-approval').click();
    assert.match(await hq.page.locator('.report-card').innerText(), /장흥대덕우체국/);
    await hq.page.getByRole('button', { name: '보완 요청', exact: true }).click();
    await hq.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('보완을 요청'));
    assert.deepEqual(hq.posts.find(p => p.path === '/api/risk/office-reports/OR1/revision').body, { reason: '보완 내용' });
    await hq.page.locator('#tab-library').click();
    assert.equal(await hq.page.getByRole('button', { name: '근거 자료 백업 내려받기' }).count(), 1, 'head office keeps library admin');
    await hq.page.screenshot({ path: path.join(os.tmpdir(), 'risk-office-hq.png'), fullPage: true });
    assert.deepEqual(hq.errors, []);
    console.log('PASS: branch requests approval, head approves and only views, head office picks offices with read-only branch rows and asks revision, approval box names, library limits');
  } finally { await browser?.close(); await new Promise(r => server.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
