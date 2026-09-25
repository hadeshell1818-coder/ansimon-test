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
let evidenceResults = [];
let evidenceCases = [];
let selectedEvidence = [];
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
function beginEvidenceEdit(item) {
  selectedEvidence = (item.evidenceIds || []).map(id => ({ id, title: `연결된 근거 ${id}` }));
  evidenceResults = [];
  evidenceCases = [];
}
function evidenceEditorHtml(item) {
  return `<div class="evidence-box"><b>관련 법령·사례 검토</b>
    <small>신고 사진의 위험요인과 작업내용을 기준으로 Supabase에 등록된 근거를 검색합니다. 검색 결과를 그대로 확정하지 말고 담당자가 검토하세요.</small>
    <div class="row-btns"><input id="evidence-query" class="workspace-search" style="margin:0;flex:1" value="${esc(item.factor || item.workContent || item.note || '')}" placeholder="예: 롤파렛트 끼임"><button class="btn" onclick="searchEvidence()">근거 검색</button></div>
    <div id="evidence-results" class="evidence-list"></div>
    <small id="evidence-selected">연결된 근거 ${selectedEvidence.length}건</small></div>`;
}
async function searchEvidence() {
  const query = $('evidence-query')?.value.trim();
  if (!query) return;
  try {
    const result = await api('/api/safety-knowledge/search?q=' + encodeURIComponent(query));
    evidenceResults = result.results || [];
    evidenceCases = result.cases || [];
    renderEvidenceResults();
    if (!evidenceResults.length && !evidenceCases.length) $('evidence-results').innerHTML = '<small>등록·검토대기 검색 결과가 없습니다. 자료실에 출처와 원문을 먼저 등록하세요.</small>';
  } catch (error) {
    if ($('evidence-results')) $('evidence-results').innerHTML = `<small class="workspace-error">${esc(error.message)}</small>`;
  }
}
function renderEvidenceResults() {
  const selectedIds = new Set(selectedEvidence.map(item => item.id));
  const documents = evidenceResults.map(doc => {
    const sections = doc.sections || [];
    const choices = sections.length ? sections : [{ id: doc.id, locator: '문서', body: '' }];
    return `<div><b>${esc(doc.title || '자료')}</b> · ${esc(doc.publisher || '')} · ${esc(doc.review_status || '검토 대기')}
      ${choices.map(section => { const id = section.id || doc.id; return `<label class="evidence-item"><input type="checkbox" ${selectedIds.has(id) ? 'checked' : ''} onchange="toggleEvidence(this, '${esc(id)}', '${esc(doc.title || '자료')}')"><span>${esc(section.locator || '본문')}<small>${esc(String(section.body || '').slice(0, 180))}</small></span></label>`; }).join('')}</div>`;
  }).join('');
  const cases = evidenceCases.length ? `<div class="case-results"><b>SIF 검토대기 사례 ${evidenceCases.length}건</b>${evidenceCases.map(item => `<article class="case-result"><strong>${esc(item.hazard_object || item.high_risk_situation || '유해위험요인')}</strong><small>${esc(item.domain === 'construction' ? [item.work_category, item.work_name, item.unit_work].filter(Boolean).join(' · ') : [item.industry_large, item.industry_medium, item.industry_small].filter(Boolean).join(' · '))}</small><p>${esc(item.incident_summary || item.causal_factors || '')}</p><small>유발요인: ${esc(item.causal_factors || '-')}<br>감소대책 예시: ${esc(item.reduction_measures || '-')}<br>출처: ${esc(item.source_sheet)} ${esc(item.source_row)}행 · 담당자 검토 전</small></article>`).join('')}</div>` : '';
  $('evidence-results').innerHTML = documents + cases;
}
function toggleEvidence(control, id, title) {
  if (control.checked) selectedEvidence.push({ id, title });
  else selectedEvidence = selectedEvidence.filter(item => item.id !== id);
  const el = $('evidence-selected'); if (el) el.textContent = `연결된 근거 ${selectedEvidence.length}건`;
}
function openCategoryLibrary(category) { libraryQuery = category; setTab('library'); }
function sourceRows() {
  if (!knowledgeState) return [];
  const documents = knowledgeState.documents || [];
  const urls = new Set(documents.map(item => item.source_url));
  return [...documents.map(item => ({ ...item, stored: true })),
    ...knowledgeState.candidates.filter(item => !urls.has(item.source_url)).map(item => ({ ...item, stored: false }))];
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
    return `<tr><td>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>` : esc(item.title)}<small>${esc(item.publisher)} · ${esc(item.jurisdiction)}<br>${esc((item.tags || []).join(' · '))}</small></td>
      <td>${item.stored ? 'Supabase 등록' : '출처 후보 · 미적재'}<small>${status[item.review_status] || '검토 대기'}</small></td>
      <td>${esc(item.rights_note)}<small>${item.case_count ? `사례 ${Number(item.case_count).toLocaleString()}건 저장 · 벡터 색인 미등록` : '원문 본문·AI 색인 미등록'}</small></td></tr>`;
  }).join('') || '<tr><td colspan="3">검색 결과 없음</td></tr>';
}
function renderLibrary() {
  const connected = Boolean(knowledgeState?.connected);
  $('content').innerHTML = `<div class="workspace-head"><h2>근거자료실</h2><span class="workspace-state">${connected ? '출처 목록 관리' : 'Supabase 미연결'}</span></div>
    <div class="row-btns"><button class="btn" id="seed-sources" onclick="seedSources()" ${connected ? '' : 'disabled'}>기본 출처 목록 등록</button><button class="btn" onclick="reloadLibrary()">새로고침</button></div>
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
    </form><p id="library-result" role="status"></p>
    <label for="source-search">자료 검색</label><br><input class="workspace-search" id="source-search" value="${esc(libraryQuery)}" placeholder="롤파렛트, 끼임, 법령" oninput="libraryQuery=this.value;renderSourceRows()">
    <div class="workspace-scroll"><table class="workspace-table"><thead><tr><th>자료·제공기관</th><th>등록·검토 상태</th><th>이용조건</th></tr></thead><tbody id="source-rows"></tbody></table></div>`;
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
async function reloadLibrary() { await refreshKnowledge(); if (tab === 'library') renderLibrary(); }
async function seedSources() {
  $('seed-sources').disabled = true;
  try {
    const result = await api('/api/safety-knowledge/seed', { method: 'POST' });
    await reloadLibrary(); toast(`출처 ${result.added.length}건 등록 · 본문 적재 전`);
  } catch (error) { if ($('library-result')) $('library-result').textContent = error.message; }
  finally { if ($('seed-sources')) $('seed-sources').disabled = !knowledgeState?.connected; }
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
