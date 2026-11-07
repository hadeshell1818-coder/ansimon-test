const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx-js-style');
const S = require('../staff-roster.cjs');

// 직원 명단(2026-11-07 사용자 결정): 엑셀 칸 우체국명 | 부서 | 이름 | 전화번호 | 담당업무 | 배달구역 | 팀이름.
// 집배원은 팀으로 나뉘고 같은 팀이 같은 구역을 배달한다(소통실 알림·공지 묶음). 소포배달은 팀 없이 배달구역만,
// 대덕은 팀 없이 쓴다. 관리자는 서무팀장, 2단계 인증은 나중. 아이디는 이름(동명이인은 이름(국)).
const OFFICES = [
  { code: 'jangheung', name: '장흥우체국', head: true },
  { code: 'daedeok', name: '장흥대덕우체국', head: false },
  { code: 'hoejin', name: '회진우체국', head: false },
];
const book = (rows, merges = []) => {
  const sheet = XLSX.utils.aoa_to_sheet([['우체국명', '부서', '이름', '전화번호', '담당업무', '배달구역', '팀이름'], ...rows]);
  sheet['!merges'] = merges;
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheet, '명단');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const ROWS = [
  ['장흥우체국', '우편물류과', '가나다', '010-1111-0001', '집배', '장흥읍 건산리, 남외리', '1팀'],
  ['', '우편물류과', '나다라', '010-1111-0002', '집배', '장흥읍 건산리, 남외리', ''],
  ['장흥우체국', '우편물류과', '다라마', '010-1111-0003', '소포배달', '장흥읍 전역', ''],
  ['장흥우체국', '지원과', '라마바', '010-1111-0004', '서무', '', ''],
  ['장흥우체국', '영업과', '김동명', '010-1111-0005', '우편 창구', '', ''],
  ['대덕', '', '김동명', '01011110006', '집배', '대덕읍, 회진면', ''],
  ['회진우체국', '', '마바사', '010 1111 0007', '국장', '', ''],
];
// 우체국명(첫 줄)과 1팀(두 줄)을 합친 셀로 둔다.
const MERGES = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }, { s: { r: 1, c: 6 }, e: { r: 2, c: 6 } }];

