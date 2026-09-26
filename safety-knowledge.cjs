const seeds = require('./seed-assets/safety-sources.json');
const { parseSifWorkbook, SIF_SOURCE_URL, SIF_TITLE, SIF_PUBLISHER } = require('./sif-import.cjs');
const crypto = require('crypto');

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
    return response.status === 204 || options.headers?.Prefer?.includes('return=minimal') ? null : response.json();
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
      const documents = await call('?select=id,title,source_url,publisher,category,kind,tags,jurisdiction,rights_note,review_status,created_at,original_file_name,storage_path,mime_type,file_size,safety_import_rows(count)&order=created_at.desc&limit=500');
      documents.forEach(doc => { doc.case_count = doc.safety_import_rows?.[0]?.count || 0; });
      return { connected: true, documents, candidates: seeds, message: `Supabase 연결됨 · 등록 자료 ${documents.length}건 (최대 500건 표시)` };
    },
    async search(query) {
      const q = String(query || '').trim().replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9\s-]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
      if (!configured) return { connected: false, results: [], message: 'Supabase 미연결 · 관련 근거를 검색할 수 없습니다.' };
      if (!q) return { connected: true, results: [], message: '검색어를 입력하세요.' };
      const documents = await call(`?select=id,title,source_url,publisher,category,kind,tags,jurisdiction,rights_note,review_status,original_file_name,storage_path,body_text&or=(title.ilike.*${encodeURIComponent(q)}*,publisher.ilike.*${encodeURIComponent(q)}*,body_text.ilike.*${encodeURIComponent(q)}*)&limit=30`);
      const sections = await callResource('safety_document_sections', `?select=id,document_id,version,locator,body&body=ilike.*${encodeURIComponent(q)}*&limit=50`);
      const cases = await callResource('safety_import_rows', `?select=id,document_id,source_sheet,source_row,domain,industry_large,industry_medium,industry_small,work_category,work_name,unit_work,incident_type,incident_summary,hazard_object,high_risk_situation,causal_factors,reduction_measures,review_status&or=(incident_summary.ilike.*${encodeURIComponent(q)}*,hazard_object.ilike.*${encodeURIComponent(q)}*,high_risk_situation.ilike.*${encodeURIComponent(q)}*,causal_factors.ilike.*${encodeURIComponent(q)}*,reduction_measures.ilike.*${encodeURIComponent(q)}*,industry_large.ilike.*${encodeURIComponent(q)}*,industry_medium.ilike.*${encodeURIComponent(q)}*,industry_small.ilike.*${encodeURIComponent(q)}*)&limit=40`);
      const byId = new Map(documents.map(item => [item.id, item]));
      sections.forEach(section => { if (!byId.has(section.document_id)) byId.set(section.document_id, { id: section.document_id, title: '본문 근거', review_status: 'pending' }); });
      return { connected: true, results: [...byId.values()].map(doc => {
        const hits = sections.filter(section => section.document_id === doc.id).map(section => ({ ...section, body: section.body.slice(0, 500) }));
        if (doc.body_text && doc.body_text.toLowerCase().includes(q.toLowerCase())) {
          const at = doc.body_text.toLowerCase().indexOf(q.toLowerCase());
          hits.push({ id: `body:${doc.id}`, document_id: doc.id, locator: '본문 일치', body: doc.body_text.slice(Math.max(0, at - 180), at + q.length + 240) });
        }
        const { body_text, ...safeDoc } = doc;
        return { ...safeDoc, sections: hits };
      }), cases };
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
    async uploadDocument(body, actor) {
      if (!configured) throw new Error('Supabase 미연결: 저장하지 않았습니다.');
      const name = String(body.fileName || '').replace(/[\\/\r\n]/g, '_').slice(0, 180);
      const ext = name.split('.').pop().toLowerCase();
      if (!['pdf', 'hwp', 'hwpx'].includes(ext)) throw new Error('PDF, HWP, HWPX 파일만 올릴 수 있습니다.');
      const data = String(body.fileBase64 || '');
      if (!data || data.length > 8 * 1024 * 1024) throw new Error('파일이 없거나 6MB를 초과했습니다.');
      const buffer = Buffer.from(data, 'base64');
      if (!buffer.length || buffer.length > 6 * 1024 * 1024) throw new Error('파일은 6MB 이하여야 합니다.');
      const mime = ext === 'pdf' ? 'application/pdf' : ext === 'hwpx' ? 'application/vnd.hancom.hwpx' : 'application/x-hwp';
      const title = String(body.title || name).trim().slice(0, 200);
      const publisher = String(body.publisher || '').trim().slice(0, 120);
      const categories = ['inspections','weather','musculoskeletal','stress','chemicals','training','contractors','general'];
      const kinds = ['law','guideline','incident','checklist','manual'];
      if (!publisher || !categories.includes(body.category) || !kinds.includes(body.kind)) throw new Error('제공기관과 분야·자료 종류를 확인하세요.');
      const objectPath = `${crypto.randomUUID()}/${name}`;
      const base = new URL(url);
      const storageUrl = new URL(`/storage/v1/object/safety-documents/${objectPath.split('/').map(encodeURIComponent).join('/')}`, base);
      const uploaded = await request(storageUrl, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': mime, 'x-upsert': 'false' }, body: buffer, signal: AbortSignal.timeout(20000) });
      if (!uploaded.ok) throw new Error(`파일 저장 실패 (${uploaded.status}). Supabase SQL 004 적용 여부를 확인하세요.`);
      try {
        const record = await call('', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
          title, source_url: null, publisher, category: body.category, kind: body.kind, tags: [], jurisdiction: '미확인',
          rights_note: '업로드 파일의 출처·이용권한 확인 필요', review_status: 'pending', content_use_allowed: false,
          original_file_name: name, storage_path: objectPath, mime_type: mime, file_size: buffer.length,
          body_text: String(body.bodyText || '').slice(0, 500000), created_by: actor,
        }) });
        return { document: record?.[0], fileName: name };
      } catch (error) {
        await request(storageUrl, { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` } }).catch(() => {});
        throw error;
      }
    },
    async signedFile(documentId) {
      const rows = await call(`?select=storage_path,original_file_name&id=eq.${eq(documentId)}&limit=1`);
      if (!rows[0]?.storage_path) throw new Error('업로드 파일이 없습니다.');
      const signed = await request(new URL(`/storage/v1/object/sign/safety-documents/${rows[0].storage_path.split('/').map(encodeURIComponent).join('/')}`, new URL(url)), {
        method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 300 }), signal: AbortSignal.timeout(10000),
      });
      if (!signed.ok) throw new Error(`파일 열기 실패 (${signed.status}).`);
      const result = await signed.json();
      const signedPath = String(result.signedURL || '');
      const fileUrl = /^https:\/\//i.test(signedPath) ? signedPath : signedPath.startsWith('/storage/v1/')
        ? new URL(signedPath, new URL(url)).href
        : new URL(`/storage/v1${signedPath.startsWith('/object/') ? signedPath : `/${signedPath}`}`, new URL(url)).href;
      return { url: fileUrl, fileName: rows[0].original_file_name };
    },
    async recommendRisk(body) {
      if (!configured) throw new Error('Supabase 미연결: 근거자료를 검색할 수 없습니다.');
      const key = env.OPENAI_API_KEY;
      if (!key) throw new Error('AI 추천 설정이 없습니다. 서버의 OPENAI_API_KEY를 확인하세요.');
      const description = String(body.description || '').trim().slice(0, 3000);
      if (description.length < 8) throw new Error('작업과 위험 상황을 조금 더 자세히 입력하세요.');
      const callAi = async (messages, maxTokens) => {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: 'gpt-4o-mini', response_format: { type: 'json_object' }, max_tokens: maxTokens, messages }),
          signal: AbortSignal.timeout(25000),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(`AI 추천 실패 (${response.status})`);
        return JSON.parse(result.choices?.[0]?.message?.content || '{}');
      };
      const extracted = await callAi([{ role: 'system', content: '산업안전 위험 설명에서 검색할 한국어 핵심어 3~5개를 JSON으로 뽑으세요. 작업, 기인물, 사고형태를 우선합니다. 형식: {"queries":["..."]}' }, { role: 'user', content: description }], 160);
      const queries = [...new Set((Array.isArray(extracted.queries) ? extracted.queries : []).map(x => String(x).trim().slice(0, 50)).filter(Boolean))].slice(0, 5);
      const found = await Promise.all(queries.map(query => this.search(query).catch(() => ({ results: [], cases: [] }))));
      const caseMap = new Map(); const docMap = new Map();
      for (const result of found) {
        for (const item of result.cases || []) caseMap.set(item.id, item);
        for (const item of result.results || []) for (const section of item.sections || []) {
          if (section.body) docMap.set(section.id, { ...section, title: item.title, publisher: item.publisher, review_status: item.review_status });
        }
      }
      const evidence = [
        ...[...caseMap.values()].slice(0, 35).map(item => ({ ref: `sif:${item.id}`, type: 'SIF 사례', status: item.review_status, work: [item.industry_large,item.industry_medium,item.work_category,item.work_name,item.unit_work].filter(Boolean).join(' · '), hazard: item.hazard_object || item.high_risk_situation, incident: item.incident_summary, causes: item.causal_factors, controls: item.reduction_measures })),
        ...[...docMap.values()].slice(0, 15).map(item => ({ ref: `doc:${item.id}`, type: '문서 본문', status: item.review_status, title: item.title, publisher: item.publisher, excerpt: item.body })),
      ];
      const draft = await callAi([
        { role: 'system', content: '당신은 우체국 산업안전 담당자의 위험성평가 작성 보조자입니다. 입력과 제공된 근거만 사용해 JSON으로 답하세요. 근거가 없는 것을 사실처럼 말하지 말고, 우체국 업무와 업종이 다른 사례는 전이 한계를 표시하세요. 개선대책은 가능한 경우 위험원 제거·대체·공학적 개선을 먼저 검토하고 관리적 조치와 보호구를 보완으로 제시하세요. 가능성·중대성 점수는 담당자 검토용 제안이며 확정값이 아닙니다. 외부 SIF 사례 건수로 해당 우체국의 빈도 점수를 산출하지 마세요. 입력에 현장 노출·작업 빈도와 인원 등 충분한 정보가 없으면 frequency는 null로 답하고 무엇을 확인할지 rationale에 적으세요. citations에는 제공된 ref 값만 넣으세요. 형식: {"factor":"유해위험요인","currentControl":"현재 조치 파악 필요 또는 확인된 조치","frequency":null,"severity":1,"rationale":"점수 제안 이유와 확인할 현장정보","measures":["대책 후보"],"citations":["ref"],"limitations":"근거의 한계와 추가 확인사항"}' },
        { role: 'user', content: JSON.stringify({ description, evidence }) },
      ], 1000);
      const validRefs = new Set(evidence.map(item => item.ref));
      return {
        factor: String(draft.factor || '').slice(0, 500), currentControl: String(draft.currentControl || '').slice(0, 500),
        frequency: Number.isInteger(+draft.frequency) && +draft.frequency >= 1 && +draft.frequency <= 5 ? +draft.frequency : null,
        severity: Number.isInteger(+draft.severity) && +draft.severity >= 1 && +draft.severity <= 5 ? +draft.severity : null,
        rationale: String(draft.rationale || '').slice(0, 1500), measures: (Array.isArray(draft.measures) ? draft.measures : []).map(x => String(x).slice(0, 500)).slice(0, 6),
        citations: (Array.isArray(draft.citations) ? draft.citations : []).filter(ref => validRefs.has(ref)).slice(0, 8),
        evidence: evidence.filter(item => (draft.citations || []).includes(item.ref)).slice(0, 8),
        limitations: String(draft.limitations || '').slice(0, 1000), noEvidence: evidence.length === 0,
      };
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
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
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
  app.post('/api/safety-knowledge/recommend', async (req, res) => {
    try { res.json(await repository.recommendRisk(req.body || {})); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/safety-knowledge/:id/file', async (req, res) => {
    try { res.json(await repository.signedFile(req.params.id)); }
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
  app.post('/api/safety-knowledge/upload', async (req, res) => {
    if (!repository.configured) return res.status(503).json({ error: 'Supabase 미연결: 저장하지 않았습니다.' });
    try { res.status(201).json(await repository.uploadDocument(req.body || {}, req.knowledgeUser.id)); }
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
