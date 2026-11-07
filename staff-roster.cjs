'use strict';
/* 직원 명단·가입(AGENTS.md 1-1절, 2026-11-07 사용자 결정).
 * 명단은 Supabase `staff` 표에만 둔다(서버가 서비스 키로 접근, 공개 저장소·Railway 파일에는 두지 않음).
 * 엑셀 칸: 우체국명 | 부서 | 이름 | 전화번호 | 담당업무 | 배달구역 | 팀이름. 배달구역이 있으면 외근(집배원·소포배달).
 * 직원은 이름 + 휴대폰 번호가 명단과 맞으면 비밀번호를 정해 가입한다. 아이디는 이름(동명이인은 "이름(국)").
 * 한 사람이 아이디 하나로 앱·소통실·위험성평가를 쓴다: 로그인한 화면(site)에 따라 권한을 붙인다.
 *   app → 직원(앱), safety → 소통실(roles.control), risk → 위험성평가(roles.admin 또는 roles.risk의 역할).
 * 관리자(서무팀장)는 명단 엑셀 올리기(바뀐 점 미리보기 후 반영), 소속·업무·구역·팀 수정, 사용 중지, 가입 초기화,
 * 잠금 해제를 한다. 모든 변경은 staff_changes에 남긴다. 2단계 인증은 나중에 켠다(사용자 결정). */
const crypto = require('node:crypto');

const COLUMNS = {
  office: ['우체국명', '우체국', '국명', '소속국', '소속'],
  dept: ['부서', '과', '부서명'],
  name: ['이름', '성명'],
  phone: ['전화번호', '휴대폰', '휴대폰번호', '휴대전화', '연락처'],
  duty: ['담당업무', '업무', '직무'],
  zone: ['배달구역', '구역', '집배구', '담당구역'],
  team: ['팀이름', '팀', '팀명'],
};
const FIELDS = ['officeCode', 'dept', 'phone', 'duty', 'zone', 'team'];
const MAX_FAILS = 5, LOCK_MS = 30 * 60 * 1000;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
// 휴대폰 번호: 숫자만. 앞의 0이 빠진 숫자(1012345678)는 0을 붙이고, 한 칸에 번호가 둘 이상(두 줄·쉼표)이면 첫 휴대폰 번호를 쓴다.
const normPhone = value => {
  const text = String(value ?? ''), digits = text.replace(/\D/g, '');
  if (digits.length > 11) { const mobile = text.match(/01[016789][\s.\-)]*\d{3,4}[\s.\-]*\d{4}/); if (mobile) return mobile[0].replace(/\D/g, ''); }
  return /^1[016789]\d{7,8}$/.test(digits) ? '0' + digits : digits;
};
const validPhone = phone => /^01\d{8,9}$/.test(phone);
const shortOffice = office => office.name.replace(/우체국$/, '');
const formatPhone = phone => phone.length === 11 ? `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}` : phone.length === 10 ? `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}` : phone;

// 우체국명 → 국 코드. "장흥우체국"·"장흥"·"장흥총괄" → 총괄국, "대덕"·"장흥대덕우체국" → 장흥대덕.
function officeFor(name, offices) {
  const n = clean(name).replace(/\s/g, '').replace(/우체국$|국$/, '').replace('총괄', '');
  if (!n) return null;
  const exact = offices.find(office => shortOffice(office) === n);
  if (exact) return exact;
  const tail = offices.filter(office => shortOffice(office).endsWith(n));
  return tail.length === 1 ? tail[0] : null;
}

