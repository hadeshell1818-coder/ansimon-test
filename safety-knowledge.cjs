const seeds = require('./seed-assets/safety-sources.json');
const { parseSifWorkbook, SIF_SOURCE_URL, SIF_TITLE, SIF_PUBLISHER } = require('./sif-import.cjs');
const { fetchOfficialSafetySources } = require('./official-law-import.cjs');
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
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const message = detail ? detail.replace(/\s+/g, ' ').slice(0, 240) : '프로젝트 설정과 SQL 적용 여부를 확인하세요.';
      throw new Error(`자료실 연결 실패 (${response.status}). ${message}`);
    }
    return response.status === 204 || options.headers?.Prefer?.includes('return=minimal') ? null : response.json();
  }
  async function call(query, options = {}) { return callResource('safety_documents', query, options); }
  function eq(value) { return encodeURIComponent(String(value)); }
  async function searchApprovedLaws(queries) {
    const terms = [...new Set(queries.flatMap(query => String(query).split(/\s+/)))]
      .map(term => term.replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9-]/g, '').slice(0, 40))
      .filter(term => term.length >= 2).slice(0, 10);
    if (!terms.length) return [];
    const documents = await call('?select=id,title,source_url,publisher,kind,review_status,source_version&kind=eq.law&review_status=eq.approved&limit=200');
    const approved = new Map(documents.map(doc => [doc.id, doc]));
    const found = await Promise.all(terms.map(term => callResource('safety_document_sections',
      `?select=id,document_id,version,locator,body&body=ilike.*${encodeURIComponent(term)}*&limit=12`).catch(() => [])));
    const unique = new Map(found.flat().filter(section => approved.has(section.document_id)).map(section => [section.id, section]));
    return [...unique.values()].map(section => ({ ...section, ...approved.get(section.document_id) }));
  }
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
      const documents = await call('?select=id,title,source_url,publisher,category,kind,tags,jurisdiction,rights_note,review_status,created_at,original_file_name,storage_path,mime_type,file_size,safety_import_rows(count),safety_document_sections(count)&order=created_at.desc&limit=500');
      documents.forEach(doc => {
        doc.case_count = doc.safety_import_rows?.[0]?.count || 0;
        doc.section_count = doc.safety_document_sections?.[0]?.count || 0;
      });
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
      const missingIds = [...new Set(sections.map(section => section.document_id).filter(id => !byId.has(id)))];
      if (missingIds.length) {
        const related = await call(`?select=id,title,source_url,publisher,category,kind,tags,jurisdiction,rights_note,review_status,source_version,original_file_name,storage_path&id=in.(${missingIds.join(',')})`);
        related.forEach(item => byId.set(item.id, item));
      }
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
    async importOfficialLaws(actor) {
      if (!configured) throw new Error('Supabase 미연결: 저장하지 않았습니다.');
      const officialDocuments = await fetchOfficialSafetySources(env, request);
      const imported = [];
      for (const item of officialDocuments) {
        const checkedAt = new Date().toISOString();
        const rows = await call('?on_conflict=source_url', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify([{
            title: item.metadata.title,
            source_url: item.metadata.source_url,
            publisher: item.metadata.publisher,
            category: item.metadata.category,
            kind: item.metadata.kind,
            tags: item.metadata.tags,
            jurisdiction: item.metadata.jurisdiction,
            rights_note: '국가법령정보센터 공식 공개 원문. 실제 적용 전 시행일과 개정 여부를 공식 원문에서 다시 확인',
            source_group: 'PUBLIC',
            review_status: 'approved',
            content_use_allowed: true,
            effective_from: item.metadata.effective_from,
            effective_until: null,
            source_version: item.metadata.source_version,
            checked_at: checkedAt,
            reviewed_by: `공식 원문 확인 · ${actor}`,
            created_by: actor,
          }]),
        });
        const document = rows?.[0];
        if (!document?.id) throw new Error(`${item.metadata.title} 자료 레코드를 저장하지 못했습니다.`);
        const sectionRows = item.sections.map(section => ({
          document_id: document.id,
          version: item.metadata.source_version,
          locator: section.locator,
          body: section.body,
          content_hash: section.content_hash,
        }));
        for (let index = 0; index < sectionRows.length; index += 100) {
          await callResource('safety_document_sections', '?on_conflict=document_id,version,locator', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(sectionRows.slice(index, index + 100)),
          });
        }
        imported.push({ id: document.id, title: item.metadata.title, version: item.metadata.source_version, sections: sectionRows.length });
      }
      return { imported, checkedAt: new Date().toISOString() };
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
      const lawFound = await searchApprovedLaws(queries).catch(() => []);
      const caseMap = new Map(); const docMap = new Map(); const lawMap = new Map();
      for (const result of found) {
        for (const item of result.cases || []) caseMap.set(item.id, item);
        for (const item of result.results || []) for (const section of item.sections || []) {
          if (section.body) docMap.set(section.id, { ...section, title: item.title, publisher: item.publisher, kind: item.kind, source_url: item.source_url, review_status: item.review_status });
        }
      }
      for (const section of lawFound) {
        if (section.body) lawMap.set(section.id, { ...section, kind: 'law' });
      }
      const evidence = [
        ...[...caseMap.values()].slice(0, 25).map(item => ({ ref: `sif:${item.id}`, type: 'SIF 사례', status: item.review_status, work: [item.industry_large,item.industry_medium,item.work_category,item.work_name,item.unit_work].filter(Boolean).join(' · '), hazard: item.hazard_object || item.high_risk_situation, incident: item.incident_summary, causes: item.causal_factors, controls: item.reduction_measures })),
        ...[...lawMap.values()].slice(0, 10).map(item => ({ ref: `doc:${item.id}`, type: '승인된 법령', status: item.review_status, title: item.title, publisher: item.publisher, kind: item.kind, locator: item.locator, sourceUrl: item.source_url, excerpt: item.body })),
        ...[...docMap.values()].slice(0, 10).map(item => ({ ref: `doc:${item.id}`, type: '문서 본문', status: item.review_status, title: item.title, publisher: item.publisher, kind: item.kind, locator: item.locator, sourceUrl: item.source_url, excerpt: item.body })),
      ];
      const draft = await callAi([
        { role: 'system', content: '당신은 우체국 산업안전 담당자의 위험성평가 작성 보조자입니다. 입력과 제공된 근거만 사용해 JSON으로 답하세요. 유사 사고사례의 원인과 감소대책을 우선 검토해 현장에 적용할 개선대책을 제안하세요. 관련된 현행 법령 또는 사업장 위험성평가 지침 조문이 제공된 경우 citations에 함께 포함하세요. 근거 없는 사실이나 법령 조항을 만들지 말고 다른 업종 사례의 적용 한계를 표시하세요. 개선대책은 위험 제거·대체·공학적 개선을 먼저 검토하고 관리적 조치와 보호구를 보완으로 제시하세요. 현재 평가는 상·중·하 3단계입니다. 상: 사망 또는 장애 위험, 법령 기준 미충족. 중: 요양 필요 위험, 아차사고 사례 있음. 하: 작업 수행에 영향 없는 경미한 부상·질병 예상. 상·중은 허용 불가능, 하만 허용 가능합니다. 위험성 수준은 담당자가 현장 확인 후 선택하므로 숫자 점수나 확정 등급을 제시하지 말고 판단에 필요한 현장정보를 rationale에 적으세요. SIF 검색 건수는 현장 발생빈도가 아닙니다. citations에는 제공된 ref만 넣으세요. 형식: {"factor":"유해위험요인","currentControl":"현재 조치 파악 필요 또는 확인된 조치","rationale":"판단 근거와 추가 현장 확인사항","measures":["대책 후보"],"citations":["ref"],"limitations":"근거의 한계"}' },
        { role: 'user', content: JSON.stringify({ description, evidence }) },
      ], 1000);
      const validRefs = new Set(evidence.map(item => item.ref));
      const draftCitations = (Array.isArray(draft.citations) ? draft.citations : []).filter(ref => validRefs.has(ref));
      const draftEvidence = evidence.filter(item => draftCitations.includes(item.ref)).slice(0, 8);
      const review = await callAi([
        {
          role: 'system',
          content: '당신은 산업안전 위험성평가 초안의 품질 검토자입니다. 유해위험요인과 각 개선대책 사이에 실제 인과관계가 있는지, 대책이 위험을 줄이는 방향인지, 인용된 근거가 해당 위험과 대책에 실제로 적용 가능한지 다시 검토하세요. 제공된 근거에 없는 법령 조항이나 사실을 추가하지 마세요. 연결이 약한 대책은 제외하고, 근거가 약한 법령 인용은 제외하세요. 최종 위험성 상·중·하는 확정하지 말고 현장 확인 필요사항으로 남기세요. JSON 형식: {"causalCheck":"pass|partial|fail","legalCheck":"pass|partial|fail","approvedMeasures":["검토를 통과한 개선대책"],"approvedCitations":["제공된 ref"],"reviewSummary":"검토 결과","additionalChecks":["담당자가 확인할 사항"]}',
        },
        { role: 'user', content: JSON.stringify({
          description,
          draft: {
            factor: draft.factor,
            currentControl: draft.currentControl,
            rationale: draft.rationale,
            measures: Array.isArray(draft.measures) ? draft.measures : [],
            citations: draftCitations,
          },
          evidence: draftEvidence,
        }) },
      ], 900);
      const reviewedMeasures = (Array.isArray(review.approvedMeasures) ? review.approvedMeasures : [])
        .map(item => String(item).trim().slice(0, 500)).filter(Boolean).slice(0, 6);
      const reviewedCitations = (Array.isArray(review.approvedCitations) ? review.approvedCitations : [])
        .filter(ref => draftCitations.includes(ref)).slice(0, 8);
      const citedEvidence = evidence.filter(item => reviewedCitations.includes(item.ref)).slice(0, 8);
      const legalReferences = citedEvidence.filter(item => item.type === '승인된 법령' || (item.type === '문서 본문' && (item.kind === 'law' || item.title === '사업장 위험성평가에 관한 지침'))).map(item => {
        const locator = String(item.locator || '').match(/제\s*\d+조(?:의\s*\d+)?(?:\s*\([^)]*\))?/);
        return locator?.[0]?.replace(/\s+/g, ' ').trim() || '';
      }).filter(Boolean);
      const causalCheck = ['pass', 'partial', 'fail'].includes(review.causalCheck) ? review.causalCheck : 'partial';
      const legalCheck = ['pass', 'partial', 'fail'].includes(review.legalCheck) ? review.legalCheck : 'partial';
      const reviewNeedsAttention = evidence.length === 0 || causalCheck === 'fail' || legalCheck === 'fail' || !reviewedMeasures.length;
      return {
        factor: String(draft.factor || '').slice(0, 500), currentControl: String(draft.currentControl || '').slice(0, 500),
        assessmentMethod: 'three-step-v1',
        rationale: String(draft.rationale || '').slice(0, 1500),
        citations: reviewedCitations,
        evidence: citedEvidence,
        legalReferences: [...new Set(legalReferences)].slice(0, 6),
        measures: reviewedMeasures,
        review: {
          causalCheck,
          legalCheck,
          passed: !reviewNeedsAttention,
          needsAttention: reviewNeedsAttention,
          summary: String(review.reviewSummary || '').slice(0, 1000),
          additionalChecks: (Array.isArray(review.additionalChecks) ? review.additionalChecks : []).map(x => String(x).slice(0, 300)).slice(0, 8),
        },
        limitations: [String(draft.limitations || '').trim(), reviewNeedsAttention ? '유해요인·개선대책 또는 관련 근거의 연결성이 충분히 확인되지 않아 담당자 재검토가 필요합니다.' : ''].filter(Boolean).join(' ').slice(0, 1200),
        noEvidence: evidence.length === 0,
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
  app.post('/api/safety-knowledge/import-official-laws', async (req, res) => {
    if (!repository.configured) return res.status(503).json({ error: 'Supabase 미연결: 저장하지 않았습니다.' });
    try { res.status(201).json(await repository.importOfficialLaws(req.knowledgeUser.id)); }
    catch (error) { res.status(400).json({ error: error.message }); }
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
