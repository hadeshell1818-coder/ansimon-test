const crypto = require('crypto');
const { connectionFailure } = require('./connection-error.cjs');

const LAW_API_BASE = 'https://www.law.go.kr/DRF/';

const OFFICIAL_SAFETY_SOURCES = [
  {
    type: 'law',
    title: '산업안전보건법',
    category: 'general',
    tags: ['산업안전보건', '위험성평가', '사업주 의무', '산업재해'],
  },
  {
    type: 'law',
    title: '산업안전보건법 시행령',
    category: 'general',
    tags: ['산업안전보건', '시행령', '안전보건관리체제'],
  },
  {
    type: 'law',
    title: '산업안전보건법 시행규칙',
    category: 'general',
    tags: ['산업안전보건', '시행규칙', '보고', '서식'],
  },
  {
    type: 'law',
    title: '산업안전보건기준에 관한 규칙',
    category: 'inspections',
    tags: ['안전보건기준', '시설', '작업장', '운반', '근골격계', '온열질환'],
  },
  {
    type: 'administrative-rule',
    title: '사업장 위험성평가에 관한 지침',
    category: 'general',
    tags: ['위험성평가', '유해위험요인', '위험성 감소대책', '근로자 참여'],
  },
  // Sources below back hazards a carrier can photograph inside a post office.
  {
    type: 'administrative-rule',
    title: '근골격계부담작업의 범위 및 유해요인조사 방법에 관한 고시',
    category: 'musculoskeletal',
    tags: ['근골격계', '중량물', '반복작업', '부담작업', '소포', '작업대'],
  },
  {
    type: 'administrative-rule',
    title: '위험기계·기구 방호조치 기준',
    category: 'inspections',
    tags: ['방호장치', '컨베이어', '지게차', '끼임', '구동부', '덮개'],
  },
  {
    type: 'administrative-rule',
    title: '안전검사 고시',
    category: 'inspections',
    tags: ['안전검사', '컨베이어', '리프트', '크레인', '정기검사'],
  },
  {
    type: 'administrative-rule',
    title: '보호구 안전인증 고시',
    category: 'general',
    tags: ['보호구', '안전모', '안전화', '장갑', '보안경'],
  },
  {
    type: 'law',
    title: '소방시설 설치 및 관리에 관한 법률',
    category: 'inspections',
    tags: ['소방시설', '소화기', '비상구', '피난통로', '방화문', '적치물'],
  },
  {
    type: 'law',
    title: '화재의 예방 및 안전관리에 관한 법률',
    category: 'inspections',
    tags: ['화재예방', '화기취급', '가연물', '적치', '전기화재'],
  },
];

// Official titles differ only in spacing or middle-dot characters (·, ㆍ, ・) across listings.
const sameTitle = (a, b) => String(a || '').replace(/[\s·ㆍ・‧∙]/g, '') === String(b || '').replace(/[\s·ㆍ・‧∙]/g, '');

function arrayOf(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isoDate(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : null;
}

function uniqueText(values) {
  const seen = new Set();
  return values.map(compactText).filter(value => value && !seen.has(value) && seen.add(value));
}

function provisionText(node, output = []) {
  if (Array.isArray(node)) {
    node.forEach(item => provisionText(item, output));
    return output;
  }
  if (!node || typeof node !== 'object') return output;
  for (const [key, value] of Object.entries(node)) {
    if (['조문내용', '항내용', '호내용', '목내용'].includes(key)) {
      arrayOf(value).forEach(item => {
        if (typeof item === 'string') output.push(item);
        else provisionText(item, output);
      });
    } else if (['항', '호', '목'].includes(key)) {
      provisionText(value, output);
    }
  }
  return output;
}

function allStrings(node, output = []) {
  if (typeof node === 'string') output.push(node);
  else if (Array.isArray(node)) node.forEach(item => allStrings(item, output));
  else if (node && typeof node === 'object') Object.values(node).forEach(value => allStrings(value, output));
  return output;
}

function articleLocator(article, index) {
  const heading = compactText(article?.조문내용);
  if (heading) return heading.slice(0, 180);
  const number = compactText(article?.조문번호);
  const branch = compactText(article?.조문가지번호);
  const title = compactText(article?.조문제목);
  return number ? `제${number}조${branch && branch !== '0' ? `의${branch}` : ''}${title ? `(${title})` : ''}` : `조문 ${index + 1}`;
}

function lawSections(payload) {
  const articles = arrayOf(payload?.법령?.조문?.조문단위);
  return articles.map((article, index) => ({
    locator: articleLocator(article, index),
    body: uniqueText(provisionText(article)).join('\n'),
  })).filter(section => section.body);
}

function administrativeRuleSections(payload) {
  const root = payload?.AdmRulService || {};
  const articles = allStrings(root.조문내용).map(compactText).filter(text => /^제\d+조(?:의\d+)?\s*\(/.test(text));
  const sections = articles.map((body, index) => ({
    locator: (body.match(/^제\d+조(?:의\d+)?\s*\([^)]*\)/) || [])[0] || `조문 ${index + 1}`,
    body,
  }));
  for (const [index, appendix] of arrayOf(root?.별표?.별표단위).entries()) {
    const body = uniqueText(allStrings(appendix?.별표내용)).join('\n');
    if (!body) continue;
    sections.push({ locator: compactText(appendix.별표제목) || `별표 ${index + 1}`, body });
  }
  return sections;
}

function uniqueSectionLocators(sections) {
  const counts = new Map();
  return sections.map(section => {
    const base = section.locator;
    const count = (counts.get(base) || 0) + 1;
    counts.set(base, count);
    return { ...section, locator: count === 1 ? base : `${base} · ${count}` };
  });
}

async function fetchJson(request, pathname, params, apiCode) {
  const url = new URL(pathname, LAW_API_BASE);
  url.search = new URLSearchParams({ OC: apiCode, type: 'JSON', ...params }).toString();
  let response;
  try { response = await request(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) }); }
  catch (error) { throw connectionFailure('국가법령정보센터', error, '잠시 후 다시 시도하세요.'); }
  if (!response.ok) throw new Error(`국가법령정보센터 조회 실패 (${response.status})`);
  const data = await response.json();
  // An unregistered OC or server address is answered with 200 and a verification message, not law data.
  if (data?.result && !data.LawSearch && !data.AdmRulSearch && !data.법령 && !data.AdmRulService) {
    throw new Error(`국가법령정보센터 Open API 인증 실패 · ${compactText(data.result)} ${compactText(data.msg)} · 서버 환경변수 LAW_API_OC(신청한 OC 값)와 Open API에 등록한 서버 IP·도메인을 확인하세요.`);
  }
  const envelope = data.LawSearch || data.AdmRulSearch || data.법령 || data.AdmRulService;
  if (!envelope) throw new Error('국가법령정보센터 응답 형식을 확인하지 못했습니다.');
  return data;
}

