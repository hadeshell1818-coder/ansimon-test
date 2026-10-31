const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

// The carrier app must be installable from the home screen (Chrome reports no installability errors),
// offer a one-tap install where the browser allows it, keep iPhone users on the Share → 홈 화면에 추가 path,
// and show an offline notice that never claims a report was sent.
async function main() {
  const app = express();
  app.use(express.static(path.join(__dirname, '../public')));
  app.use('/api', (_req, res) => res.status(401).json({ error: 'login required' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/report.html`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cdp = await context.newCDPSession(page);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    assert.deepEqual(installabilityErrors, [], 'Chrome reports the carrier app as installable');
    const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(manifest.start_url, '/report.html'); assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable') && manifest.icons.some(icon => icon.purpose === 'any'));

    // One-tap install: the browser's install event turns the banner into an install button.
    const outcome = await page.evaluate(async () => {
      const shown = [];
      const event = new Event('beforeinstallprompt');
      event.prompt = () => shown.push('prompt');
      event.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(event);
      const banner = installBanner();
      await installApp();
      return { banner, shown, after: installBanner() };
    });
    assert.match(outcome.banner, /앱 설치/); assert.deepEqual(outcome.shown, ['prompt']);
    assert.doesNotMatch(outcome.after, /ib-install/, 'the prompt can be used once');

    // iPhone Safari has no install prompt: show the Share steps and hold back push until installed.
    const iphone = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
    const iphonePage = await iphone.newPage();
    await iphonePage.goto(`${base}/report.html`);
    assert.match(await iphonePage.evaluate(() => installBanner()), /공유 버튼[\s\S]*홈 화면에 추가[\s\S]*알림/);
    assert.equal(await iphonePage.evaluate(() => sfPushPromptHtml()), '');
    await iphone.close();

    // Offline: navigations fall back to the cached notice; nothing is shown as sent.
    await page.reload(); await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await context.setOffline(true);
    await page.goto(`${base}/report.html?offline-check`).catch(() => {});
    assert.match(await page.locator('body').innerText(), /인터넷에 연결되어 있지 않습니다[\s\S]*전송되지 않습니다[\s\S]*119/);
    await context.setOffline(false);
    assert.deepEqual(errors, []);
    // Android app (Trusted Web Activity): asset links only list valid SHA-256 fingerprints; the wrapper opens /report.html.
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const snippet = source.slice(source.indexOf('function androidAssetLinks'), source.indexOf("app.get('/.well-known/assetlinks.json'"));
    const assetLinks = vm.runInNewContext(`${snippet}; androidAssetLinks`, { String, process: { env: {} } });
    const fp = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0')).join(':');
    const plain = value => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(assetLinks({})), []);
    assert.deepEqual(plain(assetLinks({ ANDROID_SHA256_FINGERPRINTS: `${fp}, not-a-fingerprint` })[0].target), { namespace: 'android_app', package_name: 'kr.ansimon.app', sha256_cert_fingerprints: [fp.toUpperCase()] });
    const manifestXml = fs.readFileSync(path.join(__dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8');
    const gradle = fs.readFileSync(path.join(__dirname, '../android/app/build.gradle'), 'utf8');
    assert.match(manifestXml, /trusted\.LauncherActivity[\s\S]*DEFAULT_URL[\s\S]*\$\{defaultUrl\}[\s\S]*DelegationService/);
    assert.match(gradle, /defaultUrl: siteUrl \+ '\/report\.html'/);
    assert.ok(fs.existsSync(path.join(__dirname, '../.github/workflows/android-apk.yml')));
    console.log('PASS: installable carrier app, one-tap install prompt, iPhone add-to-home guidance, offline notice');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
