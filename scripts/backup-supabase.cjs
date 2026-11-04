#!/usr/bin/env node
// Backup of the Supabase safety knowledge store (근거 자료) and conversion of a backup into restore SQL.
// The export logic is shared with the evidence library's 「근거 자료 백업 내려받기」 button (../supabase-backup.cjs).
//
//   node scripts/backup-supabase.cjs [--out DIR] [--with-embeddings]
//       Exports every table to DIR/<table>.json (default local-import/backup/supabase-YYYY-MM-DD), writes
//       manifest.json (row counts, checksums), copies supabase/*.sql and loaded-sources.json, writes restore SQL
//       (restore-sql/) and zips the folder. Embedding vectors are left out by default (about 100 MB as text; rebuilt
//       with the app's 「의미 검색 색인 만들기」 button after a restore).
//   node scripts/backup-supabase.cjs --from-archive FILE.json.gz [--out DIR]
//       Unpacks a file downloaded with the button into the same folder layout (tables, manifest, schema, restore SQL).
//   node scripts/backup-supabase.cjs --to-sql DIR
//       Writes DIR/restore-sql/NN-<table>.sql again from a backup folder.
//
// Needs SAFETY_SUPABASE_URL and SAFETY_SUPABASE_SERVICE_KEY for a backup (behind an HTTPS proxy add NODE_USE_ENV_PROXY=1).
// The backup holds internal post-office material: keep it out of the public Git repository.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { TABLES, sha256, exportTables, restoreSql, unpackArchive } = require('../supabase-backup.cjs');

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

function writeFolder(out, manifest, tables) {
  fs.mkdirSync(out, { recursive: true });
  for (const table of TABLES) if (tables[table]) fs.writeFileSync(path.join(out, `${table}.json`), JSON.stringify(tables[table]));
  fs.mkdirSync(path.join(out, 'schema'), { recursive: true });
  const supabaseDir = path.join(__dirname, '..', 'supabase');
  for (const file of fs.readdirSync(supabaseDir)) {
    const from = path.join(supabaseDir, file);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(out, 'schema', file));
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(out, 'README.md'), readme(manifest));
  writeSql(out, manifest, tables);
  try {
    execFileSync('zip', ['-qr', `${path.basename(out)}.zip`, path.basename(out)], { cwd: path.dirname(out) });
    console.log(`압축: ${out}.zip`);
  } catch (_) { console.log('zip이 없어 폴더로만 남겼습니다.'); }
  console.log(`백업 폴더: ${out}`);
}

function writeSql(dir, manifest, tables) {
  const outDir = path.join(dir, 'restore-sql');
  fs.mkdirSync(outDir, { recursive: true });
  const files = restoreSql(manifest, tables);
  for (const file of files) fs.writeFileSync(path.join(outDir, file.name), file.sql);
  console.log(`복원 SQL: ${outDir} (${files.length}개, 번호 순서대로 실행)`);
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

function loadFolder(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tables = {};
  for (const table of TABLES) {
    const file = path.join(dir, `${table}.json`);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (manifest.tables[table] && sha256(text) !== manifest.tables[table].sha256) throw new Error(`${table}.json 체크섬이 manifest와 다릅니다(파일 손상).`);
    tables[table] = JSON.parse(text);
  }
  return { manifest, tables };
}

(async () => {
  if (args.includes('--to-sql')) {
    const dir = path.resolve(option('--to-sql'));
    const { manifest, tables } = loadFolder(dir);
    writeSql(dir, manifest, tables);
    return;
  }
  if (args.includes('--from-archive')) {
    const file = path.resolve(option('--from-archive'));
    const { manifest, tables } = unpackArchive(fs.readFileSync(file));
    const out = path.resolve(option('--out') || file.replace(/\.json\.gz$/i, '').replace(/\.gz$/i, ''));
    writeFolder(out, manifest, tables);
    return;
  }
  const { manifest, tables } = await exportTables({
    url: process.env.SAFETY_SUPABASE_URL, key: process.env.SAFETY_SUPABASE_SERVICE_KEY, withVectors: args.includes('--with-embeddings'),
    onTable: (table, rows, bytes) => console.log(`${table}: ${rows}행 (${(bytes / 1048576).toFixed(1)} MB)`),
  });
  const out = path.resolve(option('--out') || path.join(__dirname, '..', 'local-import', 'backup', `supabase-${today()}`));
  writeFolder(out, manifest, tables);
})().catch(error => { console.error('실패:', error.message); process.exitCode = 1; });
