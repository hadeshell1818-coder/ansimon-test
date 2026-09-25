const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSifWorkbook, SIF_SOURCE_URL, SIF_TITLE, SIF_PUBLISHER } = require('../sif-import.cjs');
const input = process.argv[2];
if (!input) throw new Error('Pass the explicitly approved SIF workbook path.');
const bytes = fs.readFileSync(input);
const parsed = parseSifWorkbook(bytes, path.basename(input));
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
const out = path.resolve(__dirname, '../local-import');
fs.mkdirSync(out, { recursive: true });
const sql = [
  fs.readFileSync(path.resolve(__dirname, '../supabase/002_safety_sif_import.sql'), 'utf8'),
  'begin;',
  `insert into public.safety_documents(title, source_url, publisher, category, kind, review_status, created_by)
values (${quote(SIF_TITLE)}, ${quote(SIF_SOURCE_URL)}, ${quote(SIF_PUBLISHER)}, 'general', 'incident', 'pending', 'user-approved-sif')
on conflict (source_url) do nothing;`,
];
for (const row of parsed.rows) {
  const record = { ...row, source_url: SIF_SOURCE_URL, imported_by: 'user-approved-sif' };
  const columns = Object.keys(record);
  const values = columns.map(key => key === 'raw_row' ? quote(JSON.stringify(record[key])) + '::jsonb' : quote(record[key]));
  sql.push(`insert into public.safety_import_rows(document_id,${columns.join(',')}) select id,${values.join(',')} from public.safety_documents where source_url=${quote(SIF_SOURCE_URL)} on conflict (source_url,source_sheet,source_row) do nothing;`);
}
sql.push('commit;', fs.readFileSync(path.resolve(__dirname, '../supabase/003_safety_retrieval.sql'), 'utf8'));
fs.writeFileSync(path.join(out, 'approved-sif.sql'), sql.join('\n'), 'utf8');
const summary = { file: path.basename(input), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), total: parsed.rows.length,
  domains: {}, labels: {}, remoteUpload: false };
for (const row of parsed.rows) {
  summary.domains[row.domain] = (summary.domains[row.domain] || 0) + 1;
  const tags = row.raw_row._search;
  for (const tag of [...tags.equipment, ...tags.work, ...tags.hazard]) summary.labels[tag] = (summary.labels[tag] || 0) + 1;
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
