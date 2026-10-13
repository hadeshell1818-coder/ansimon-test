const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const app = express(); app.use(express.static(path.join(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const item = { id: 'K1', factor: '정문 출입문이 바람에 날려 통행인과 충돌 위험', reduction: '기존 담당자 대책', status: 'assessing', customProcess: '시설물', createdAt: new Date().toISOString(), assessmentStartedAt: new Date().toISOString() };
    const original = JSON.stringify(item); let writes = 0, mode = 'search';
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()); let data = {};
      if (url.pathname === '/api/me') data = { user: { id: 'manager', kind: 'safety_mgr', name: '담당자' } };
      if (url.pathname === '/api/risk/state') data = { registered: [item], inbox: [], processes: [], hazardTypes: {}, criteria: { levels: [] } };
      if (url.pathname === '/api/safety-knowledge') data = { connected: false, documents: [], candidates: [] };
      if (url.pathname === '/api/risk/items/K1') writes++;
      if (url.pathname === '/api/safety-knowledge/recommend') {
        if (mode === 'service') return route.fulfill({ status: 503, json: { code: 'ai_invalid_response', stage: '초안 재검토', error: '초안 재검토: AI 응답 형식 오류. 입력 내용은 유지됩니다.' } });
        data = { status: 'search_failed', noEvidence: true, externalSearch: { error: '외부 검색 설정 오류' }, measures: [], citations: [], evidence: [], review: { passed: false, needsAttention: true } };
      }
      await route.fulfill({ json: data });
    });
    await page.addInitScript(() => sessionStorage.setItem('cv_risk_token', 'test'));
    await page.goto(`http://127.0.0.1:${server.address().port}/risk.html`);
    await page.waitForFunction(() => typeof R !== 'undefined' && R.registered?.length);
    await page.evaluate(() => editRow('K1'));
    await page.locator('#risk-advice-button').click();
    await page.getByText('근거 검색 장애', { exact: true }).waitFor();
    assert.equal(await page.locator('#e-factor').inputValue(), item.factor);
    assert.equal(writes, 0); assert.equal(JSON.stringify(item), original);
    assert.equal(await page.locator('#risk-advice-button').isDisabled(), false);
    mode = 'service'; await page.locator('#risk-advice-button').click();
    await page.getByText(/초안 재검토: AI 응답 형식 오류/).waitFor();
    assert.equal(writes, 0); assert.equal(await page.locator('#e-factor').inputValue(), item.factor);
    assert.equal(await page.locator('#risk-advice-button').isDisabled(), false);

    await page.unroute('**/api/**'); let dispatches = 0;
    const hazard = { id: 'H1', carrier: '시험 직원', transcript: '원본 신고 내용', createdAt: new Date().toISOString(), status: 'pending', draft: { text: '참고 문구', mode: 'rule', zones: ['z1'], aiError: 'AI 알림 초안을 작성하지 못했습니다. 원본을 확인하고 직접 검토해 주세요.' } };
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()); let data = {};
      if (url.pathname === '/api/me') data = { user: { kind: 'safety', name: '관제', org: '시험' } };
      if (url.pathname === '/api/safety/state') data = { today: '2026-10-13', hazards: [hazard], calls: [], alerts: [], zones: [{ id: 'z1', name: '구역1' }], roster: [], levels: {} };
      if (url.pathname === '/api/on/returns') data = { summary: { total: 0, absent: 0, target: 0, reported: 0, missing: 0 }, rows: [] };
      if (url.pathname.endsWith('/dispatch')) { dispatches++; return route.fulfill({ status: 503, json: { error: '발송 서버 연결 실패' } }); }
      await route.fulfill({ json: data });
    });
    await page.addInitScript(() => sessionStorage.setItem('cv_safe_token', 'test'));
    await page.goto(`http://127.0.0.1:${server.address().port}/safety.html`);
    await page.waitForFunction(() => typeof S !== 'undefined' && S.hazards?.length);
    await page.evaluate(() => voiceDetail('H1'));
    await page.getByText(/AI 알림 초안을 작성하지 못했습니다/).waitFor();
    await page.locator('#vtext').fill('담당자가 수정한 문구');
    await page.locator('#voice-dispatch-button').click();
    await page.getByText('발송 서버 연결 실패', { exact: true }).waitFor();
    assert.equal(await page.locator('#vtext').inputValue(), '담당자가 수정한 문구');
    assert.equal(await page.locator('#voice-dispatch-button').isDisabled(), false);
    assert.equal(dispatches, 1); assert.equal(hazard.status, 'pending'); assert.equal(hazard.transcript, '원본 신고 내용');
    assert.deepEqual(errors, []);
    console.log('PASS: risk search/review errors preserve fields and prevent saves; control-room AI failure warning and failed dispatch preserve input and original report');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