// 칸 이름은 띄어쓰기·보이지 않는 공백(NBSP·전각 공백·BOM)을 빼고 비교하고, 비슷한 이름도 받는다("성명", "휴대폰번호" 등).
const headerText = value => String(value ?? '').replace(/[\s\u00a0\u200b-\u200d\u2060\u3000\ufeff*]/g, '');
const FUZZY = { name: /^(이름|성명|성함|직원명|직원성명)/, phone: /(휴대|핸드폰|전화|연락처|^hp|^h\.p)/i, office: /(우체국|관서|국명|소속국)/, dept: /^(부서|소속과|과명|부서명)/, zone: /(구역|집배구)/, team: /^(팀|조)/, duty: /(업무|직무)/ };
function headerColumns(row) {
  const cells = row.map(headerText), col = {}, used = new Set();
  const pick = (key, test) => { if (col[key] >= 0) return; const i = cells.findIndex((cell, index) => cell && !used.has(index) && test(cell)); if (i >= 0) { col[key] = i; used.add(i); } };
  for (const [key, names] of Object.entries(COLUMNS)) pick(key, cell => names.includes(cell));
  for (const key of ['name', 'phone', 'zone', 'team', 'office', 'dept', 'duty']) pick(key, cell => FUZZY[key].test(cell));
  for (const key of Object.keys(COLUMNS)) if (!(col[key] >= 0)) col[key] = -1;
  return col;
}
// 엑셀 → 명단 행. 칸 이름 줄이 있는 첫 시트를 쓰고(위쪽 30줄 안, 칸 이름 줄이 없으면 정해진 칸 순서로 읽음), 합친 셀(!merges)은 그 범위 모두 같은 값으로 채운다
// (팀·국이 여러 줄에 걸친 경우). 숫자로 저장돼 앞의 0이 빠진 휴대폰 번호(1012345678)는 0을 붙여 읽는다.
function parseRosterBook(buffer, XLSX, offices) {
  const book = XLSX.read(buffer, { type: 'buffer' });
  if (!book.SheetNames.length) return { rows: [], errors: ['엑셀에 시트가 없습니다.'] };
  let grid = null, headerRow = -1, col = null;
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    const rowsOf = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true, raw: false });
    for (const merge of sheet['!merges'] || []) {
      const value = rowsOf[merge.s.r]?.[merge.s.c];
      for (let r = merge.s.r; r <= merge.e.r; r++) for (let c = merge.s.c; c <= merge.e.c; c++) { rowsOf[r] = rowsOf[r] || []; rowsOf[r][c] = value; }
    }
    const found = rowsOf.slice(0, 30).findIndex(row => { const c = headerColumns(row || []); return c.name >= 0 && c.phone >= 0; });
    if (found >= 0) { grid = rowsOf; headerRow = found; col = headerColumns(rowsOf[found]); break; }
  }
  if (!grid) {
    // 칸 이름 줄이 없는 명단: 정해진 순서(우체국명 | 부서 | 이름 | 전화번호 | 담당업무 | 배달구역 | 팀이름)로 읽는다.
    // 첫 칸이 아는 우체국이고 넷째 칸이 휴대폰 번호인 줄이 있는 시트를 쓴다.
    for (const sheetName of book.SheetNames) {
      const sheet = book.Sheets[sheetName];
      const rowsOf = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true, raw: false });
      for (const merge of sheet['!merges'] || []) {
        const value = rowsOf[merge.s.r]?.[merge.s.c];
        for (let r = merge.s.r; r <= merge.e.r; r++) for (let c = merge.s.c; c <= merge.e.c; c++) { rowsOf[r] = rowsOf[r] || []; rowsOf[r][c] = value; }
      }
      const looksLikeStaff = row => !!(row && officeFor(row[0], offices) && validPhone(normPhone(row[3])));
      const start = rowsOf.slice(0, 30).findIndex(looksLikeStaff);
      if (start >= 0) { grid = rowsOf; headerRow = start - 1; col = { office: 0, dept: 1, name: 2, phone: 3, duty: 4, zone: 5, team: 6 }; break; }
    }
  }
  if (!grid) {
    // 무엇을 읽었는지 보여 준다(전화번호처럼 보이는 숫자가 있는 줄은 개인정보라 보여 주지 않음).
    const first = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '', raw: false }).find(row => row.some(cell => clean(cell)));
    const seen = first && !first.some(cell => /\d{3,}/.test(String(cell))) ? ` 첫 시트 「${book.SheetNames[0]}」의 첫 줄: ${first.map(clean).filter(Boolean).slice(0, 10).join(' | ')}.` : ` 시트: ${book.SheetNames.join(', ')}.`;
    return { rows: [], errors: [`칸 이름 줄에서 「이름」과 「전화번호」를 찾지 못했습니다.${seen} 칸 이름: 우체국명 | 부서 | 이름 | 전화번호 | 담당업무 | 배달구역 | 팀이름`] };
  }
  const missing = ['office', 'name', 'phone'].filter(key => col[key] < 0);
  if (missing.length) return { rows: [], errors: [`「${missing.map(key => COLUMNS[key][0]).join('」·「')}」 칸이 없습니다.`] };
  const rows = [], errors = [], seen = new Map();
  grid.slice(headerRow + 1).forEach((cells, index) => {
    const at = key => (col[key] >= 0 ? clean(cells[col[key]]) : '');
    const line = headerRow + index + 2, name = at('name'), rawPhone = at('phone');
    if (!name && !rawPhone) return;
    const phone = normPhone(rawPhone), office = officeFor(at('office'), offices);
    if (!name) return errors.push(`${line}번째 줄: 이름이 없습니다.`);
    if (!validPhone(phone)) return errors.push(`${line}번째 줄(${name}): 휴대폰 번호(010…)를 확인하세요.`);
    if (!office) return errors.push(`${line}번째 줄(${name}): 우체국명 「${at('office')}」을(를) 알 수 없습니다.`);
    const key = `${name}|${phone}`;
    if (seen.has(key)) return errors.push(`${line}번째 줄(${name}): ${seen.get(key)}번째 줄과 같은 사람(이름·번호)입니다.`);
    seen.set(key, line);
    rows.push({ line, name: name.slice(0, 40), phone, officeCode: office.code, officeName: office.name, dept: at('dept').slice(0, 60), duty: at('duty').slice(0, 60), zone: at('zone').slice(0, 200), team: at('team').slice(0, 60) });
  });
  return { rows, errors };
}

