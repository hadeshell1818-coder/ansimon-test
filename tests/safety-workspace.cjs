const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require('playwright');
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
    let connected = false, documents = [], lawImports = 0, missing = 70, indexCalls = 0;
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
        } else data = { connected, documents, message: connected ? 'Supabase 연결됨 (테스트 응답)' : 'Supabase 미연결',
          semantic: connected ? { ready: !missing, message: missing ? `의미 검색 색인 미완료 · 조문 ${missing}개·사례 0건 남음` : '의미 검색 사용 중', sections: { total: 70, missing }, cases: { total: 0, missing: 0 } } : { ready: false, message: 'Supabase 미연결' } };
      }
      if (url.pathname.endsWith('/index-embeddings')) { indexCalls++; const indexed = Math.min(32, missing); missing -= indexed; data = { indexed, sections: { total: 70, missing }, cases: { total: 0, missing: 0 } }; }
      if (url.pathname.endsWith('/evaluate-search')) {
        const { offset } = request.postDataJSON();
        data = { total: 16, offset, semantic: { used: true, error: '' }, results: Array.from({ length: 8 }, (_, i) => ({ id: `C${offset + i}`, desc: '사례', expect: [{ label: '규칙 / 조문', words: i % 2 === 0, add: i % 2 === 0 || i < 5, rrf: i !== 7 }] })) };
      }
      if (url.pathname.endsWith('/import-official-laws')) {
        lawImports++;
        if (!documents.some(doc => doc.title === '산업안전보건법')) documents.push({ title: '산업안전보건법', publisher: '국가법령정보센터', source_url: 'https://www.law.go.kr/', review_status: 'approved', section_count: 3 });
        data = { imported: [{ title: '산업안전보건법', sections: 3 }], failed: lawImports > 1 ? [{ title: '안전검사 고시', error: '안전검사 고시 현행본을 찾지 못했습니다.' }] : [] };
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
      // Offline: nothing can be saved and no unregistered candidates are shown as evidence.
      assert.equal(await page.locator('#import-official-laws').isDisabled(), true);
      assert.equal(await page.locator('#source-form [name=title]').isDisabled(), true);
      assert.equal(await page.locator('#source-rows').innerText(), '검색 결과 없음');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(os.tmpdir(), `safety-workspace-${viewport.width}.png`), fullPage: true });
    }
    connected = true;
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.locator('#import-official-laws').click();
    // The library re-renders after import, so wait for the stored law row rather than the transient status text.
    await page.waitForFunction(() => document.querySelector('#source-rows')?.textContent.includes('산업안전보건법'));
    await page.locator('#import-official-laws').click();
    await page.waitForFunction(() => document.querySelector('#import-official-laws')?.disabled === false);
    await page.waitForFunction(() => document.querySelector('#source-rows')?.textContent.includes('산업안전보건법'));
    assert.equal(lawImports, 2); assert.equal(documents.length, 1);
    // A partially failed import keeps the failure reason visible after the library re-renders.
    await page.waitForFunction(() => document.querySelector('#library-result')?.textContent.includes('적재하지 못한 자료 1종'));
    assert.match(await page.locator('#library-result').innerText(), /안전검사 고시: 안전검사 고시 현행본을 찾지 못했습니다/);
    assert.match(await page.locator('#source-rows').innerText(), /산업안전보건법[\s\S]*본문 3개 저장/);
    // Semantic index: the button keeps requesting batches until nothing is left, then shows the accuracy check.
    assert.match(await page.locator('#semantic-status').innerText(), /조문 70개.*남음.*조문 0\/70/);
    await page.locator('#index-embeddings').click();
    await page.waitForFunction(() => document.querySelector('#semantic-status')?.textContent.includes('의미 검색 사용 중'));
    assert.equal(indexCalls, 3); assert.equal(missing, 0);
    await page.locator('#evaluate-search').click();
    await page.waitForFunction(() => document.querySelector('#semantic-result')?.textContent.includes('기대 근거 16개'));
    assert.match(await page.locator('#semantic-result').innerText(), /단어 검색만\s*8개[\s\S]*의미 검색 추가\(현재 방식\)\s*12개 · 새로 찾음 4 · 밀려남 0[\s\S]*순위 섞기\(이전 방식, 비교용\)\s*14개[\s\S]*새로 찾은 근거 4개[\s\S]*놓친 근거 4개/);
    await page.locator('#source-form [name=title]').fill('테스트 자료');
    await page.locator('#source-form [name=publisher]').fill('테스트 기관');
    await page.locator('#source-form [name=source_url]').fill('https://example.com/test');
    await page.getByRole('button', { name: '출처 등록', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#source-form [name=title]')?.value === '');
    assert.equal(documents.length, 2);
    assert.deepEqual(errors, []);
    console.log('PASS: 3 safety tabs, desktop/mobile, no page overflow, offline controls, official law import, source registration (mock API)');
    console.log('Screenshots:', path.join(os.tmpdir(), 'safety-workspace-1440.png'), path.join(os.tmpdir(), 'safety-workspace-390.png'));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
