const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require('playwright');
const candidates = require('../seed-assets/safety-sources.json');
async function main() {
  const app = express();
  app.use(express.static(path.join(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let connected = false, documents = [];
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      let data = {};
      if (url.pathname === '/api/me') data = { user: { id: 'test', kind: 'safety_mgr', org: '테스트 우체국', name: '시험 담당자' } };
      if (url.pathname === '/api/risk/state') data = { inbox: [], registered: [], processes: [], hazardTypes: {}, threshold: 10 };
      if (url.pathname === '/api/risk/report-summary') data = { total: 0, assessed: 0, highRisk: 0, highRiskDone: 0, pending: 0, days: 30, office: '시험', generatedAt: new Date().toISOString(), byProc: [], improved: [] };
      if (url.pathname === '/api/safety-knowledge') {
        if (request.method() === 'POST') {
          documents.push({ ...request.postDataJSON(), review_status: 'pending', jurisdiction: '미확인', rights_note: '이용조건 확인 필요' });
          data = { added: [documents.at(-1)] };
        } else data = { connected, documents, candidates, message: connected ? 'Supabase 연결됨 (테스트 응답)' : 'Supabase 미연결 · 출처 후보만 준비됨' };
      }
      if (url.pathname.endsWith('/seed')) {
        const added = candidates.filter(item => !documents.some(doc => doc.source_url === item.source_url));
        documents.push(...added); data = { added };
      }
      await route.fulfill({ json: data });
    });
    await page.addInitScript(() => sessionStorage.setItem('cv_risk_token', 'test-only'));
    await page.goto(`http://127.0.0.1:${server.address().port}/risk.html`);
    await page.waitForFunction(() => document.querySelector('#on-knowledge').textContent.includes('미연결'));
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const id of ['inbox','table','library']) {
        await page.locator('#tab-' + id).click();
        await page.waitForTimeout(50);
        assert(await page.locator('#content').innerText());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${id}, ${viewport.width}`);
      }
      assert.equal(await page.locator('#seed-sources').isDisabled(), true);
      await page.locator('#source-search').fill('롤파렛트');
      assert.equal(await page.locator('#source-rows tr').count(), 4);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(os.tmpdir(), `safety-workspace-${viewport.width}.png`), fullPage: true });
    }
    connected = true;
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.locator('#seed-sources').click();
    await page.waitForFunction(() => document.querySelector('#seed-sources')?.disabled === false);
    assert.equal(documents.length, 7);
    await page.locator('#seed-sources').click();
    await page.waitForFunction(() => document.querySelector('#seed-sources')?.disabled === false);
    assert.equal(documents.length, 7);
    await page.locator('[name=title]').fill('테스트 자료');
    await page.locator('[name=publisher]').fill('테스트 기관');
    await page.locator('[name=source_url]').fill('https://example.com/test');
    await page.getByRole('button', { name: '출처 등록', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[name=title]')?.value === '');
    assert.equal(documents.length, 8);
    assert.deepEqual(errors, []);
    console.log('PASS: 3 safety tabs, desktop/mobile, no page overflow, source search, offline controls, seed idempotency, source registration (mock API)');
    console.log('Screenshots:', path.join(os.tmpdir(), 'safety-workspace-1440.png'), path.join(os.tmpdir(), 'safety-workspace-390.png'));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
