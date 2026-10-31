const safetyCategories = {
  inspections: { title: '작업장·시설 점검', rows: ['롤파렛트·운반대차', '상하차·작업동선', '구분기·컨베이어', '계단·바닥·전기·소방'], needed: '기관 점검표 · 장비 사양서 · 작업장 목록' },
  weather: { title: '온열·한랭', rows: ['작업환경·기상 확인', '휴식·음용수·휴게시설', '보호물품·비상연락', '예방조치 이행 기록'], needed: '최신 예방지침 · 계절별 점검표 · 대상 작업' },
  musculoskeletal: { title: '근골격계', rows: ['중량물 운반·밀기·당기기', '반복작업·작업자세', '유해요인 조사', '설비·작업방법 개선'], needed: '유해요인 조사 서식 · 작업시간·중량 · 현장 관찰' },
  stress: { title: '직무스트레스', rows: ['조직·작업환경 점검', '설문 배포·참여 현황', '비식별 집계', '상담·개선 연계'], needed: '승인 설문 · 동의·보존정책 · 보건담당 접근권한' },
  chemicals: { title: '화학물질', rows: ['사용 물질·제품 목록', '공급자 MSDS', '보관·표지·취급', '보호구·교육·비상조치'], needed: '실제 제품 목록 · 공급자 MSDS · 해당 작업' },
  training: { title: '교육·건강검진', rows: ['직무별 교육 대상·일정', '교육 이수 증빙', '검진 대상·수검 여부', '보건담당 후속관리'], needed: '대상자 기준 · 교육계획 · 검진정보 접근권한' },
  contractors: { title: '도급·공사', rows: ['공사·도급작업 목록', '작업 간 위험·동선 조정', '작업 전 확인·합동점검', '개선조치·완료 확인'], needed: '계약·작업 범위 · 책임 구분 · 적용 점검표' },
};
let knowledgeState = null;
let libraryQuery = '';
let selectedEvidence = [];
let librarySearchTimer = null;
async function refreshKnowledge() {
  if (!me || me.kind !== 'safety_mgr') return;
  try {
    knowledgeState = await api('/api/safety-knowledge');
    $('on-knowledge').textContent = knowledgeState.message;
  } catch (error) {
    knowledgeState = null;
    $('on-knowledge').textContent = error.message;
  }
  if (tab === 'library' && !$('source-form')?.contains(document.activeElement)) renderLibrary();
}
function renderSafetyWorkspace(selected) {
  if (selected === 'library') return renderLibrary();
  if (selected === 'actions') {
    // Reuse the existing assessment records and detail editor, not a second task store.
    const rows = R.registered.filter(item => ['assessing','assessed','done'].includes(item.status));
    $('content').innerHTML = `<div class="workspace-head"><h2>개선관리</h2><span class="workspace-state">위험성평가 연계 기록</span></div>
      <div class="workspace-scroll"><table class="workspace-table"><thead><tr><th>작업·위험요인</th><th>개선대책</th><th>담당·기한</th><th>처리</th></tr></thead><tbody>
      ${rows.map(item => `<tr><td>${esc(item.workContent || '-')}<small>${esc(item.factor || '현장 확인 필요')}</small></td><td>${esc(item.reduction || '대책 미등록')}</td><td>${esc(item.owner || '미지정')}<small>${esc(item.dueDate || '기한 미정')}</small></td><td>${item.status === 'done' ? '개선완료' : '미완료'}<br><button class="btn" data-id="${esc(item.id)}" onclick="editRow(this.dataset.id)">상세·조치</button></td></tr>`).join('') || '<tr><td colspan="4">등록된 개선 대상이 없습니다.</td></tr>'}
      </tbody></table></div>`;
    return;
  }
  const section = safetyCategories[selected];
  if (!section) return;
  $('content').innerHTML = `<div class="workspace-head"><h2>${esc(section.title)}</h2><span class="workspace-state">점검 서식 준비 중</span></div>
    <div class="workspace-scroll"><table class="workspace-table"><thead><tr><th>관리 항목</th><th>서식 상태</th><th>점검 기록</th></tr></thead><tbody>
    ${section.rows.map(row => `<tr><td>${esc(row)}</td><td>기관 검토 대기</td><td>미구축</td></tr>`).join('')}</tbody></table></div>
    <p class="workspace-note">필요 자료: ${esc(section.needed)}</p>
    <button class="btn" onclick="openCategoryLibrary('${selected}')">관련 근거자료</button>`;
}
function openCategoryLibrary(category) { libraryQuery = category; setTab('library'); }
function sourceRows() {
  if (!knowledgeState) return [];
  return (knowledgeState.documents || []).map(item => ({ ...item, stored: true }));
}
function safeSourceUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}
function renderSourceRows() {
  const q = libraryQuery.trim().toLowerCase();
  const rows = sourceRows().filter(item => JSON.stringify([item.title,item.publisher,item.category,item.tags]).toLowerCase().includes(q));
  const status = { pending: '검토 대기', approved: '검토 완료', retired: '사용 중단' };
  $('source-rows').innerHTML = rows.map(item => {
    const url = safeSourceUrl(item.source_url);
    return `<tr><td>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>` : esc(item.title)}<small>${esc(item.publisher)}</small>${item.storage_path?`<button class="btn" style="margin-top:6px" onclick="openKnowledgeFile('${esc(item.id)}')">원본 파일 열기</button>`:''}</td>
      <td>Supabase 등록<small>${status[item.review_status] || '검토 대기'}</small></td>
      <td>${item.case_count
        ? `사례 ${Number(item.case_count).toLocaleString()}건 저장`
        : item.section_count
          ? `본문 ${Number(item.section_count).toLocaleString()}개 저장`
          : '저장 0건'}</td></tr>`;
  }).join('') || '<tr><td colspan="3">검색 결과 없음</td></tr>';
}
function renderLibrary() {
  const connected = Boolean(knowledgeState?.connected);
  $('content').innerHTML = `<div class="workspace-head"><h2>근거자료실</h2><span class="workspace-state">${connected ? '출처 목록 관리' : 'Supabase 미연결'}</span></div>
    <div class="row-btns"><button class="btn primary" id="import-official-laws" onclick="importOfficialLaws()" ${connected ? '' : 'disabled'}>공식 법령 최신본 적재</button><button class="btn" onclick="reloadLibrary()">새로고침</button></div>
    ${semanticPanel(connected)}
    <details class="detailbox"><summary>외부 검색 참고자료 목록 · ${knowledgeState?.referenceCatalog?.titles?.length||0}종</summary><p>${esc(knowledgeState?.referenceCatalog?.note||'참고 목록 확인 중')}</p><p>AI 초안 작성 시 관련 자료의 공개 원문을 우선 검색합니다. 비공개 내부자료는 기관 승인 후 원문을 등록해 주세요.</p><ol>${(knowledgeState?.referenceCatalog?.titles||[]).map(title=>`<li>${esc(title)}</li>`).join('')}</ol></details>
    <p class="workspace-note">국가법령정보센터의 현행 산업안전보건법·시행령·시행규칙·안전보건규칙과 사업장 위험성평가 지침을 조문 단위로 저장합니다. 시행예정본과 연혁본은 제외합니다.</p>
    <form class="sif-import" id="sif-import-form" onsubmit="importSif(event)">
      <div><h3>SIF 고위험요인 아카이브 가져오기</h3><p>한국산업안전보건공단 공개 엑셀의 제조업 등·건설업 원자료를 업종, 공종, 기인물, 유발요인, 감소대책으로 나누어 검토대기 상태로 저장합니다.</p></div>
      <label>원본 XLSX<input id="sif-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required ${connected ? '' : 'disabled'}></label>
      <button class="btn primary" type="submit" ${connected ? '' : 'disabled'}>Supabase에 자료 올리기</button>
      <p id="sif-result" role="status"></p>
    </form>
    <form class="workspace-form" id="source-form" onsubmit="saveSource(event)">
      <label>자료명<input name="title" required maxlength="200" ${connected ? '' : 'disabled'}></label>
      <label>제공기관<input name="publisher" required maxlength="120" ${connected ? '' : 'disabled'}></label>
      <label class="wide">공개 원문 주소<input name="source_url" type="url" required maxlength="2000" placeholder="https://" ${connected ? '' : 'disabled'}></label>
      <label>분야<select name="category">${Object.entries(safetyCategories).map(([id,s]) => `<option value="${id}">${s.title}</option>`).join('')}<option value="general">공통</option></select></label>
      <label>자료 종류<select name="kind"><option value="guideline">안전지침</option><option value="law">법령</option><option value="incident">사고사례</option><option value="checklist">점검표</option><option value="manual">작업 매뉴얼</option></select></label>
      <div class="wide"><button class="btn primary" type="submit" ${connected ? '' : 'disabled'}>출처 등록</button></div>
    </form>
    <form class="workspace-form" id="document-upload-form" onsubmit="uploadKnowledgeDocument(event)">
      <h3 class="wide">PDF·한글 자료 등록</h3>
      <label>자료명<input name="title" required maxlength="200" ${connected ? '' : 'disabled'}></label>
      <label>제공기관<input name="publisher" required maxlength="120" ${connected ? '' : 'disabled'}></label>
      <label>분야<select name="category" ${connected ? '' : 'disabled'}>${Object.entries(safetyCategories).map(([id,s]) => `<option value="${id}">${s.title}</option>`).join('')}<option value="general">공통</option></select></label>
      <label>자료 종류<select name="kind" ${connected ? '' : 'disabled'}><option value="guideline">안전지침</option><option value="law">법령</option><option value="incident">사고사례</option><option value="checklist">점검표</option><option value="manual">작업 매뉴얼</option></select></label>
      <label class="wide">원본 파일<input name="file" type="file" accept=".pdf,.hwp,.hwpx,application/pdf,application/x-hwp" required ${connected ? '' : 'disabled'}></label>
      <label class="wide">검색할 본문 텍스트<textarea name="bodyText" rows="5" placeholder="문서에서 검색할 내용을 붙여넣으세요. 파일은 보관되며, 본문 텍스트를 입력한 경우에만 해당 내용 검색이 가능합니다." ${connected ? '' : 'disabled'}></textarea></label>
      <div class="wide"><button class="btn primary" type="submit" ${connected ? '' : 'disabled'}>자료와 본문 저장</button><small>PDF·HWP·HWPX 원본, 최대 6MB. 업로드 자료는 검토 대기 상태로 등록됩니다.</small></div>
    </form><p id="library-result" role="status"></p>
    <label for="source-search">자료·본문 검색</label><br><input class="workspace-search" id="source-search" value="${esc(libraryQuery)}" placeholder="본문에서 찾을 표현 입력" oninput="libraryQuery=this.value;renderSourceRows();searchLibrary()">
    <div id="library-search-results" class="evidence-list" aria-live="polite"></div>
    <div class="workspace-scroll"><table class="workspace-table"><thead><tr><th>자료·제공기관</th><th>등록·검토 상태</th><th>저장 현황</th></tr></thead><tbody id="source-rows"></tbody></table></div>`;
  renderSourceRows();
}
async function importSif(event) {
  event.preventDefault();
  const form = event.target;
  const file = $('sif-file')?.files?.[0];
  const button = form.querySelector('button');
  if (!file) return;
  button.disabled = true;
  $('sif-result').textContent = '엑셀을 읽고 있습니다. 자료 수에 따라 잠시 걸릴 수 있습니다.';
  try {
    const fileBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('엑셀 파일을 읽지 못했습니다.'));
      reader.readAsDataURL(file);
    });
    const result = await api('/api/safety-knowledge/import-sif', { method: 'POST', body: JSON.stringify({ fileName: file.name, fileBase64 }) });
    $('sif-result').textContent = `${result.imported.toLocaleString()}건 저장 완료 · 제조업 등·건설업 원자료는 모두 검토대기 상태입니다.`;
    toast(`SIF ${result.imported.toLocaleString()}건 저장 완료`);
    await refreshKnowledge();
  } catch (error) { $('sif-result').textContent = error.message; }
  finally { button.disabled = false; }
}
async function uploadKnowledgeDocument(event) {
  event.preventDefault();
  const form = event.target, data = new FormData(form), file = data.get('file');
  const button = form.querySelector('button');
  if (!file || !file.size) return;
  button.disabled = true;
  if ($('library-result')) $('library-result').textContent = '파일을 Supabase에 저장하고 있습니다.';
  try {
    const fileBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
      reader.readAsDataURL(file);
    });
    await api('/api/safety-knowledge/upload', { method: 'POST', body: JSON.stringify({
      title: data.get('title'), publisher: data.get('publisher'), category: data.get('category'), kind: data.get('kind'),
      fileName: file.name, mimeType: file.type, fileBase64, bodyText: data.get('bodyText'),
    }) });
    form.reset();
    if ($('library-result')) $('library-result').textContent = '원본 파일과 입력한 본문을 저장했습니다. 검토 대기 상태입니다.';
    await reloadLibrary();
  } catch (error) { if ($('library-result')) $('library-result').textContent = error.message; }
  finally { button.disabled = false; }
}
async function openKnowledgeFile(id) {
  const tab = window.open('', '_blank');
  try { const result = await api(`/api/safety-knowledge/${encodeURIComponent(id)}/file`); if (tab) tab.location = result.url; else window.location.href = result.url; }
  catch (error) { tab?.close(); toast(error.message); }
}
function searchLibrary() {
  clearTimeout(librarySearchTimer);
  librarySearchTimer = setTimeout(async () => {
    const host = $('library-search-results'), query = libraryQuery.trim();
    if (!host) return;
    if (!query) { host.innerHTML = ''; return; }
    host.innerHTML = '<small>문서 본문과 등록 사례를 검색 중입니다.</small>';
    try {
      const data = await api(`/api/safety-knowledge/search?q=${encodeURIComponent(query)}`);
      const docs = (data.results || []).map(doc => `<article class="case-result"><b>${esc(doc.title || '자료')}</b> · ${esc(doc.publisher || '')}<small>${esc(doc.review_status || '검토 대기')}${doc.storage_path?` · <button class="btn" onclick="openKnowledgeFile('${esc(doc.id)}')">파일 열기</button>`:''}</small>${(doc.sections || []).map(section => `<p><b>${esc(section.locator || '본문')}</b><br>${esc(section.body || '')}</p>`).join('')}</article>`).join('');
      const cases = (data.cases || []).map(item => `<article class="case-result"><b>${esc(item.hazard_object || item.high_risk_situation || 'SIF 사례')}</b><small>${esc([item.industry_large,item.industry_medium,item.work_category,item.work_name].filter(Boolean).join(' · '))} · ${esc(item.review_status || '검토 대기')}</small><p>${esc(item.incident_summary || '')}</p><small>유발요인: ${esc(item.causal_factors || '-')}<br>감소대책: ${esc(item.reduction_measures || '-')}</small></article>`).join('');
      host.innerHTML = docs + cases || '<small>본문이나 사례에서 일치하는 내용을 찾지 못했습니다.</small>';
    } catch (error) { host.innerHTML = `<small class="workspace-error">${esc(error.message)}</small>`; }
  }, 350);
}
// Semantic search: statutes and site reports rarely share words, so each section is stored with its meaning.
function semanticPanel(connected) {
  const sem = knowledgeState?.semantic || {};
  const counts = sem.sections ? `조문 ${Number(sem.sections.total - sem.sections.missing).toLocaleString()}/${Number(sem.sections.total).toLocaleString()} · 사례 ${Number(sem.cases.total - sem.cases.missing).toLocaleString()}/${Number(sem.cases.total).toLocaleString()} 색인` : '';
  return `<section class="detailbox semantic-panel"><h3>의미 검색</h3>
    <p>현장 표현(예: 바닥이 젖어 미끄러움)과 법령 표현(전도의 방지)처럼 단어가 달라도 뜻이 가까운 조문·사례를 찾습니다. 단어 검색과 함께 씁니다.</p>
    <p id="semantic-status" role="status">${esc(sem.message || '확인 중')}${counts ? ` · ${esc(counts)}` : ''}</p>
    <div class="row-btns"><button class="btn" id="index-embeddings" onclick="indexEmbeddings()" ${connected ? '' : 'disabled'}>의미 검색 색인 만들기</button>
    <button class="btn" id="evaluate-search" onclick="evaluateSearch()" ${connected ? '' : 'disabled'}>검색 정확도 점검</button></div>
    <div id="semantic-result" role="status"></div></section>`;
}
async function indexEmbeddings() {
  const button = $('index-embeddings'); button.disabled = true;
  let total = 0;
  try {
    // Each request fills as many vectors as fit in its time budget; repeat until nothing is left.
    for (;;) {
      const result = await api('/api/safety-knowledge/index-embeddings', { method: 'POST' });
      total += Number(result.indexed || 0);
      const left = Number(result.sections?.missing || 0) + Number(result.cases?.missing || 0);
      if ($('semantic-status')) $('semantic-status').textContent = `색인 ${total.toLocaleString()}개 저장 · 남은 항목 ${left.toLocaleString()}개`;
      if (!left || !result.indexed) break;
    }
    await refreshKnowledge(); if (tab === 'library') renderLibrary();
    toast(`의미 검색 색인 ${total.toLocaleString()}개 저장`);
  } catch (error) { if ($('semantic-status')) $('semantic-status').textContent = error.message; }
  finally { if ($('index-embeddings')) $('index-embeddings').disabled = false; }
}
async function evaluateSearch() {
  const button = $('evaluate-search'); button.disabled = true;
  const host = $('semantic-result'), rows = [];
  let total = 64, semantic = null;
  try {
    for (let offset = 0; offset < total; offset += 8) {
      host.textContent = `우체국 사례 ${offset}/${total}건 점검 중`;
      const result = await api('/api/safety-knowledge/evaluate-search', { method: 'POST', body: JSON.stringify({ offset, limit: 8 }) });
      total = result.total; semantic = result.semantic; rows.push(...result.results);
    }
    const expects = rows.flatMap(row => row.expect.map(expect => ({ ...expect, row })));
    const words = expects.filter(item => item.words).length, hybrid = expects.filter(item => item.hybrid).length;
    const misses = expects.filter(item => semantic?.used ? !item.hybrid : !item.words);
    host.innerHTML = `<p><b>기대 근거 ${expects.length}개 중 단어 검색 ${words}개${semantic?.used ? ` · 단어+의미 검색 ${hybrid}개` : ''}가 AI에 전달됩니다.</b>${semantic?.used ? '' : ` 의미 검색 미사용: ${esc(semantic?.error || '')}`}</p>
      <details><summary>놓친 근거 ${misses.length}개</summary><ul>${misses.map(item => `<li>${esc(item.row.id)} ${esc(item.row.desc)} — <small>${esc(item.label)}</small></li>`).join('')}</ul></details>`;
  } catch (error) { host.textContent = error.message; }
  finally { button.disabled = false; }
}
async function reloadLibrary() { await refreshKnowledge(); if (tab === 'library') renderLibrary(); }
async function importOfficialLaws() {
  const button = $('import-official-laws');
  button.disabled = true;
  if ($('library-result')) $('library-result').textContent = '국가법령정보센터에서 현행 조문을 확인하고 Supabase에 저장 중입니다.';
  try {
    const result = await api('/api/safety-knowledge/import-official-laws', { method: 'POST' });
    const sections = (result.imported || []).reduce((sum, item) => sum + Number(item.sections || 0), 0);
    const failed = (result.failed || []).map(item => `${item.title}: ${item.error}`).join(' / ');
    // Refresh first: it re-renders the library, which would otherwise erase the result and failure list.
    await refreshKnowledge();
    if ($('library-result')) $('library-result').textContent = `공식 법령 ${result.imported.length}종 · 조문/별표 ${sections.toLocaleString()}개를 저장했습니다.${failed ? ` 적재하지 못한 자료 ${result.failed.length}종 · ${failed}` : ''}`;
    toast(failed ? `공식 법령 ${result.imported.length}종 적재 · ${result.failed.length}종 실패` : '공식 법령 현행본 적재 완료');
  } catch (error) { if ($('library-result')) $('library-result').textContent = error.message; }
  finally { button.disabled = false; }
}
async function saveSource(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/safety-knowledge', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    await reloadLibrary(); toast('출처 등록 완료 · 검토 대기');
  } catch (error) { if ($('library-result')) $('library-result').textContent = error.message; }
  finally { button.disabled = false; }
}

