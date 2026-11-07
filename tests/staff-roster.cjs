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
  // 실제 엑셀에서 흔한 모양(2026-11-07 첫 업로드에서 칸 이름을 못 찾음): 제목 줄, 띄어 쓴 칸 이름·NBSP·전각 공백,
  // 명단이 두 번째 시트, 숫자로 저장돼 앞의 0이 빠진 휴대폰 번호, 비슷한 칸 이름(성명·휴대폰번호).
  const messy = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(messy, XLSX.utils.aoa_to_sheet([['표지'], ['장흥우체국 직원 현황']]), '표지');
  XLSX.utils.book_append_sheet(messy, XLSX.utils.aoa_to_sheet([['장흥우체국 직원 명단'], [], ['우 체 국 명', '부\u00a0서', '성 명', '휴대폰 번호\u3000', '담당 업무', '배달 구역', '팀 이름'],
    ['장흥', '우편물류과', '가나다', 1011110001, '집배', '장흥읍', '1팀'], ['대덕', '', '나다라', '010.1111.0002', '집배', '대덕읍', '']]), '명단');
  const messyParsed = S.parseRosterBook(XLSX.write(messy, { type: 'buffer', bookType: 'xlsx' }), XLSX, OFFICES);
  assert.deepEqual(messyParsed.errors, []);
  assert.deepEqual(messyParsed.rows.map(r => [r.name, r.phone, r.officeCode, r.team, r.zone, r.duty]), [['가나다', '01011110001', 'jangheung', '1팀', '장흥읍', '집배'], ['나다라', '01011110002', 'daedeok', '', '대덕읍', '집배']]);
  assert.equal(messyParsed.rows[0].line, 4, 'line numbers count the title rows');
  // 칸 이름 줄 없이 첫 줄부터 직원인 명단(2026-11-07 실제 파일 모양): 정해진 칸 순서로 읽는다.
  const bare = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(bare, XLSX.utils.aoa_to_sheet([['장흥우체국', '물류과', '가나다', '010-1111-0001', '우편물류과장'], ['장흥우체국', '물류과', '나다라', '010-1111-0002', '집배', '장흥읍', '1팀'], ['장흥대덕우체국', '', '다라마', '010-1111-0003', '집배', '대덕읍']]), 'Sheet1');
  const bareParsed = S.parseRosterBook(XLSX.write(bare, { type: 'buffer', bookType: 'xlsx' }), XLSX, OFFICES);
  assert.deepEqual(bareParsed.errors, []);
  assert.deepEqual(bareParsed.rows.map(r => [r.line, r.name, r.duty, r.zone, r.team, r.officeCode]), [[1, '가나다', '우편물류과장', '', '', 'jangheung'], [2, '나다라', '집배', '장흥읍', '1팀', 'jangheung'], [3, '다라마', '집배', '대덕읍', '', 'daedeok']]);
  const titleOnly = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(titleOnly, XLSX.utils.aoa_to_sheet([['직원', '연락']]), '시트1');
  assert.match(S.parseRosterBook(XLSX.write(titleOnly, { type: 'buffer', bookType: 'xlsx' }), XLSX, OFFICES).errors[0], /첫 줄: 직원 \| 연락/, 'says what it read');
  // 한 칸에 번호가 두 줄(휴대폰·사무실)로 적힌 경우: 첫 휴대폰 번호를 쓴다.
  assert.equal(S.normPhone('061-860-0000\n010-1111-0001'), '01011110001');
  assert.equal(S.normPhone('010-1111-0001, 010-2222-0002'), '01011110001');
  assert.equal(S.officeFor('장흥총괄', OFFICES).code, 'jangheung');
  assert.equal(S.officeFor('장흥대덕우체국', OFFICES).code, 'daedeok');

  // 명단 반영: 아이디는 이름, 같은 이름은 이름(국).
  const store = S.memoryStaffStore(), users = { jip5: { kind: 'safety_mgr', name: '안전보건담당자' } }, admin = { id: 'jip5', name: '안전보건담당자' };
  let changes = 0;
  const dir = S.createStaffDirectory({ store, users, offices: OFFICES, bcrypt, onChange: () => changes++ });
  await dir.load();
  const applied = await dir.applyImport(book(ROWS, MERGES), XLSX, admin);
  assert.deepEqual(applied, { added: 7, changed: 0, disabled: 0, missing: 0, skipped: 0, total: 7 });
  const ids = Object.fromEntries(dir.list().map(s => [s.phone, s.loginId]));
  assert.equal(ids['010-1111-0001'], '가나다');
  assert.equal(ids['010-1111-0005'], '김동명(장흥)'); assert.equal(ids['010-1111-0006'], '김동명(대덕)');
  assert.ok(Object.keys(users).filter(id => users[id].staff).length === 7 && users.jip5, 'staff accounts join the fixed ones');
  assert.ok(store.logs.some(l => l.action === 'added' && l.by === '안전보건담당자'));

  // 소통실 명부: 장흥총괄·대덕 외근만. 알림 대상은 읍·면(겹치는 팀·소포배달원 모두), 표시 묶음은 팀
  // (팀이 없으면 관내국은 국 이름, 총괄국은 배달구역). 내근·회진국은 빠진다.
  const { zones, groups, roster } = S.rosterFromStaff(dir.active(), OFFICES);
  assert.deepEqual(roster.map(r => r.name).sort(), ['가나다', '김동명', '나다라', '다라마']);
  assert.deepEqual(groups.map(g => [g.name, g.kind, g.area]), [['1팀', 'team', '장흥읍'], ['장흥읍', 'zone', '장흥읍'], ['장흥대덕', 'branch', '대덕읍, 회진면']]);
  const town = name => zones.find(z => z.name === name);
  assert.deepEqual(zones.map(z => z.name), ['장흥읍', '대덕읍·회진면'], 'areas with exactly the same carriers become one (대덕읍·회진면)');
  assert.deepEqual(roster.filter(r => r.zones.includes(town('장흥읍').id)).map(r => r.name).sort(), ['가나다', '나다라', '다라마'], 'the parcel carrier of 장흥읍 gets 1팀 alerts too');
  assert.deepEqual(town('장흥읍').teams, ['1팀', '장흥읍']);
  assert.ok(town('장흥읍').places.includes('장흥'), 'place names suggest the area for a reported location');
  assert.equal(roster.find(r => r.name === '가나다').group, '1팀');
  // 관산읍/관산면처럼 표기가 다른 같은 읍·면은 하나로 본다.
  const mixed = S.rosterFromStaff([{ id: 1, officeCode: 'jangheung', team: '천관팀', zone: '용산면,관산면', name: 'a', phone: '01011112222' }, { id: 2, officeCode: 'jangheung', team: '', zone: '관산읍,용산면', name: 'b', phone: '01011113333' }], OFFICES);
  assert.deepEqual(mixed.zones.map(z => z.name), ['용산면·관산읍'], 'same place spelled 관산면/관산읍, and the same carriers for both towns');
  const overlap = S.rosterFromStaff([{ id: 1, officeCode: 'jangheung', team: '억불팀', zone: '장흥읍,부산면,안양면', name: 'a', phone: '01011112222' }, { id: 2, officeCode: 'jangheung', team: '', zone: '장흥읍', name: 'b', phone: '01011113333' }], OFFICES);
  assert.deepEqual(overlap.zones.map(z => [z.name, overlap.roster.filter(r => r.zones.includes(z.id)).map(r => r.name).join('')]), [['장흥읍', 'ab'], ['부산면·안양면', 'a']], 'a team member is listed under every area the team delivers');

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
  assert.deepEqual(second, { added: 0, changed: 1, disabled: 1, missing: 0, skipped: 0, total: 6 });
  assert.ok(dir.list().find(s => s.name === '라마바').disabled, 'kept with its records, only disabled');
  assert.ok(!Object.values(users).some(u => u.staff && u.name === '라마바'), 'a disabled person cannot sign in');
  // 고칠 줄이 있으면 그대로는 반영하지 않고(400), 「고칠 줄은 빼고 반영」이면 나머지만 저장한다. 그때 빠진 사람 사용 중지는 하지 않는다.
  const withBad = [...next, ['장흥우체국', '영업과', '새직원', '061-000-0000', '창구', '', ''], ['장흥우체국', '영업과', '추가직원', '010-1111-0009', '창구', '', '']];
  assert.equal((await dir.applyImport(book(withBad, MERGES), XLSX, admin)).status, 400);
  const partial = await dir.applyImport(book(withBad.filter(r => r[2] !== '마바사'), MERGES), XLSX, admin, { skipErrors: true, disableMissing: true });
  assert.deepEqual([partial.added, partial.skipped, partial.disabled, partial.missing], [1, 1, 0, 1]);
  assert.ok(dir.list().some(s => s.name === '추가직원') && !dir.list().some(s => s.name === '새직원'));
  assert.ok(!dir.list().find(s => s.name === '마바사').disabled, 'not disabled while error rows are skipped');
  assert.equal((await dir.adminUpdate(dir.list().find(s => s.name === '마바사').id, { officeCode: 'nowhere' }, admin)).status, 400);
  assert.ok(changes > 0);
  // 담당업무로 권한 자동 지정(2026-11-07 사용자 결정): 가입 전에 정해져 가입하면 바로 쓴다. 손으로 바꾼 값이 우선.
  const roleStore = S.memoryStaffStore(), roleUsers = {};
  const roleDir = S.createStaffDirectory({ store: roleStore, users: roleUsers, offices: OFFICES, bcrypt });
  await roleDir.load();
  await roleDir.applyImport(book([
    ['장흥우체국', '물류과', '서무', '010-2000-0001', '서무팀장', '', ''], ['장흥우체국', '영업과', '우편', '010-2000-0002', '우편팀장', '', ''],
    ['장흥우체국', '물류과', '소통', '010-2000-0003', '소통팀장', '', ''], ['장흥우체국', '영업과', '영과', '010-2000-0004', '영업과장', '', ''],
    ['장흥우체국', '물류과', '물과', '010-2000-0005', '우편물류과장', '', ''], ['장흥우체국', '영업과', '금융', '010-2000-0006', '금융팀장', '', ''],
    ['회진우체국', '', '회담', '010-2000-0007', '담당자', '', ''], ['회진우체국', '', '회국', '010-2000-0008', '국장', '', '']]), XLSX, admin);
  const acct = name => Object.entries(roleUsers).find(([, u]) => u.name === name);
  const [seomuId, seomu] = acct('서무'), [, post] = acct('우편'), [, comm] = acct('소통'), [salesId] = acct('영과'), [logiId, logi] = acct('물과'), [, fin] = acct('금융'), [, hd] = acct('회담'), [hgId] = acct('회국');
  assert.deepEqual([seomu.riskRole.collector, seomu.riskRole.writer, seomu.riskRole.supervisorId, seomu.staffAdmin], [true, true, logiId, true]);
  assert.deepEqual([post.riskRole.writer, post.riskRole.supervisorId, post.riskRole.processes], [true, salesId, ['접수(창구)']]);
  assert.deepEqual([comm.riskRole.supervisorId, comm.control], [logiId, true], '소통팀장 also gets the control room');
  assert.equal(logi.riskRole.approver, true);
  assert.equal(fin.riskAccess, false, 'other duties use the app only');
  assert.deepEqual([hd.riskRole.collector, hd.riskRole.supervisorId], [true, hgId], 'a branch 담당자 sends to that office 국장');
  assert.equal(roleDir.viewFor(seomuId, 'risk').kind, 'safety_mgr', 'usable right after signing up');
  await roleDir.adminUpdate(roleDir.list().find(x => x.name === '소통').id, { control: false }, admin);
  assert.equal(Object.values(roleUsers).find(u => u.name === '소통').control, false, 'a manual change wins over the duty default');
  assert.equal(roleDir.list().find(x => x.name === '서무').riskTitle, '총괄 안전담당·공정 담당');
  console.log('PASS: roster Excel (merged cells, short office names, row errors), login ids for same names, team/zone groups for the control room, signup by name+phone, per-screen access, 5-fail lock, unlock/reset, re-upload diff and disable');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