async function fetchLaw(source, request, apiCode) {
  const listPayload = await fetchJson(request, 'lawSearch.do', { target: 'eflaw', query: source.title, display: '100' }, apiCode);
  const candidates = arrayOf(listPayload?.LawSearch?.law);
  const item = candidates.find(row => sameTitle(row.법령명한글, source.title) && row.현행연혁코드 === '현행');
  if (!item) throw new Error(`${source.title} 현행본을 찾지 못했습니다.`);
  const effectiveDate = isoDate(item.시행일자);
  const detail = await fetchJson(request, 'lawService.do', {
    target: 'eflaw', MST: item.법령일련번호, efYd: item.시행일자,
  }, apiCode);
  const info = detail?.법령?.기본정보 || {};
  const number = compactText(info.공포번호 || item.공포번호);
  return {
    metadata: {
      ...source,
      source_url: `https://www.law.go.kr/법령/${encodeURIComponent(source.title)}`,
      publisher: '법제처 국가법령정보센터',
      kind: 'law',
      jurisdiction: '대한민국',
      effective_from: effectiveDate,
      source_version: `${compactText(info?.법종구분?.content || item.법령구분명)} 제${number}호 · 시행 ${effectiveDate}`,
    },
    sections: lawSections(detail),
  };
}

async function fetchAdministrativeRule(source, request, apiCode) {
  const listPayload = await fetchJson(request, 'lawSearch.do', {
    target: 'admrul', nw: '1', query: source.title, display: '100',
  }, apiCode);
  const candidates = arrayOf(listPayload?.AdmRulSearch?.admrul);
  const item = candidates.find(row => sameTitle(row.행정규칙명, source.title) && row.현행연혁구분 === '현행');
  if (!item) throw new Error(`${source.title} 현행본을 찾지 못했습니다.`);
  const detail = await fetchJson(request, 'lawService.do', {
    target: 'admrul', ID: item.행정규칙일련번호,
  }, apiCode);
  const effectiveDate = isoDate(item.시행일자);
  return {
    metadata: {
      ...source,
      source_url: `https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=${encodeURIComponent(item.행정규칙일련번호)}`,
      publisher: '고용노동부 · 법제처 국가법령정보센터',
      kind: 'guideline',
      jurisdiction: '대한민국',
      effective_from: effectiveDate,
      source_version: `${compactText(item.행정규칙종류)} 제${compactText(item.발령번호)}호 · 시행 ${effectiveDate}`,
    },
    sections: administrativeRuleSections(detail),
  };
}

// One missing or renamed source must not block the others; failures are returned with their reason.
async function fetchOfficialSafetySources(env = process.env, request = fetch, sources = OFFICIAL_SAFETY_SOURCES) {
  const apiCode = String(env.LAW_API_OC || 'test').trim();
  const documents = [], failures = [];
  for (const source of sources) {
    try {
      const document = source.type === 'law'
        ? await fetchLaw(source, request, apiCode)
        : await fetchAdministrativeRule(source, request, apiCode);
      if (!document.sections.length) throw new Error(`${source.title} 조문을 추출하지 못했습니다.`);
      document.sections = uniqueSectionLocators(document.sections).map(section => ({
        ...section,
        content_hash: crypto.createHash('sha256').update(section.body).digest('hex'),
      }));
      documents.push(document);
    } catch (error) {
      failures.push({ title: source.title, error: error.message });
    }
  }
  if (!documents.length && failures.length) throw new Error(failures[0].error);
  return { documents, failures };
}

module.exports = { OFFICIAL_SAFETY_SOURCES, fetchOfficialSafetySources };
