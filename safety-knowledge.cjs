const seeds = require('./seed-assets/safety-sources.json');
const { parseSifWorkbook, SIF_SOURCE_URL, SIF_TITLE, SIF_PUBLISHER } = require('./sif-import.cjs');

function createKnowledgeRepository(env = process.env, request = fetch) {
  const url = env.SAFETY_SUPABASE_URL;
  const key = env.SAFETY_SUPABASE_SERVICE_KEY;
  const configured = Boolean(url && key);
  async function callResource(resource, query, options = {}) {
    if (!configured) throw new Error('Supabase 연결 설정이 필요합니다.');
    const base = new URL(url);
    if (base.protocol !== 'https:') throw new Error('HTTPS 프로젝트 URL이 필요합니다.');
    const response = await request(new URL(`/rest/v1/${resource}${query}`, base), {
      ...options,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`자료실 연결 실패 (${response.status}). 프로젝트 설정과 SQL 적용 여부를 확인하세요.`);
    return response.status === 204 ? null : response.json();
  }
  async function call(query, options = {}) { return callResource('safety_documents', query, options); }
  function eq(value) { return encodeURIComponent(String(value)); }
  async function ensureSifDocument(actor, fileName) {
    const existing = await call(`?select=id&source_url=eq.${eq(SIF_SOURCE_URL)}&limit=1`);
    if (existing[0]?.id) return existing[0].id;
    const added = await call('?on_conflict=source_url', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify([{
        title: SIF_TITLE,
        source_url: SIF_SOURCE_URL,
        publisher: SIF_PUBLISHER,
        category: 'general',
        kind: 'incident',
        tags: ['SIF', '산업재해', '제조업', '건설업', '검토대기'],
        jurisdiction: '대한민국',
        rights_note: '공공데이터 이용조건과 출처표시·변경금지 조건을 확인한 뒤 사용',
        review_status: 'pending',
        content_use_allowed: false,
        source_version: fileName || null,
        checked_at: new Date().toISOString(),
        created_by: actor,
      }]),
    });
    if (added?.[0]?.id) return added[0].id;
    const retry = await call(`?select=id&source_url=eq.${eq(SIF_SOURCE_URL)}&limit=1`);
    if (!retry[0]?.id) throw new Error('SIF 출처 레코드를 만들지 못했습니다.');
    return retry[0].id;
  }
  return {
    configured,
    async list() {
      if (!configured) return { connected: false, documents: [], candidates: seeds, message: 'Supabase 미연결 · 출처 후보만 준비됨' };
      const documents = await call('?select=id,title,source_url,publisher,category,kind,tags,jurisdiction,rights_note,review_status,created_at&order=created_at.desc&limit=500');
      return { connected: true, documents, candidates: seeds, message: `Supabase 연결됨 · 등록 자료 ${documents.length}건 (최대 500건 표시)` };
    },
    async search(query) {
      const q = String(query || '').trim().replace(/[(),.*]/g, ' ').slice(0, 80);
      if (!configured) return { connected: false, results: [], message: 'Supabase 미연결 · 관련 근거를 검색할 수 없습니다.' };
      if (!q) return { connected: true, results: [], message: '검색어를 입력하세요.' };
      const documents = await call(`?select=id,title,source_url,publisher,category,kind,tags,jurisdiction,rights_note,review_status&or=(title.ilike.*${encodeURIComponent(q)}*,publisher.ilike.*${encodeURIComponent(q)}*)&limit=30`);
      const sections = await call(`?select=id,document_id,version,locator,body&body=ilike.*${encodeURIComponent(q)}*&limit=50`);
      const cases = await callResource('safety_import_rows', `?select=id,document_id,source_sheet,source_row,domain,industry_large,industry_medium,industry_small,work_category,work_name,unit_work,incident_type,incident_summary,hazard_object,high_risk_situation,causal_factors,reduction_measures,review_status&or=(incident_summary.ilike.*${encodeURIComponent(q)}*,hazard_object.ilike.*${encodeURIComponent(q)}*,high_risk_situation.ilike.*${encodeURIComponent(q)}*,causal_factors.ilike.*${encodeURIComponent(q)}*,reduction_measures.ilike.*${encodeURIComponent(q)}*,industry_large.ilike.*${encodeURIComponent(q)}*,industry_medium.ilike.*${encodeURIComponent(q)}*,industry_small.ilike.*${encodeURIComponent(q)}*)&limit=40`);
      const byId = new Map(documents.map(item => [item.id, item]));
      sections.forEach(section => { if (!byId.has(section.document_id)) byId.set(section.document_id, { id: section.document_id, title: '본문 근거', review_status: 'pending' }); });
      return { connected: true, results: [...byId.values()].map(doc => ({ ...doc, sections: sections.filter(section => section.document_id === doc.id) })), cases };
    },
    async seed(actor) {
      // Seed metadata only; never overwrite a reviewed record or upload source content.
      return call('?on_conflict=source_url', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(seeds.map(item => ({ ...item, created_by: actor, review_status: 'pending' }))) });
    },
    async add(body, actor) {
      const title = String(body.title || '').trim();
      const publisher = String(body.publisher || '').trim();
      const source = new URL(body.source_url);
      if (source.protocol !== 'https:' || source.username || source.password) throw new Error('공개 HTTPS 원문 주소가 필요합니다.');
      if (!title || title.length > 200 || !publisher || publisher.length > 120 || source.href.length > 2000) throw new Error('제목·제공기관·주소를 확인하세요.');
      const categories = ['inspections','weather','musculoskeletal','stress','chemicals','training','contractors','general'];
      const kinds = ['law','guideline','incident','checklist','manual'];
      if (!categories.includes(body.category) || !kinds.includes(body.kind)) throw new Error('분류를 확인하세요.');
      return call('', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
        title, publisher, source_url: source.href, category: body.category, kind: body.kind,
        jurisdiction: '미확인', tags: [], rights_note: '이용조건 확인 필요', review_status: 'pending', created_by: actor,
      }) });
    },
    async importSif(fileBase64, fileName, actor) {
      if (!configured) throw new Error('Supabase 미연결: 저장하지 않았습니다.');
      if (!fileBase64 || typeof fileBase64 !== 'string') throw new Error('엑셀 파일이 필요합니다.');
      if (fileBase64.length > 8 * 1024 * 1024) throw new Error('엑셀 파일이 너무 큽니다. 6MB 이하 파일을 사용하세요.');
      const cleanName = String(fileName || 'SIF-archive.xlsx').replace(/[\\/\r\n]/g, '_').slice(0, 180);
      const parsed = parseSifWorkbook(Buffer.from(fileBase64, 'base64'), cleanName);
      const documentId = await ensureSifDocument(actor, cleanName);
      const rows = parsed.rows.map(row => ({ ...row, document_id: documentId, source_url: SIF_SOURCE_URL, imported_by: actor, review_status: 'pending' }));
      const chunkSize = 200;
      for (let index = 0; index < rows.length; index += chunkSize) {
        await callResource('safety_import_rows', '?on_conflict=source_url,source_sheet,source_row', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows.slice(index, index + chunkSize)),
        });
      }
      return { document_id: documentId, imported: rows.length, sheets: parsed.sheets, source_url: SIF_SOURCE_URL };
    },
  };
}