// 기존 명단과 새 엑셀을 비교: 같은 사람은 이름+번호, 번호가 바뀐 사람은 이름+국으로 찾는다.
function diffRoster(existing, incoming) {
  const pool = existing.filter(s => !s.disabled), used = new Set();
  const added = [], changed = [], same = [];
  const take = s => { used.add(s.id); return s; };
  for (const row of incoming) {
    const match = pool.find(s => !used.has(s.id) && s.name === row.name && s.phone === row.phone)
      || existing.find(s => !used.has(s.id) && s.disabled && s.name === row.name && s.phone === row.phone)
      || pool.find(s => !used.has(s.id) && s.name === row.name && s.officeCode === row.officeCode && !incoming.some(r => r !== row && r.name === s.name && r.phone === s.phone));
    if (!match) { added.push(row); continue; }
    take(match);
    const changes = {};
    for (const key of FIELDS) if ((match[key] || '') !== (row[key] || '')) changes[key] = [match[key] || '', row[key] || ''];
    if (match.disabled) changes.disabled = [true, false];
    if (Object.keys(changes).length) changed.push({ id: match.id, name: row.name, row, changes });
    else same.push(match.id);
  }
  const missing = pool.filter(s => !used.has(s.id)).map(s => ({ id: s.id, name: s.name, officeName: s.officeName }));
  return { added, changed, missing, same: same.length };
}

// 로그인 아이디: 이름. 같은 이름이 둘 이상이면 그 사람들만 "이름(국)", 그래도 같으면 번호 끝 4자리를 붙인다.
function assignLoginIds(staff, offices) {
  const active = staff.filter(s => !s.disabled), byName = new Map();
  for (const s of active) byName.set(s.name, [...(byName.get(s.name) || []), s]);
  const ids = new Map();
  for (const [name, list] of byName) {
    if (list.length === 1) { ids.set(list[0].id, name); continue; }
    const withOffice = list.map(s => [s, `${name}(${shortOffice(offices.find(o => o.code === s.officeCode) || { name: s.officeName || '' }).replace(/^장흥(?=.)/, '')})`]);
    for (const [s, id] of withOffice) ids.set(s.id, withOffice.filter(([, other]) => other === id).length > 1 ? `${id}${s.phone.slice(-4)}` : id);
  }
  return ids;
}

/* 저장소: Supabase REST(서비스 키) 또는 시험용 메모리. 행은 화면용 이름(camelCase)으로 다룬다. */
const toRow = s => ({ office_code: s.officeCode, office_name: s.officeName, dept: s.dept || '', name: s.name, phone: s.phone, duty: s.duty || '', zone: s.zone || '', team: s.team || '',
  ...(s.loginId !== undefined ? { login_id: s.loginId } : {}), ...(s.disabled !== undefined ? { disabled: !!s.disabled } : {}) });
const fromRow = r => ({ id: r.id, officeCode: r.office_code, officeName: r.office_name, dept: r.dept || '', name: r.name, phone: r.phone, duty: r.duty || '', zone: r.zone || '', team: r.team || '',
  loginId: r.login_id || null, pwHash: r.pw_hash || null, joinedAt: r.joined_at || null, joinDevice: r.join_device || '', lastLoginAt: r.last_login_at || null,
  failedCount: r.failed_count || 0, lockedUntil: r.locked_until || null, disabled: !!r.disabled, roles: (r.roles && typeof r.roles === 'object') ? r.roles : {}, consentAt: r.consent_at || null });
const PATCH_KEYS = { officeCode: 'office_code', officeName: 'office_name', dept: 'dept', name: 'name', phone: 'phone', duty: 'duty', zone: 'zone', team: 'team', loginId: 'login_id', pwHash: 'pw_hash',
  joinedAt: 'joined_at', joinDevice: 'join_device', lastLoginAt: 'last_login_at', failedCount: 'failed_count', lockedUntil: 'locked_until', disabled: 'disabled', roles: 'roles', consentAt: 'consent_at' };
const toPatch = patch => Object.fromEntries(Object.entries(patch).filter(([key]) => PATCH_KEYS[key]).map(([key, value]) => [PATCH_KEYS[key], value]));

