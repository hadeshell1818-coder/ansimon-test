// Backup of the Supabase safety knowledge store, shared by scripts/backup-supabase.cjs (command line) and the
// evidence library's 「근거 자료 백업 내려받기」 button (server). Embedding vectors are left out by default (about
// 100 MB as text); after a restore the app's 「의미 검색 색인 만들기」 button rebuilds them.
const crypto = require('crypto');
const zlib = require('zlib');

// Restore order follows the foreign keys. safety_case_chunks is a view (003) and is not backed up.
const TABLES = ['safety_documents', 'safety_document_sections', 'safety_import_rows', 'safety_assessment_evidence'];
const VECTOR_COLUMNS = ['embedding', 'embedding_model'];
const PAGE = 1000;
const SQL_LIMIT = 280 * 1024;
const TAG = '$ansimon_json$';
const FORMAT = 'ansimon-supabase-backup';
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

async function exportTables({ url, key, fetchImpl = fetch, withVectors = false, onTable = () => {} }) {
  if (!url || !key) throw new Error('SAFETY_SUPABASE_URL과 SAFETY_SUPABASE_SERVICE_KEY가 필요합니다.');
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (target, extra = {}) => {
    const response = await fetchImpl(target, { headers: { ...headers, ...extra }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Supabase 백업 조회 실패 (${response.status}) ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  const manifest = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), supabaseHost: new URL(url).host, embeddingsIncluded: withVectors, tables: {} };
  const tables = {};
  for (const table of TABLES) {
    const sample = await (await get(`${url}/rest/v1/${table}?select=*&limit=1`)).json();
    const columns = sample[0] ? Object.keys(sample[0]).filter(column => withVectors || !VECTOR_COLUMNS.includes(column)) : [];
    const select = columns.length ? columns.map(encodeURIComponent).join(',') : '*';
    const rows = [];
    let expected = null;
    for (let from = 0; ; from += PAGE) {
      const response = await get(`${url}/rest/v1/${table}?select=${select}&order=id.asc`, { 'Range-Unit': 'items', Range: `${from}-${from + PAGE - 1}`, Prefer: 'count=exact' });
      expected = Number(String(response.headers.get('content-range') || '').split('/')[1]);
      const page = await response.json();
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    if (Number.isFinite(expected) && expected !== rows.length) throw new Error(`${table}: ${expected}행 중 ${rows.length}행만 받았습니다.`);
    const text = JSON.stringify(rows);
    tables[table] = rows;
    manifest.tables[table] = { rows: rows.length, columns, excludedColumns: withVectors ? [] : VECTOR_COLUMNS, sha256: sha256(text), bytes: Buffer.byteLength(text) };
    onTable(table, rows.length, Buffer.byteLength(text));
  }
  return { manifest, tables };
}

// Restore SQL for the Supabase SQL Editor: files under 300 KB, run in order on a database with supabase/001~008.
// Existing rows (same id) are kept, never overwritten.
function restoreSql(manifest, tables) {
  const files = [];
  for (const table of TABLES) {
    const info = manifest.tables[table];
    const rows = tables[table] || [];
    if (!info || !rows.length) continue;
    const text = JSON.stringify(rows);
    if (text.includes(TAG)) throw new Error(`${table}에 구분 문자열 ${TAG}가 있어 SQL로 바꿀 수 없습니다.`);
    const columns = info.columns.map(column => `"${column.replace(/"/g, '""')}"`).join(', ');
    const statement = chunk => `insert into public.${table} (${columns})\nselect ${columns} from jsonb_populate_recordset(null::public.${table}, ${TAG}${JSON.stringify(chunk)}${TAG}::jsonb)\non conflict (id) do nothing;\n`;
    let chunk = [], size = 0, part = 0;
    const flush = () => {
      if (!chunk.length) return;
      part += 1;
      const name = `${String(files.length + 1).padStart(2, '0')}-${table}-${part}.sql`;
      files.push({ name, sql: `-- ${table} ${part}부 (${chunk.length}행)\n${statement(chunk)}` });
      chunk = []; size = 0;
    };
    for (const row of rows) {
      const length = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (size + length > SQL_LIMIT) flush();
      chunk.push(row); size += length;
    }
    flush();
  }
  return files;
}

// One-file archive for the download button: gzip of {manifest, tables}. Checksums are verified when unpacked.
function packArchive({ manifest, tables }) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ manifest, tables })));
}
function unpackArchive(buffer) {
  const data = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'));
  if (data?.manifest?.format !== FORMAT) throw new Error('안심ON 근거 자료 백업 파일이 아닙니다.');
  for (const [table, info] of Object.entries(data.manifest.tables)) {
    if (sha256(JSON.stringify(data.tables[table] || [])) !== info.sha256) throw new Error(`${table} 체크섬이 manifest와 다릅니다(파일 손상).`);
  }
  return data;
}

module.exports = { TABLES, VECTOR_COLUMNS, FORMAT, sha256, exportTables, restoreSql, packArchive, unpackArchive };
