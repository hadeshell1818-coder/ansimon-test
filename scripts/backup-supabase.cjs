#!/usr/bin/env node
// Backup of the Supabase safety knowledge store (근거 자료) and conversion of a backup into restore SQL.
//
//   node scripts/backup-supabase.cjs [--out DIR] [--with-embeddings]
//       Exports every table to DIR/<table>.json (default local-import/backup/supabase-YYYY-MM-DD), writes
//       manifest.json (row counts, checksums), copies supabase/*.sql and loaded-sources.json, writes restore SQL
//       (restore-sql/) and zips the folder.
//       Embedding vectors are left out by default (about 100 MB as text; rebuilt with the app's
//       「의미 검색 색인 만들기」 button after a restore).
//   node scripts/backup-supabase.cjs --to-sql DIR
//       Writes DIR/restore-sql/NN-<table>.sql (each under 300 KB for the Supabase SQL Editor). Run them in order on
//       a database where supabase/001~008 have been applied. Existing rows (same id) are kept, never overwritten.
//
// Needs SAFETY_SUPABASE_URL and SAFETY_SUPABASE_SERVICE_KEY (behind an HTTPS proxy add NODE_USE_ENV_PROXY=1).
// The backup holds internal post-office material: keep it out of the public Git repository.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Restore order follows the foreign keys. safety_case_chunks is a view (003) and is not backed up.
const TABLES = ['safety_documents', 'safety_document_sections', 'safety_import_rows', 'safety_assessment_evidence'];
const VECTOR_COLUMNS = ['embedding', 'embedding_model'];
const PAGE = 1000;
const SQL_LIMIT = 280 * 1024;
const TAG = '$ansimon_json$';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