function supabaseStaffStore({ url, key, fetchImpl = fetch }) {
  const base = String(url || '').replace(/\/+$/, '') + '/rest/v1';
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const call = async (path, init = {}) => {
    const res = await fetchImpl(base + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    const text = await res.text();
    if (!res.ok) {
      const missing = /relation .*staff|Could not find the table|PGRST205/.test(text);
      const error = new Error(missing ? '직원 명단 표가 아직 없습니다. Supabase SQL Editor에서 supabase/010_staff_roster.sql을 한 번 실행하세요.' : `직원 명단 저장소 오류(${res.status}): ${text.slice(0, 200)}`);
      error.missingTable = missing; throw error;
    }
    return text ? JSON.parse(text) : null;
  };
  return {
    kind: 'supabase',
    async list() { return (await call('/staff?select=*&order=id')).map(fromRow); },
    async insert(rows) { if (!rows.length) return []; return (await call('/staff', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows.map(toRow)) })).map(fromRow); },
    async update(id, patch) { const [row] = await call(`/staff?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...toPatch(patch), updated_at: new Date().toISOString() }) }); return row ? fromRow(row) : null; },
    async log(entries) { if (entries.length) await call('/staff_changes', { method: 'POST', body: JSON.stringify(entries.map(e => ({ staff_id: e.staffId ?? null, staff_name: e.staffName || '', action: e.action, detail: e.detail || {}, by_name: e.by || '', by_id: e.byId || '' }))) }); },
    async changes(limit = 100) { return (await call(`/staff_changes?select=*&order=id.desc&limit=${limit}`)).map(r => ({ id: r.id, staffId: r.staff_id, staffName: r.staff_name, action: r.action, detail: r.detail, by: r.by_name, at: r.at })); },
  };
}
function memoryStaffStore() {
  let seq = 0, logSeq = 0; const rows = [], logs = [];
  return {
    kind: 'memory', rows, logs,
    async list() { return rows.map(r => structuredClone(r)); },
    async insert(list) { return list.map(s => { const row = { id: ++seq, loginId: null, pwHash: null, joinedAt: null, joinDevice: '', lastLoginAt: null, failedCount: 0, lockedUntil: null, disabled: false, roles: {}, consentAt: null, ...structuredClone(s) }; delete row.line; rows.push(row); return structuredClone(row); }); },
    async update(id, patch) { const row = rows.find(r => r.id === +id); if (!row) return null; Object.assign(row, structuredClone(Object.fromEntries(Object.entries(patch).filter(([key]) => PATCH_KEYS[key])))); return structuredClone(row); },
    async log(entries) { for (const e of entries) logs.push({ id: ++logSeq, at: new Date().toISOString(), ...e }); },
    async changes(limit = 100) { return logs.slice(-limit).reverse(); },
  };
}

// 담당업무 → 기본 권한(총괄국). sup: 결재자의 담당업무.
const HEAD_DUTY_ROLES = {
  서무팀장: { admin: true, risk: { collector: true, writer: true, title: '서무팀장', sup: '우편물류과장', processes: ['시설 등', '청사·사무실'] } },
  우편팀장: { risk: { writer: true, title: '우편팀장', sup: '영업과장', processes: ['접수(창구)'] } },
  소통팀장: { control: true, risk: { writer: true, title: '소통팀장', sup: '우편물류과장', processes: ['구분', '발착', '집배'] } },
  영업과장: { risk: { approver: true, title: '영업과장' } },
  우편물류과장: { risk: { approver: true, title: '우편물류과장' } },
  총괄국장: { risk: { chief: true, title: '총괄국장' } },
  국장: { risk: { chief: true, title: '총괄국장' } },
};
// 관내국: 담당자 = 그 국의 총괄 안전담당자·공정 담당자(결재자 국장), 국장 = 결재자.
const BRANCH_DUTY_ROLES = {
  담당자: { risk: { collector: true, writer: true, title: '담당자', sup: '국장' } },
  국장: { risk: { approver: true, title: '국장' } },
};

/* 명단 + 계정. USERS에 `st<번호>` 계정으로 올리고, 로그인한 화면에 따라 kind를 붙인다. */
function createStaffDirectory({ store, users, offices, bcrypt, onChange = () => {}, now = () => Date.now() }) {
  let staff = [], ready = false, lastError = '';
  const accountId = s => `st${s.id}`;
  const byAccount = id => staff.find(s => accountId(s) === id) || null;
  const officeOf = code => offices.find(o => o.code === code) || offices[0];
  /* 담당업무로 정하는 기본 권한(2026-11-07 사용자 결정). 관리자가 손으로 바꾼 값(s.roles)이 항목별로 우선한다.
   * 결재자는 같은 국에서 그 담당업무를 가진 사람으로 정한다(사람이 바뀌어도 새 명단의 담당업무를 따라감). */
  const dutyKey = value => clean(value).replace(/\s/g, '');
  const findDuty = (officeCode, duty) => staff.find(x => !x.disabled && x.officeCode === officeCode && dutyKey(x.duty) === duty);
  function autoRoles(s) {
    const head = officeOf(s.officeCode).head, duty = dutyKey(s.duty);
    const rule = head ? HEAD_DUTY_ROLES[duty] : BRANCH_DUTY_ROLES[duty];
    if (!rule) return {};
    const { sup, ...risk } = rule.risk || {}, supervisor = sup && findDuty(s.officeCode, sup);
    return { ...(rule.control ? { control: true } : {}), ...(rule.admin ? { admin: true } : {}), risk: { ...risk, ...(sup ? { supervisorId: supervisor ? accountId(supervisor) : null } : {}) } };
  }
  function rolesOf(s) {
    const auto = autoRoles(s), own = s.roles || {};
    return { control: Object.hasOwn(own, 'control') ? !!own.control : !!auto.control, admin: Object.hasOwn(own, 'admin') ? !!own.admin : !!auto.admin,
      risk: { ...(auto.risk || {}), ...((own.risk && typeof own.risk === 'object') ? own.risk : {}) }, auto: !!(auto.risk || auto.control || auto.admin) };
  }
  const riskAccess = s => { if (!s) return false; const r = rolesOf(s); return r.admin || ['collector', 'writer', 'approver', 'chief'].some(k => r.risk[k]); };
  const canControl = s => !!s && rolesOf(s).control && officeOf(s.officeCode).head;
  function register() {
    for (const id of Object.keys(users)) if (users[id] && users[id].staff) delete users[id];
    for (const s of staff) {
      if (s.disabled) continue;
      const office = officeOf(s.officeCode);
      users[accountId(s)] = { staff: true, staffId: s.id, kind: 'carrier', pwHash: s.pwHash, name: s.name, loginId: s.loginId, org: office.name, officeCode: office.code,
        dept: s.dept, duty: s.duty, team: s.team, deliveryZone: s.zone, phone: s.phone, region: '장흥군', type: null, role: s.duty || s.dept || '직원',
        riskRole: rolesOf(s).risk, control: canControl(s), staffAdmin: rolesOf(s).admin, riskAccess: riskAccess(s) };
    }
  }
  async function load() {
    try { staff = await store.list(); ready = true; lastError = ''; register(); onChange(); }
    catch (error) { lastError = error.message; ready = false; }
    return { ready, error: lastError };
  }
  const replaceRow = row => { if (!row) return; const i = staff.findIndex(s => s.id === row.id); if (i >= 0) staff[i] = row; else staff.push(row); };
  async function save(id, patch) { const row = await store.update(id, patch); replaceRow(row); return row; }
  async function refreshLoginIds(by) {
    const ids = assignLoginIds(staff, offices), changes = [];
    for (const s of staff) { const next = s.disabled ? s.loginId : ids.get(s.id); if (next && next !== s.loginId) { await save(s.id, { loginId: next }); changes.push({ staffId: s.id, staffName: s.name, action: 'login_id', detail: { before: s.loginId, after: next }, by: by.name, byId: by.id }); } }
    if (changes.length) await store.log(changes);
  }

  // The account seen from one screen. A staff account without the right for that screen gets kind 'none' (403s).
  function viewFor(id, site) {
    const u = users[id];
    if (!u || !u.staff) return u || null;
    if (site === 'safety') return { ...u, kind: u.control ? 'safety' : 'none' };
    if (site === 'risk') return { ...u, kind: u.riskAccess ? 'safety_mgr' : 'none' };
    return { ...u, kind: 'carrier', zone: u.team || u.deliveryZone || null };
  }
  const siteDenied = (s, site) => site === 'safety' && !canControl(s) ? '소통실 권한이 없는 계정입니다. 관리자(서무팀장)에게 요청하세요.'
    : site === 'risk' && !riskAccess(s) ? '위험성평가 권한이 없는 계정입니다. 총괄 안전담당자에게 역할 지정을 요청하세요.' : '';

  async function login(loginId, pw, site) {
    if (!ready) return { status: 503, error: lastError || '직원 명단을 불러오지 못했습니다. 잠시 후 다시 시도하세요.' };
    const s = staff.find(x => !x.disabled && x.loginId === loginId);
    if (!s || !s.pwHash) return { status: 401, error: s ? '아직 가입하지 않았습니다. 앱 첫 화면의 「처음 가입」에서 이름·휴대폰으로 가입하세요.' : '아이디 또는 비밀번호가 올바르지 않습니다.' };
    if (s.lockedUntil && Date.parse(s.lockedUntil) > now()) return { status: 423, error: `비밀번호를 ${MAX_FAILS}번 틀려 잠겼습니다. 30분 뒤 다시 하거나 담당자(서무팀장)에게 잠금 해제를 요청하세요.` };
    const ok = typeof pw === 'string' && await bcrypt.compare(pw, s.pwHash);
    if (!ok) {
      const fails = (s.failedCount || 0) + 1, lock = fails >= MAX_FAILS;
      await save(s.id, { failedCount: lock ? 0 : fails, lockedUntil: lock ? new Date(now() + LOCK_MS).toISOString() : s.lockedUntil });
      if (lock) await store.log([{ staffId: s.id, staffName: s.name, action: 'locked', detail: { fails } }]);
      return { status: 401, error: lock ? `비밀번호를 ${MAX_FAILS}번 틀려 30분 동안 잠겼습니다.` : `아이디 또는 비밀번호가 올바르지 않습니다. (${fails}/${MAX_FAILS})` };
    }
    const denied = siteDenied(s, site);
    if (denied) return { status: 403, error: denied };
    save(s.id, { failedCount: 0, lockedUntil: null, lastLoginAt: new Date(now()).toISOString() }).catch(() => {});
    return { id: accountId(s) };
  }

  async function signup({ name, phone, password, consent, device }) {
    if (!ready) return { status: 503, error: lastError || '직원 명단을 불러오지 못했습니다.' };
    const n = clean(name), p = normPhone(phone);
    if (!consent) return { status: 400, error: '개인정보 수집·이용에 동의해야 가입할 수 있습니다.' };
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) return { status: 400, error: '비밀번호는 8자 이상으로 정하세요.' };
    const s = staff.find(x => x.name === n && x.phone === p);
    if (!s || s.disabled) return { status: 404, error: '명단에서 이름·휴대폰 번호를 찾지 못했습니다. 번호를 확인하거나 담당자(서무팀장)에게 문의하세요.' };
    if (s.pwHash) return { status: 409, error: '이미 가입되어 있습니다. 본인이 아니면 담당자(서무팀장)에게 연락하세요.' };
    const at = new Date(now()).toISOString();
    await save(s.id, { pwHash: await bcrypt.hash(password, 10), joinedAt: at, consentAt: at, joinDevice: clean(device).slice(0, 200), failedCount: 0, lockedUntil: null });
    await store.log([{ staffId: s.id, staffName: s.name, action: 'signup', detail: { device: clean(device).slice(0, 200) } }]);
    register(); onChange();
    return { loginId: s.loginId, name: s.name };
  }

  // Admin view of one person (the phone stays with the admin; 2단계 인증은 나중).
  const adminRow = s => ({ id: s.id, account: accountId(s), name: s.name, loginId: s.loginId, phone: formatPhone(s.phone), officeCode: s.officeCode, officeName: officeOf(s.officeCode).name, dept: s.dept, duty: s.duty, zone: s.zone, team: s.team,
    field: !!s.zone, joined: !!s.pwHash, joinedAt: s.joinedAt, lastLoginAt: s.lastLoginAt, locked: !!(s.lockedUntil && Date.parse(s.lockedUntil) > now()), disabled: s.disabled,
    control: rolesOf(s).control, admin: rolesOf(s).admin, risk: riskAccess(s), riskTitle: riskSummary(s), autoRoles: rolesOf(s).auto });
  const riskSummary = s => { const r = rolesOf(s).risk; return [r.collector && '총괄 안전담당', r.writer && '공정 담당', r.approver && '결재자', r.chief && '총괄국장'].filter(Boolean).join('·'); };

  async function previewImport(buffer, XLSX) {
    if (!ready) await load();
    if (!ready) return { status: 503, error: lastError };
    const parsed = parseRosterBook(buffer, XLSX, offices);
    return { ...parsed, diff: diffRoster(staff, parsed.rows), total: parsed.rows.length };
  }
  // skipErrors: 고칠 줄(번호 형식 등)은 빼고 나머지만 반영한다. 그때는 빠진 사람 사용 중지를 하지 않는다
  // (오류 줄의 사람이 「새 명단에 없음」으로 잘못 잡히지 않도록).
  async function applyImport(buffer, XLSX, by, { disableMissing = false, skipErrors = false } = {}) {
    const preview = await previewImport(buffer, XLSX);
    if (preview.error) return preview;
    if (!preview.rows.length) return { status: 400, error: preview.errors[0] || '엑셀에서 직원을 찾지 못했습니다.', errors: preview.errors };
    if (preview.errors.length && !skipErrors) return { status: 400, error: '엑셀에 고칠 줄이 있습니다. 고친 뒤 다시 올리거나 「고칠 줄은 빼고 반영」을 누르세요.', errors: preview.errors };
    if (preview.errors.length) disableMissing = false;
    const { added, changed, missing } = preview.diff, log = [];
    const inserted = await store.insert(added.map(({ line, ...row }) => row));
    inserted.forEach(replaceRow);
    for (const row of inserted) log.push({ staffId: row.id, staffName: row.name, action: 'added', detail: { officeCode: row.officeCode, team: row.team, zone: row.zone }, by: by.name, byId: by.id });
    for (const c of changed) {
      const patch = Object.fromEntries(Object.keys(c.changes).filter(key => key !== 'disabled').map(key => [key, c.row[key]]));
      if (patch.officeCode) patch.officeName = officeOf(patch.officeCode).name;
      if (c.changes.disabled) patch.disabled = false;
      await save(c.id, patch);
      log.push({ staffId: c.id, staffName: c.name, action: 'changed', detail: c.changes, by: by.name, byId: by.id });
    }
    if (disableMissing) for (const m of missing) { await save(m.id, { disabled: true }); log.push({ staffId: m.id, staffName: m.name, action: 'disabled', detail: { reason: '새 명단에 없음' }, by: by.name, byId: by.id }); }
    await store.log(log);
    await refreshLoginIds(by);
    register(); onChange();
    return { added: inserted.length, changed: changed.length, disabled: disableMissing ? missing.length : 0, missing: disableMissing ? 0 : missing.length, skipped: preview.errors.length, total: staff.filter(x => !x.disabled).length };
  }
  async function adminUpdate(id, body, by) {
    const s = staff.find(x => x.id === +id);
    if (!s) return { status: 404, error: '직원을 찾을 수 없습니다.' };
    const patch = {}, detail = {};
    for (const key of ['dept', 'duty', 'zone', 'team']) if (typeof body[key] === 'string' && clean(body[key]) !== s[key]) { patch[key] = clean(body[key]).slice(0, key === 'zone' ? 200 : 60); detail[key] = [s[key], patch[key]]; }
    if (typeof body.officeCode === 'string' && body.officeCode !== s.officeCode) {
      const office = offices.find(o => o.code === body.officeCode);
      if (!office) return { status: 400, error: '알 수 없는 국입니다.' };
      Object.assign(patch, { officeCode: office.code, officeName: office.name }); detail.officeCode = [s.officeCode, office.code];
    }
    if (typeof body.disabled === 'boolean' && body.disabled !== s.disabled) {
      if (body.disabled && accountId(s) === by.id) return { status: 400, error: '자기 계정은 사용 중지할 수 없습니다.' };
      patch.disabled = body.disabled; detail.disabled = [s.disabled, body.disabled];
    }
    const roles = { ...s.roles };
    const current = rolesOf(s);
    for (const key of ['control', 'admin']) if (typeof body[key] === 'boolean' && body[key] !== current[key]) {
      if (key === 'admin' && !body.admin && accountId(s) === by.id) return { status: 400, error: '자기 관리자 권한은 뺄 수 없습니다. 다른 관리자에게 요청하세요.' };
      roles[key] = body[key]; detail[key] = [current[key], body[key]];
    }
    if ('control' in detail || 'admin' in detail) patch.roles = roles;
    if (!Object.keys(patch).length) return { ok: true, staff: adminRow(s) };
    const row = await save(s.id, patch);
    await store.log([{ staffId: s.id, staffName: s.name, action: 'updated', detail, by: by.name, byId: by.id }]);
    if (patch.disabled !== undefined) await refreshLoginIds(by);
    register(); onChange();
    return { ok: true, staff: adminRow(row || s) };
  }
  async function resetAccount(id, by) {
    const s = staff.find(x => x.id === +id);
    if (!s) return { status: 404, error: '직원을 찾을 수 없습니다.' };
    await save(s.id, { pwHash: null, joinedAt: null, failedCount: 0, lockedUntil: null });
    await store.log([{ staffId: s.id, staffName: s.name, action: 'reset', detail: {}, by: by.name, byId: by.id }]);
    register(); onChange();
    return { ok: true };
  }
  async function unlock(id, by) {
    const s = staff.find(x => x.id === +id);
    if (!s) return { status: 404, error: '직원을 찾을 수 없습니다.' };
    await save(s.id, { failedCount: 0, lockedUntil: null });
    await store.log([{ staffId: s.id, staffName: s.name, action: 'unlock', detail: {}, by: by.name, byId: by.id }]);
    return { ok: true };
  }
  // 위험성평가 역할(설정 탭)은 이 사람의 roles.risk에 저장한다(재배포해도 남음).
  async function setRiskRole(accountIdValue, next, by) {
    const s = byAccount(accountIdValue);
    if (!s) return null;
    const roles = { ...s.roles, risk: { ...(s.roles.risk || {}), ...next } };
    await save(s.id, { roles });
    await store.log([{ staffId: s.id, staffName: s.name, action: 'risk_role', detail: next, by: by.name, byId: by.id }]);
    register(); onChange();
    return roles.risk;
  }

  return {
    load, viewFor, login, signup, previewImport, applyImport, adminUpdate, resetAccount, unlock, setRiskRole, accountId, byAccount,
    list: () => staff.map(adminRow), changes: limit => store.changes(limit),
    active: () => staff.filter(s => !s.disabled), status: () => ({ ready, error: lastError, store: store.kind, count: staff.filter(s => !s.disabled).length, joined: staff.filter(s => !s.disabled && s.pwHash).length }),
  };
}

// 배달구역 글 → 지명 목록(위험신고 위치로 알림 대상 팀을 제안할 때 씀). "대덕읍, 회진면" → 대덕읍·대덕·회진면·회진.
function placesFrom(text) {
  const out = new Set();
  for (const token of String(text || '').split(/[,·/\s()]+/).map(t => t.trim()).filter(t => t.length >= 2)) {
    out.add(token);
    const stem = token.replace(/(읍|면|동|리|구)$/, '');
    if (stem.length >= 2 && stem !== token) out.add(stem);
  }
  return [...out].slice(0, 40);
}
const groupKey = s => s.team ? `팀:${s.team}` : `구역:${s.officeCode}:${s.zone}`;
const groupId = key => 'g' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
// 배달구역 글 → 읍·면 목록. "장흥읍,부산면" → [장흥읍, 부산면]. 읍·면이 없으면 글 전체를 한 지역으로 본다.
const townsOf = text => { const tokens = String(text || '').split(/[,·/\s()]+/).map(t => t.trim()).filter(Boolean); const towns = tokens.filter(t => /(읍|면)$/.test(t)); return towns.length ? towns : (String(text || '').trim() ? [String(text).trim()] : []); };
const townStem = name => name.replace(/(읍|면)$/, '');
/* 소통실 명부(2026-11-07 사용자 결정): 장흥총괄·대덕의 외근(배달구역 있음).
 * - 알림 대상 단위는 읍·면이다(zones). 팀과 팀 없는 소포배달원의 배달구역이 겹치므로, 한 읍·면을 고르면 그곳을
 *   배달하는 팀원과 소포배달원 모두에게 간다(예: 장흥읍 → 억불팀·예양팀·장흥읍 소포배달). 관산읍/관산면처럼 표기가
 *   다르면 같은 곳으로 본다(읍 표기 우선). 받는 사람이 똑같은 읍·면들은 한 지역으로 묶는다(대덕읍·회진면 등).
 * - 명부·공지 화면의 묶음은 팀(groups): 팀이 없으면 관내국은 국 이름(장흥대덕), 총괄국은 배달구역 글.
 *   각 묶음은 실제 배달지역(area, 예: 대덕읍, 회진면)과 그 읍·면(towns)을 가진다. */
function rosterFromStaff(list, offices) {
  const field = list.filter(s => !s.disabled && s.zone && ['jangheung', 'daedeok'].includes(s.officeCode));
  const towns = new Map(), groups = new Map();
  const townFor = name => {
    const stem = townStem(name), found = towns.get(stem);
    if (found) { if (/읍$/.test(name) && !/읍$/.test(found.name)) found.name = name; return found; }
    const town = { id: groupId(`읍면:${stem}`), group: '읍면', name, near: [], lat: null, lng: null, teams: new Set() };
    towns.set(stem, town); return town;
  };
  for (const s of field) {
    const key = groupKey(s), office = offices.find(o => o.code === s.officeCode), branch = !!(office && !office.head);
    const g = groups.get(key) || { id: groupId(key), kind: s.team ? 'team' : branch ? 'branch' : 'zone', name: s.team || (branch ? shortOffice(office) : townsOf(s.zone).join('·')), towns: new Set(), areas: new Set() };
    for (const t of townsOf(s.zone)) { const town = townFor(t); g.towns.add(town.id); g.areas.add(town); town.teams.add(g.name); }
    groups.set(key, g);
  }
  // 받는 사람이 똑같은 읍·면은 한 알림 지역으로 묶는다(예: 대덕읍·회진면은 대덕국 집배원 다섯 명이 모두 배달).
  const townIdsOf = s => [...new Set(townsOf(s.zone).map(t => towns.get(townStem(t)).id))];
  const membersOf = new Map();
  for (const s of field) for (const id of townIdsOf(s)) membersOf.set(id, [...(membersOf.get(id) || []), s.id]);
  const areas = new Map(), areaOfTown = new Map();
  for (const town of towns.values()) {
    const key = (membersOf.get(town.id) || []).sort((a, b) => a - b).join(',');
    const area = areas.get(key) || { towns: [], teams: new Set() };
    area.towns.push(town); town.teams.forEach(t => area.teams.add(t)); areas.set(key, area);
  }
  const zones = [...areas.values()].map(area => {
    const id = area.towns.length === 1 ? area.towns[0].id : groupId(`읍면:${area.towns.map(t => townStem(t.name)).join('+')}`);
    area.towns.forEach(t => areaOfTown.set(t.id, id));
    const name = area.towns.map(t => t.name).join('·');
    return { id, group: '읍면', name, area: name, towns: area.towns.map(t => t.name), places: placesFrom(area.towns.map(t => t.name).join(' ')), near: [], lat: null, lng: null, teams: [...area.teams] };
  });
  const areaIds = ids => [...new Set(ids.map(id => areaOfTown.get(id)))];
  const groupList = [...groups.values()].map(g => ({ id: g.id, kind: g.kind, name: g.name, area: [...g.areas].map(t => t.name).join(', '), towns: areaIds([...g.towns]) }));
  const roster = field.map(s => {
    const g = groups.get(groupKey(s)), ids = areaIds(townIdsOf(s));
    return { id: `st${s.id}`, name: s.name, zone: ids[0], zones: ids, group: g.name, groupId: g.id, phone: formatPhone(s.phone), team: s.team, deliveryZone: s.zone, staff: true };
  });
  return { zones, groups: groupList, roster };
}

module.exports = { parseRosterBook, diffRoster, assignLoginIds, officeFor, normPhone, supabaseStaffStore, memoryStaffStore, createStaffDirectory, rosterFromStaff, placesFrom, townsOf, COLUMNS, HEAD_DUTY_ROLES, BRANCH_DUTY_ROLES };
