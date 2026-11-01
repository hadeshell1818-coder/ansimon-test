#!/usr/bin/env node
// Reorder saved candidate pools with the Cohere Rerank API for scripts/rerank-eval.cjs (same passages as rerank_onnx.py).
// Usage (behind a proxy add NODE_USE_ENV_PROXY=1; the API key comes from COHERE_API_KEY or a proxy-injected header):
//   node scripts/rerank-cohere.cjs POOLS.jsonl OUT.jsonl [--model rerank-v3.5] [--gap-ms 3200]
// The trial key allows about 20 rerank calls a minute, so calls are spaced (--gap-ms). Interrupted runs resume.
const fs = require('node:fs');
const [poolFile, outFile] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const option = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const model = option('model', 'rerank-v3.5'), gap = Number(option('gap-ms', 3200));
const done = new Set(fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).caseId) : []);
const pools = fs.readFileSync(poolFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(pool => !done.has(pool.caseId));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const started = Date.now();
  let units = 0;
  for (const [index, pool] of pools.entries()) {
    const documents = pool.items.map(item => `${item.title || ''} ${item.locator || ''}\n${String(item.body || '').slice(0, 800)}`);
    let result;
    for (let attempt = 1; attempt <= 4 && !result; attempt++) {
      const response = await fetch('https://api.cohere.com/v2/rerank', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(process.env.COHERE_API_KEY ? { Authorization: `Bearer ${process.env.COHERE_API_KEY}` } : {}) },
        body: JSON.stringify({ model, query: pool.text, documents, top_n: documents.length }) }).catch(error => ({ ok: false, status: 0, text: async () => error.message }));
      if (response.ok) result = await response.json();
      else { const detail = await response.text(); console.log(`${pool.caseId} 재시도 ${attempt} (${response.status}) ${detail.slice(0, 120)}`); await sleep(response.status === 429 ? 15000 : 3000); }
    }
    if (!result) { console.log(`${pool.caseId} 실패`); continue; }
    units += result.meta?.billed_units?.search_units || 0;
    const order = result.results.map(row => pool.items[row.index].ref);
    fs.appendFileSync(outFile, `${JSON.stringify({ caseId: pool.caseId, order, ms: Date.now() - started })}\n`);
    if ((index + 1) % 20 === 0) console.log(`${index + 1}/${pools.length} · ${Math.round((Date.now() - started) / 1000)}s`);
    await sleep(gap);
  }
  console.log(`끝 ${pools.length}건 · 검색 단위 ${units} · ${Math.round((Date.now() - started) / 1000)}s`);
})().catch(error => { console.error(error); process.exitCode = 1; });