async function main() {
  // 엑셀 읽기: 합친 셀은 그 범위 모두에 채우고, 우체국명은 짧게 써도 국 코드로 바꾼다.
  const parsed = S.parseRosterBook(book(ROWS, MERGES), XLSX, OFFICES);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 7);
  assert.deepEqual(parsed.rows.map(r => r.officeCode), ['jangheung', 'jangheung', 'jangheung', 'jangheung', 'jangheung', 'daedeok', 'hoejin']);
  assert.deepEqual(parsed.rows.slice(0, 3).map(r => r.team), ['1팀', '1팀', ''], 'merged team cells fill both carriers, the parcel row stays without a team');
  assert.equal(parsed.rows[6].phone, '01011110007');
  const bad = S.parseRosterBook(book([['장흥', '', '오류', '02-123-4567', '', '', ''], ['서울', '', '모름', '010-2222-0000', '', '', ''], ['장흥', '', '가나다', '010-1111-0001', '', '', ''], ['장흥', '', '가나다', '010-1111-0001', '', '', '']]), XLSX, OFFICES);
  assert.equal(bad.errors.length, 3); assert.match(bad.errors[0], /휴대폰/); assert.match(bad.errors[1], /서울/); assert.match(bad.errors[2], /같은 사람/);
  const noHeader = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(noHeader, XLSX.utils.aoa_to_sheet([['성명만']]), 'x');
  assert.match(S.parseRosterBook(XLSX.write(noHeader, { type: 'buffer', bookType: 'xlsx' }), XLSX, OFFICES).errors[0], /이름.*전화번호/);
  assert.equal(S.officeFor('장흥총괄', OFFICES).code, 'jangheung');
  assert.equal(S.officeFor('장흥대덕우체국', OFFICES).code, 'daedeok');

  // 명단 반영: 아이디는 이름, 같은 이름은 이름(국).
  const store = S.memoryStaffStore(), users = { jip5: { kind: 'safety_mgr', name: '안전보건담당자' } }, admin = { id: 'jip5', name: '안전보건담당자' };
  let changes = 0;
  const dir = S.createStaffDirectory({ store, users, offices: OFFICES, bcrypt, onChange: () => changes++ });
  await dir.load();
  const applied = await dir.applyImport(book(ROWS, MERGES), XLSX, admin);
  assert.deepEqual(applied, { added: 7, changed: 0, disabled: 0, missing: 0 });
  const ids = Object.fromEntries(dir.list().map(s => [s.phone, s.loginId]));
  assert.equal(ids['010-1111-0001'], '가나다');
  assert.equal(ids['010-1111-0005'], '김동명(장흥)'); assert.equal(ids['010-1111-0006'], '김동명(대덕)');
  assert.ok(Object.keys(users).filter(id => users[id].staff).length === 7 && users.jip5, 'staff accounts join the fixed ones');
  assert.ok(store.logs.some(l => l.action === 'added' && l.by === '안전보건담당자'));

  // 소통실 명부: 장흥총괄·대덕 외근만, 팀(없으면 배달구역)별 묶음. 내근·회진은 빠진다.
  const { zones, roster } = S.rosterFromStaff(dir.active(), OFFICES);
  assert.deepEqual(roster.map(r => r.name).sort(), ['가나다', '김동명', '나다라', '다라마']);
  assert.equal(zones.length, 3, '1팀, 소포 배달구역, 대덕 배달구역');
  const team = zones.find(z => z.name === '1팀');
  assert.equal(roster.filter(r => r.zone === team.id).length, 2);
  assert.ok(team.places.includes('건산리') && team.places.includes('건산'), 'place names from the 배달구역 suggest the team for a reported location');
  assert.match(zones.find(z => z.group === '장흥대덕').name, /대덕 · 대덕읍, 회진면/);

  // 가입: 이름+번호가 맞아야 하고 동의·8자 이상 비밀번호가 필요하다. 이미 가입된 사람은 안내만.
  assert.equal((await dir.signup({ name: '가나다', phone: '01011110001', password: 'abcdefgh', consent: false })).status, 400);
  assert.equal((await dir.signup({ name: '가나다', phone: '01099999999', password: 'abcdefgh', consent: true })).status, 404);
  assert.equal((await dir.signup({ name: '가나다', phone: '010-1111-0001', password: 'short', consent: true })).status, 400);
  const joined = await dir.signup({ name: '가나다', phone: '010-1111-0001', password: 'abcdefgh1', consent: true, device: 'test phone' });
  assert.equal(joined.loginId, '가나다');
  assert.equal((await dir.signup({ name: '가나다', phone: '010-1111-0001', password: 'abcdefgh1', consent: true })).status, 409);

  // 로그인: 화면마다 권한. 앱은 누구나, 소통실은 roles.control, 위험성평가는 역할이 있어야 한다.
  const id = (await dir.login('가나다', 'abcdefgh1', 'app')).id;
  assert.ok(id);
  assert.equal(dir.viewFor(id, 'app').kind, 'carrier'); assert.equal(dir.viewFor(id, 'app').zone, '1팀');
  assert.equal((await dir.login('가나다', 'abcdefgh1', 'safety')).status, 403);
  assert.equal((await dir.login('가나다', 'abcdefgh1', 'risk')).status, 403);
  assert.equal(dir.viewFor(id, 'risk').kind, 'none');
  assert.equal((await dir.login('나다라', 'whatever1', 'app')).status, 401, 'not joined yet');
  const staffId = dir.list().find(s => s.loginId === '가나다').id;
  await dir.adminUpdate(staffId, { control: true }, admin);
  assert.ok((await dir.login('가나다', 'abcdefgh1', 'safety')).id);
  assert.equal(dir.viewFor(id, 'safety').kind, 'safety');
  await dir.setRiskRole(id, { writer: true, title: '소통팀장' }, admin);
  assert.equal(dir.viewFor(id, 'risk').kind, 'safety_mgr');
  assert.equal(users[id].riskRole.title, '소통팀장');

  // 5번 틀리면 30분 잠금, 관리자가 풀거나 가입을 초기화한다.
  for (let i = 1; i < 5; i++) assert.match((await dir.login('가나다', 'wrong-pass', 'app')).error, new RegExp(`${i}/5`));
  assert.match((await dir.login('가나다', 'wrong-pass', 'app')).error, /30분/);
  assert.equal((await dir.login('가나다', 'abcdefgh1', 'app')).status, 423);
  assert.ok(dir.list().find(s => s.id === staffId).locked);
  await dir.unlock(staffId, admin);
  assert.ok((await dir.login('가나다', 'abcdefgh1', 'app')).id);
  await dir.resetAccount(staffId, admin);
  assert.equal((await dir.login('가나다', 'abcdefgh1', 'app')).status, 401);
  assert.ok((await dir.signup({ name: '가나다', phone: '01011110001', password: 'newpass12', consent: true })).loginId);

  // 다시 올린 명단: 팀이 바뀐 사람, 빠진 사람(확인 뒤 사용 중지, 지우지 않음).
  const next = ROWS.filter(r => r[2] !== '라마바').map(r => r[2] === '다라마' ? [...r.slice(0, 6), '2팀'] : r);
  const preview = await dir.previewImport(book(next, MERGES), XLSX);
  assert.deepEqual([preview.diff.added.length, preview.diff.changed.length, preview.diff.missing.length], [0, 1, 1]);
  assert.deepEqual(preview.diff.changed[0].changes, { team: ['', '2팀'] });
  assert.equal(preview.diff.missing[0].name, '라마바');
  const second = await dir.applyImport(book(next, MERGES), XLSX, admin, { disableMissing: true });
  assert.deepEqual(second, { added: 0, changed: 1, disabled: 1, missing: 0 });
  assert.ok(dir.list().find(s => s.name === '라마바').disabled, 'kept with its records, only disabled');
  assert.ok(!Object.values(users).some(u => u.staff && u.name === '라마바'), 'a disabled person cannot sign in');
  assert.equal((await dir.adminUpdate(dir.list().find(s => s.name === '마바사').id, { officeCode: 'nowhere' }, admin)).status, 400);
  assert.ok(changes > 0);
  console.log('PASS: roster Excel (merged cells, short office names, row errors), login ids for same names, team/zone groups for the control room, signup by name+phone, per-screen access, 5-fail lock, unlock/reset, re-upload diff and disable');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
