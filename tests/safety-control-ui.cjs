const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createFixture } = require('./safety-calls.cjs');

async function main() {
  const fixture = createFixture(), server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => sessionStorage.setItem('cv_safe_token', 'control-test'));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/safety.html`);
    await page.waitForFunction(() => document.querySelector('#today')?.textContent === '2026-09-24');

    await page.getByRole('button', { name: '수신 통화 기록', exact: true }).click();
    await page.locator('#mcCarrier').selectOption('c1');
    assert.equal(await page.locator('#mcName').inputValue(), '시험 직원1');
    await page.locator('#mcNote').fill('시험 1구 도로에 낙석');
    await page.getByRole('button', { name: '통화 내역 저장', exact: true }).click();
    await page.waitForSelector('#callnote');
    assert.equal(fixture.SAFE.calls.length, 1);
    assert.match(await page.locator('#modal').innerText(), /전화 녹음 없음/);

    await page.getByRole('button', { name: '메모 저장 후 전파 작성', exact: true }).click();
    await page.waitForSelector('#alertTargetCount');
    assert.equal(await page.locator('#sendAlertButton').isDisabled(), true, 'no target selected yet');
    await page.locator('#allz').check();
    await page.locator('[name=az][value=z2]').uncheck();
    assert.equal(await page.locator('#allz').isChecked(), false, 'deselecting a zone clears all target flag');
    assert.match(await page.locator('#alertTargetCount').innerText(), /발송 대상 1명/);
    await page.locator('#sendAlertButton').click();
    await page.waitForFunction(() => !document.querySelector('#modal').classList.contains('on'));
    assert.deepEqual(fixture.sent[0], ['c1']);

    await page.evaluate(id => callDetail(id), fixture.SAFE.calls[0].id);
    await page.getByRole('button', { name: '메모 저장 후 전파 작성', exact: true }).click();
    await page.waitForSelector('#allz'); await page.locator('#allz').check();
    await page.locator('#sendAlertButton').click();
    await page.waitForFunction(() => !document.querySelector('#modal').classList.contains('on'));
    assert.deepEqual(fixture.sent[1], ['c1', 'c2']);
    assert.equal(fixture.SAFE.calls[0].alertIds.length, 2);

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
      await page.screenshot({ path: path.join(os.tmpdir(), `safety-control-${width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('PASS: call memo from roster, call-linked selected/all zone alerts, desktop/mobile layout');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
