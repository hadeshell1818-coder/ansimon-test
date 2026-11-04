const assert = require('node:assert/strict');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// The library list counts sections and cases per document from the document_id column in pages (the embedded
// (count) subquery passed Supabase's statement timeout once rows carried vectors). A counting failure leaves the
// counts unknown but keeps the library connected.
async function main() {
  const sections = Array.from({ length: 2300 }, (_, i) => ({ id: i, document_id: i < 2000 ? 'law' : 'guide' }));
  const cases = Array.from({ length: 1200 }, (_, i) => ({ id: i, document_id: 'sif' }));
  let failSections = false;
  const seen = [];
  const fetchImpl = async target => {
    const url = new URL(String(target)), table = url.pathname.split('/').pop(), q = url.searchParams;
    seen.push(decodeURIComponent(url.pathname + url.search));
    const reply = (body, range) => ({ ok: true, status: 200, headers: { get: name => name.toLowerCase() === 'content-range' ? range : null }, json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } });
    if (table === 'safety_documents') return reply([{ id: 'law', title: '법' }, { id: 'guide', title: '지침' }, { id: 'sif', title: '사례' }], '0-2/3');
    const rows = table === 'safety_document_sections' ? sections : cases;
    if (table === 'safety_document_sections' && failSections) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => '{"code":"57014"}', clone() { return this; } };
    if (!q.get('offset')) return reply([], `0-0/${rows.length}`);
    const offset = Number(q.get('offset')), limit = Number(q.get('limit'));
    return reply(rows.slice(offset, offset + limit).map(row => ({ document_id: row.document_id })), `${offset}-${offset + limit - 1}/${rows.length}`);
  };
  const env = { SAFETY_SUPABASE_URL: 'https://t.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'k' };
  const result = await createKnowledgeRepository(env, fetchImpl).list();
  assert.equal(result.connected, true);
  const byId = Object.fromEntries(result.documents.map(doc => [doc.id, [doc.section_count, doc.case_count]]));
  assert.deepEqual(byId, { law: [2000, 0], guide: [300, 0], sif: [0, 1200] });
  assert.ok(!seen.some(path => path.includes('(count)')), 'no per-document count subquery');
  assert.equal(seen.filter(path => path.includes('safety_document_sections?select=document_id')).length, 3, '1000-row pages');

  failSections = true;
  const degraded = await createKnowledgeRepository(env, fetchImpl).list();
  assert.equal(degraded.connected, true, 'a counting timeout does not mark the library disconnected');
  assert.deepEqual(degraded.documents.map(doc => doc.section_count), [null, null, null]);
  console.log('PASS: library counts from document_id pages, no count subquery, counting failure keeps the library connected');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
