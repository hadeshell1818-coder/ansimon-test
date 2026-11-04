#!/usr/bin/env node
// Loads documents made by prepare-kosha-guides.cjs / prepare-official-laws-from-web.cjs (OUT_JSON=...) into Supabase
// through the REST API with the server key, doing what their SQL does without the SQL Editor:
//   1. upsert the document by source_url (approved, content use allowed)
//   2. upsert its sections by (document_id, version, locator)
//   3. delete sections of older versions unless an assessment cites them
// Usage (behind a proxy add NODE_USE_ENV_PROXY=1):
//   SAFETY_SUPABASE_URL=... SAFETY_SUPABASE_SERVICE_KEY=... node scripts/load-knowledge-rows.cjs rows.json [rows2.json ...]
// Afterwards run the evidence library's 「의미 검색 색인 만들기」 so the new sections are found by meaning too,
// and add the versions to supabase/loaded-sources.json.
const fs = require('fs');

const base = process.env.SAFETY_SUPABASE_URL, key = process.env.SAFETY_SUPABASE_SERVICE_KEY;
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function request(path, options = {}) {
  const response = await fetch(`${base}/rest/v1/${path}`, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(60000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function loadDocument({ document, sections }) {
  const [saved] = await request('safety_documents?on_conflict=source_url', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([document]),
  });
  const version = document.source_version;
  for (let index = 0; index < sections.length; index += 50) {
    const rows = sections.slice(index, index + 50).map(section => ({ document_id: saved.id, version, locator: section.locator, body: section.body, content_hash: section.content_hash }));
    await request('safety_document_sections?on_conflict=document_id,version,locator', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows),
    });
  }
  const cited = (await request(`safety_assessment_evidence?select=section_id&document_id=eq.${saved.id}`)).map(row => row.section_id).filter(Boolean);
  const keep = cited.length ? `&id=not.in.(${cited.join(',')})` : '';
  await request(`safety_document_sections?document_id=eq.${saved.id}&version=neq.${encodeURIComponent(version)}${keep}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return { id: saved.id, sections: sections.length };
}

(async () => {
  if (!base || !key) throw new Error('SAFETY_SUPABASE_URL과 SAFETY_SUPABASE_SERVICE_KEY가 필요합니다.');
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('적재할 JSON 파일을 지정하세요.');
  let total = 0;
  for (const file of files) {
    for (const doc of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      try {
        const result = await loadDocument(doc);
        total += 1;
        console.log(`적재: ${doc.document.title} · ${doc.document.source_version} · 항목 ${result.sections}개`);
      } catch (error) { console.error(`실패: ${doc.document.title} · ${error.message}`); process.exitCode = 1; }
    }
  }
  console.log(`자료 ${total}건 적재`);
})().catch(error => { console.error('실패:', error.message); process.exitCode = 1; });