async function backup() {
  const base = process.env.SAFETY_SUPABASE_URL, key = process.env.SAFETY_SUPABASE_SERVICE_KEY;
  if (!base || !key) throw new Error('SAFETY_SUPABASE_URL과 SAFETY_SUPABASE_SERVICE_KEY가 필요합니다.');
  const withVectors = args.includes('--with-embeddings');
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const out = path.resolve(option('--out') || path.join(__dirname, '..', 'local-import', 'backup', `supabase-${day}`));
  fs.mkdirSync(out, { recursive: true });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (url, extra = {}) => {
    const response = await fetch(url, { headers: { ...headers, ...extra }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  const manifest = { createdAt: new Date().toISOString(), supabaseHost: new URL(base).host, embeddingsIncluded: withVectors, tables: {} };
  for (const table of TABLES) {
    const sample = await (await get(`${base}/rest/v1/${table}?select=*&limit=1`)).json();
    const columns = sample[0] ? Object.keys(sample[0]).filter(column => withVectors || !VECTOR_COLUMNS.includes(column)) : null;
    const select = columns ? columns.map(encodeURIComponent).join(',') : '*';
    const rows = [];
    let expected = null;
    for (let from = 0; ; from += PAGE) {
      const response = await get(`${base}/rest/v1/${table}?select=${select}&order=id.asc`, { 'Range-Unit': 'items', Range: `${from}-${from + PAGE - 1}`, Prefer: 'count=exact' });
      expected = Number(String(response.headers.get('content-range') || '').split('/')[1]);
      const page = await response.json();
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    if (Number.isFinite(expected) && expected !== rows.length) throw new Error(`${table}: ${expected}행 중 ${rows.length}행만 받았습니다.`);
    const text = JSON.stringify(rows);
    fs.writeFileSync(path.join(out, `${table}.json`), text);
    manifest.tables[table] = { rows: rows.length, columns: columns || [], excludedColumns: withVectors ? [] : VECTOR_COLUMNS, sha256: sha256(text), bytes: Buffer.byteLength(text) };
    console.log(`${table}: ${rows.length}행 (${(Buffer.byteLength(text) / 1048576).toFixed(1)} MB)`);
  }
  fs.mkdirSync(path.join(out, 'schema'), { recursive: true });
  const supabaseDir = path.join(__dirname, '..', 'supabase');
  for (const file of fs.readdirSync(supabaseDir)) fs.copyFileSync(path.join(supabaseDir, file), path.join(out, 'schema', file));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(out, 'README.md'), readme(manifest));
  toSql(out);
  try {
    execFileSync('zip', ['-qr', `${path.basename(out)}.zip`, path.basename(out)], { cwd: path.dirname(out) });
    console.log(`압축: ${out}.zip`);
  } catch (_) { console.log('zip이 없어 폴더로만 남겼습니다.'); }
  console.log(`백업 폴더: ${out}`);
}

function readme(manifest) {
  const rows = Object.entries(manifest.tables).map(([table, info]) => `| ${table} | ${info.rows} |`).join('\n');
  return `# 안심ON 근거 자료(Supabase) 백업

만든 시각: ${manifest.createdAt} · 원본 프로젝트: ${manifest.supabaseHost} · 의미 색인(벡터) 포함: ${manifest.embeddingsIncluded ? '예' : '아니오'}

| 표 | 행 수 |
|---|---|
${rows}

- 내용: 법령·행정규칙·KOSHA 지침·우체국 점검표·사고사례 원문과 메타데이터(\`<표>.json\`), DB 구조 SQL(\`schema/\`), 적재 목록(\`schema/loaded-sources.json\`).
- 우체국 내부 자료가 들어 있으니 공개 저장소(GitHub)에 올리지 말고 기관 승인 장소에 보관하세요.

## 복원 방법

1. 새 Supabase 프로젝트(또는 PostgreSQL+pgvector)의 SQL Editor에서 \`schema/001\`~\`008\` SQL을 번호 순서대로 실행합니다.
2. \`restore-sql/\`의 SQL 파일(각 300KB 이하)을 번호 순서대로 SQL Editor에서 실행합니다(같은 id가 이미 있으면 건너뜀). 파일이 없으면 \`node scripts/backup-supabase.cjs --to-sql <이 폴더>\`로 다시 만듭니다.
3. 앱 서버 환경변수를 새 프로젝트 주소·키로 바꾸고, 위험성평가 → 근거자료실 → 「의미 검색 색인 만들기」를 눌러 의미 색인을 다시 만듭니다.
4. \`manifest.json\`의 행 수와 복원된 행 수를 비교해 확인합니다.
`;
}

function toSql(target) {
  const dir = path.resolve(target);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const outDir = path.join(dir, 'restore-sql');
  fs.mkdirSync(outDir, { recursive: true });
  let fileNo = 0;
  for (const table of TABLES) {
    const info = manifest.tables[table];
    if (!info || !info.rows) continue;
    const text = fs.readFileSync(path.join(dir, `${table}.json`), 'utf8');
    if (sha256(text) !== info.sha256) throw new Error(`${table}.json 체크섬이 manifest와 다릅니다(파일 손상).`);
    if (text.includes(TAG)) throw new Error(`${table}에 구분 문자열 ${TAG}가 있어 SQL로 바꿀 수 없습니다.`);
    const rows = JSON.parse(text);
    const columns = info.columns.map(column => `"${column.replace(/"/g, '""')}"`).join(', ');
    const statement = chunk => `insert into public.${table} (${columns})\nselect ${columns} from jsonb_populate_recordset(null::public.${table}, ${TAG}${JSON.stringify(chunk)}${TAG}::jsonb)\non conflict (id) do nothing;\n`;
    let chunk = [], size = 0, part = 0;
    const flush = () => {
      if (!chunk.length) return;
      fileNo += 1; part += 1;
      const name = `${String(fileNo).padStart(2, '0')}-${table}-${part}.sql`;
      fs.writeFileSync(path.join(outDir, name), `-- ${table} ${part}부 (${chunk.length}행)\n${statement(chunk)}`);
      chunk = []; size = 0;
    };
    for (const row of rows) {
      const length = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (size + length > SQL_LIMIT) flush();
      chunk.push(row); size += length;
    }
    flush();
    console.log(`${table}: ${rows.length}행 → ${part}개 파일`);
  }
  console.log(`복원 SQL: ${outDir} (${fileNo}개, 번호 순서대로 실행)`);
}

(async () => {
  if (args.includes('--to-sql')) toSql(option('--to-sql')); else await backup();
})().catch(error => { console.error('실패:', error.message); process.exitCode = 1; });
