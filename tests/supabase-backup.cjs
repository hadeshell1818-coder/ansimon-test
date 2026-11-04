const assert = require('node:assert/strict');
const { exportTables, restoreSql, packArchive, unpackArchive, TABLES } = require('../supabase-backup.cjs');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');

// Evidence backup: every row is fetched page by page, embedding vectors are left out, restore SQL stays under the
// SQL Editor size and in foreign-key order, and a damaged download is refused. The keep-alive reads one row.
async function main() {
  const big = 'x'.repeat(400);
  const data = {
    safety_documents: [{ id: 'd1', title: '법령', embedding: null }],
    safety_document_sections: Array.from({ length: 2500 }, (_, i) => ({ id: `s${String(i).padStart(5, '0')}`, document_id: 'd1', body: `${big}${i}`, embedding: '[0.1]', embedding_model: 'm' })),
    safety_import_rows: [{ id: 'c1', document_id: 'd1', incident_summary: '추락' }],
    safety_assessment_evidence: [],
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const href = new URL(url), table = href.pathname.split('/').pop(), select = href.searchParams.get('select');
    requests.push({ table, select, range: options.headers.Range });
    const rows = data[table].map(row => select === '*' ? row : Object.fromEntries(select.split(',').map(column => [column, row[column]])));
    const [from, to] = (options.headers.Range || '0-0').split('-').map(Number);
    const page = href.searchParams.get('limit') === '1' ? rows.slice(0, 1) : rows.slice(from, to + 1);
    return { ok: true, status: 200, headers: { get: () => `${from}-${to}/${rows.length}` }, json: async () => page, text: async () => JSON.stringify(page) };
  };
  const backup = await exportTables({ url: 'https://t.supabase.co', key: 'k', fetchImpl });
  assert.equal(backup.tables.safety_document_sections.length, 2500, 'all pages fetched');
  assert.equal(requests.filter(r => r.table === 'safety_document_sections' && r.range).length, 3, '1000-row pages');
  assert.ok(!('embedding' in backup.tables.safety_document_sections[0]) && !('embedding_model' in backup.tables.safety_document_sections[0]), 'vectors left out');
  assert.equal(backup.manifest.tables.safety_assessment_evidence.rows, 0);

  const files = restoreSql(backup.manifest, backup.tables);
  assert.ok(files.length > 3 && files.every(file => Buffer.byteLength(file.sql) < 300 * 1024), 'files fit the SQL Editor');
  const order = files.map(file => TABLES.findIndex(table => file.name.includes(table)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'documents before sections before cases');
  assert.ok(files.every(file => /on conflict \(id\) do nothing/.test(file.sql)), 'existing rows are kept');

  const archive = packArchive(backup);
  assert.equal(unpackArchive(archive).tables.safety_document_sections.length, 2500, 'download round trip');
  const damaged = JSON.parse(require('zlib').gunzipSync(archive));
  damaged.tables.safety_documents[0].title = '변조';
  assert.throws(() => unpackArchive(require('zlib').gzipSync(JSON.stringify(damaged))), /체크섬/);

  const pings = [];
  const repo = createKnowledgeRepository({ SAFETY_SUPABASE_URL: 'https://t.supabase.co', SAFETY_SUPABASE_SERVICE_KEY: 'k' },
    async url => { pings.push(String(url)); return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ id: 'd1' }], text: async () => '[]' }; });
  const status = await repo.keepAlive();
  assert.equal(status.ok, true);
  assert.ok(pings.some(url => decodeURIComponent(url).includes('/safety_documents?select=id&limit=1')), 'keep-alive reads one row');
  assert.equal(repo.keepAliveStatus().ok, true);
  console.log('PASS: evidence backup pages, vectors excluded, restore SQL size and order, damaged file refused, keep-alive');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