function mountKnowledge(app, authorize, env) {
  const repository = createKnowledgeRepository(env);
  app.use('/api/safety-knowledge', (req, res, next) => {
    const user = authorize(req);
    if (!user) return res.status(403).json({ error: '안전관리담당자 권한이 필요합니다.' });
    req.knowledgeUser = user;
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/safety-knowledge', async (req, res) => {
    try { res.json(await repository.list()); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/safety-knowledge/search', async (req, res) => {
    try { res.json(await repository.search(req.query.q)); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.post('/api/safety-knowledge/seed', async (req, res) => {
    try { res.json({ added: await repository.seed(req.knowledgeUser.id) }); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.post('/api/safety-knowledge', async (req, res) => {
    if (!repository.configured) return res.status(503).json({ error: 'Supabase 미연결: 저장하지 않았습니다.' });
    try { res.status(201).json({ added: await repository.add(req.body || {}, req.knowledgeUser.id) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/api/safety-knowledge/import-sif', async (req, res) => {
    if (!repository.configured) return res.status(503).json({ error: 'Supabase 미연결: 저장하지 않았습니다.' });
    try {
      const result = await repository.importSif(req.body?.fileBase64, req.body?.fileName, req.knowledgeUser.id);
      res.status(201).json(result);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
}
module.exports = { createKnowledgeRepository, mountKnowledge };
