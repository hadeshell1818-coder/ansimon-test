const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createFixture, wavBuffer } = require('./safety-calls.cjs');

async function main() {
  const fixture = createFixture(), server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      sessionStorage.setItem('cv_safe_token', 'control-test');
      window.recordedStreams = [];
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await get(...args); window.recordedStreams.push(stream); return stream; };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/safety.html`);
    await page.waitForFunction(() => document.querySelector('#today').textContent === '2026-09-24');
    await page.getByRole('button', { name: '통계·증빙', exact: true }).click();
    assert.match(await page.locator('#statsSample').innerText(), /총원 10 − 결원 2 = 현원 8/);
    assert.equal(await page.locator('#statsSample tbody tr').count(), 16);
    await page.getByRole('button', { name: '월별 예시', exact: true }).click();
    assert.match(await page.locator('#statsSample').innerText(), /총원 30 − 결원 5 = 현원 25/);
    assert.equal(fixture.SAFE.calls.length, 0, 'samples must not create production records');
    await page.screenshot({ path: path.join(os.tmpdir(), 'safety-control-month-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: '상황관제', exact: true }).click();
    await page.getByRole('button', { name: '수신 통화 기록', exact: true }).click();
    await page.getByRole('button', { name: '녹음 시작' }).click();
    await page.waitForFunction(() => document.querySelector('#caStatus').textContent.includes('녹음 중'));
    await page.waitForTimeout(1300);
    await page.getByRole('button', { name: '녹음 정지' }).click();
    await page.waitForSelector('#caPending audio');
    assert(await page.evaluate(() => recordedStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))));
    await page.locator('#mcCarrier').selectOption('c1');
    await page.getByRole('button', { name: '통화 기록 저장', exact: true }).click();
    await page.waitForSelector('#caSaved .call-recording');
    assert.equal(fixture.SAFE.calls.length, 1); assert.equal(fixture.SAFE.calls[0].recordings.length, 1);
    await page.getByRole('button', { name: '문자로 변환', exact: true }).click();
    await page.waitForSelector('#caSaved textarea');
    await page.getByRole('button', { name: '통화 메모에 반영', exact: true }).click();
    assert.match(await page.locator('#callnote').inputValue(), /낙석/);
    await page.getByRole('button', { name: '메모 저장 후 알림 작성', exact: true }).click();
    await page.waitForSelector('#alertTargetCount');
    assert.match(await page.locator('#alertTargetCount').innerText(), /발송 대상 1명/);
    await page.locator('#allz').check();
    await page.locator('[name=az][value=z2]').uncheck();
    assert.equal(await page.locator('#allz').isChecked(), false, 'deselecting a zone clears all target flag');
    await page.getByRole('button', { name: '확인 후 알림 발송' }).click();
    await page.waitForFunction(() => !document.querySelector('#modal').classList.contains('on'));
    assert.deepEqual(fixture.sent[0], ['c1']);
    await page.locator('#callList .row').first().click();
    await page.getByRole('button', { name: '메모 저장 후 알림 작성', exact: true }).click();
    await page.waitForSelector('#allz'); await page.locator('#allz').check();
    await page.getByRole('button', { name: '확인 후 알림 발송' }).click();
    await page.waitForFunction(() => !document.querySelector('#modal').classList.contains('on'));
    assert.deepEqual(fixture.sent[1], ['c1', 'c2']);
    await page.locator('#callList .row').first().click();
    await page.locator('#caFile').setInputFiles({ name: 'phone.wav', mimeType: 'audio/wav', buffer: wavBuffer() });
    await page.getByRole('button', { name: '녹음 저장', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#caSaved .call-recording').length === 2);
    fixture.state.stt = null;
    await page.getByRole('button', { name: '문자로 변환', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#caStatus').textContent.includes('문자 변환에 실패'));
    assert.equal(fixture.SAFE.calls[0].recordings.length, 2);
    await page.getByRole('button', { name: '녹음 재생', exact: true }).last().click();
    await page.waitForFunction(() => [...document.querySelectorAll('#caSaved audio')].some(audio => audio.readyState >= 1));
    await page.screenshot({ path: path.join(os.tmpdir(), 'safety-control-call-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.getByRole('button', { name: '통계·증빙', exact: true }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
      await page.screenshot({ path: path.join(os.tmpdir(), `safety-control-day-${width}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: '상황관제', exact: true }).click();
    await page.getByRole('button', { name: '수신 통화 기록', exact: true }).click();
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
    await page.getByRole('button', { name: '녹음 시작' }).click();
    await page.waitForFunction(() => document.querySelector('#caStatus').textContent.includes('권한이 거부'));
    assert.equal(await page.getByRole('button', { name: '통화 기록 저장', exact: true }).isDisabled(), false);
    await page.locator('#caFile').setInputFiles({ name: 'phone.wav', mimeType: 'audio/wav', buffer: wavBuffer() });
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '닫기', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log('PASS: sample day/month, desktop/mobile layout, real MediaRecorder with fake input, file upload, STT failure, playback, target selection/all send, permission denial, cleanup');
    console.log('Screenshots: ' + path.join(os.tmpdir(), 'safety-control-*.png'));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); fixture.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
