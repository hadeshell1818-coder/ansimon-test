const assert = require('node:assert/strict');
const express = require('express');
const { createKnowledgeRepository, mountKnowledge } = require('../safety-knowledge.cjs');
async function main() {
  const offline = createKnowledgeRepository({});
  const state = await offline.list();
  assert.equal(state.connected, false);
  assert.equal(state.documents.length, 0);
  assert.equal(state.candidates.length, 7);
  await assert.rejects(offline.seed('manager'));
  const calls = [];
  const configured = { SAFETY_SUPABASE_URL: 'https://example.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'test-server-secret' };
  const repository = createKnowledgeRepository(configured, async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => [] };
  });
  assert.equal((await repository.list()).connected, true);
  await repository.seed('manager');
  const seed = calls[1];
  assert.match(seed.options.headers.Prefer, /ignore-duplicates/);
  const records = JSON.parse(seed.options.body);
  assert(records.every(row => row.review_status === 'pending' && !row.body && !row.content_use_allowed));
  assert.equal(new Set(records.map(row => row.source_url)).size, 7);
  await assert.rejects(repository.add({ title: 'test', publisher: 'test', source_url: 'javascript:alert(1)' }, 'manager'));
  await assert.rejects(repository.add({ title: 'test', publisher: 'test', source_url: 'https://user:pw@example.com' }, 'manager'));
  await assert.rejects(repository.uploadDocument({ fileName: 'unsafe.docx' }, 'manager'), /PDF, HWP, HWPX/);
  await repository.add({ title: 'test', publisher: 'test', source_url: 'https://example.com', category: 'general', kind: 'law', review_status: 'approved', body: 'ignore' }, 'manager');
  const saved = JSON.parse(calls.at(-1).options.body);
  assert.equal(saved.review_status, 'pending');
  assert.equal(saved.body, undefined);
  const uploadCalls = [];
  const uploadRepo = createKnowledgeRepository(configured, async (url, options) => {
    uploadCalls.push({ url: String(url), options });
    return { ok: true, status: 201, json: async () => [{ id: 'uploaded-doc' }] };
  });
  const upload = await uploadRepo.uploadDocument({ fileName: 'guide.pdf', fileBase64: Buffer.from('%PDF test').toString('base64'), title: '점검 지침', publisher: '우체국', category: 'inspections', kind: 'guideline', bodyText: '계단 파손과 미끄러짐 예방' }, 'manager');
  assert.equal(upload.document.id, 'uploaded-doc');
  assert(uploadCalls[0].url.includes('/storage/v1/object/safety-documents/'));
  const uploadedRecord = JSON.parse(uploadCalls[1].options.body);
  assert.equal(uploadedRecord.source_url, null);
  assert.equal(uploadedRecord.body_text, '계단 파손과 미끄러짐 예방');
  assert.equal(uploadedRecord.review_status, 'pending');
  const searchRepo = createKnowledgeRepository(configured, async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/safety_documents')) return { ok: true, status: 200, json: async () => [{ id: 'doc-1', title: '점검 지침', publisher: '우체국', review_status: 'pending', body_text: '계단 파손은 미끄러짐과 넘어짐 사고를 유발할 수 있다.' }] };
    return { ok: true, status: 200, json: async () => [] };
  });
  const bodySearch = await searchRepo.search('계단 파손');
  assert.match(bodySearch.results[0].sections[0].body, /계단 파손은 미끄러짐/);
  const failed = createKnowledgeRepository(configured, async () => ({ ok: false, status: 401 }));
  await assert.rejects(failed.list(), /401/);
  const app = express(); app.use(express.json());
  mountKnowledge(app, req => req.headers.authorization === 'manager' ? { id: 'manager' } : null, {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/safety-knowledge`;
  try {
    for (const [method, suffix] of [['GET',''],['POST',''],['POST','/seed']]) {
      assert.equal((await fetch(base + suffix, { method })).status, 403);
    }
    const response = await fetch(base, { headers: { Authorization: 'manager' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).connected, false);
    assert.equal((await fetch(base, { method: 'POST', headers: { Authorization: 'manager' } })).status, 503);
    assert.equal((await fetch(base + '/seed', { method: 'POST', headers: { Authorization: 'manager' } })).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('PASS: authorization, offline state, no false persistence, metadata validation, pending-only ingestion, idempotent seeds, upstream failures');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
