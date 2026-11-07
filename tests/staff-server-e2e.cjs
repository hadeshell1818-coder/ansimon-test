const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const XLSX = require('xlsx-js-style');

// Whole server with a stand-in Supabase REST (staff, staff_changes): the admin (서무팀장 test account jip5) uploads the
// roster, a carrier signs up in the app and lands on the 소통실 roster in their team, the same person with 소통실 rights
// signs into the control room, and roster edits from the control room are refused (one list only).
function fakeSupabase() {
  const app = express(); app.use(express.json({ limit: '10mb' }));
  const tables = { staff: [], staff_changes: [] }, seq = { staff: 0, staff_changes: 0 };
  app.use('/rest/v1/:table', (req, res) => {
    const t = tables[req.params.table];
    if (!t) return res.status(404).json({ code: 'PGRST205', message: 'Could not find the table' });
    const idEq = req.query.id && String(req.query.id).replace(/^eq\./, '');
    if (req.method === 'GET') { let rows = [...t]; if (req.query.order === 'id.desc') rows.reverse(); if (req.query.limit) rows = rows.slice(0, +req.query.limit); return res.json(rows); }
    if (req.method === 'POST') {
      const list = (Array.isArray(req.body) ? req.body : [req.body]).map(r => ({ id: ++seq[req.params.table], pw_hash: null, roles: {}, disabled: false, failed_count: 0, at: new Date().toISOString(), ...r }));
      t.push(...list); return res.status(201).json(req.headers.prefer ? list : null);
    }
    if (req.method === 'PATCH') { const rows = t.filter(r => String(r.id) === idEq); rows.forEach(r => Object.assign(r, req.body)); return res.json(rows); }
    res.status(405).end();
  });
  return new Promise(ok => { const server = app.listen(0, '127.0.0.1', () => ok({ server, tables, url: `http://127.0.0.1:${server.address().port}` })); });
}
const roster = () => {
  const sheet = XLSX.utils.aoa_to_sheet([['우체국명', '부서', '이름', '전화번호', '담당업무', '배달구역', '팀이름'],
    ['장흥우체국', '우편물류과', '홍길동', '010-3000-0001', '집배', '장흥읍 건산리', '1팀'],
    ['장흥우체국', '우편물류과', '임꺽정', '010-3000-0002', '집배', '장흥읍 건산리', '1팀'],
    ['장흥우체국', '우편물류과', '전우치', '010-3000-0003', '소통', '', ''],
    ['장흥대덕우체국', '', '심청', '010-3000-0004', '집배', '대덕읍', '']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheet, '명단');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
};

async function main() {
  const supa = await fakeSupabase(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansimon-staff-'));
  const pw = 'test-password-123', port = 3900 + Math.floor(Math.random() * 500);
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, SAFETY_SUPABASE_URL: supa.url, SAFETY_SUPABASE_SERVICE_KEY: 'service-key', SAFETY_KEEPALIVE: 'off', OPENAI_API_KEY: '', COHERE_API_KEY: '', PHOTO_SIGNING_KEY: 'x'.repeat(40) };
  for (const name of ['PW_JIP', 'PW_JIP2', 'PW_JIP3', 'PW_JIP4', 'PW_JIP5', 'PW_JANG1', 'PW_JANG2', 'PW_JANG3', 'PW_KWANG1', 'PW_KWANG2', 'PW_KWANG3', 'PW_BO1', 'PW_BO2', 'PW_BO3']) env[name] = pw;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100 && !/직원 명단 0명/.test(output); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(output, /직원 명단 0명/, output);
    const call = async (method, url, body, token) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const login = async (id, password, site) => call('POST', '/api/login', { id, pw: password, site });

    const admin = (await login('jip5', pw, 'risk')).body.token;
    assert.equal((await call('GET', '/api/staff', null, (await login('jip4', pw, 'safety')).body.token)).status, 403, 'only the admin');
    const preview = await call('POST', '/api/staff/import/preview', { fileBase64: roster() }, admin);
    assert.equal(preview.status, 200); assert.equal(preview.body.diff.added.length, 4);
    const applied = await call('POST', '/api/staff/import/apply', { fileBase64: roster() }, admin);
    assert.deepEqual(applied.body, { added: 4, changed: 0, disabled: 0, missing: 0, skipped: 0, total: 4 });
    assert.equal(supa.tables.staff.length, 4); assert.ok(supa.tables.staff_changes.some(c => c.action === 'added' && c.by_name === '안전보건담당자'));
    assert.ok(supa.tables.staff.every(r => !('pw_hash' in r) || r.pw_hash === null));

    // App: sign up with name + phone, then log in with the name.
    assert.equal((await call('POST', '/api/staff/signup', { name: '홍길동', phone: '01030000001', password: 'hong-pass1', consent: true })).body.loginId, '홍길동');
    const app = await login('홍길동', 'hong-pass1', 'app');
    assert.equal(app.status, 200); assert.equal(app.body.user.kind, 'carrier'); assert.equal(app.body.user.field, true);
    assert.equal(app.body.user.zone, '1팀');
    assert.equal((await login('홍길동', 'hong-pass1', 'safety')).status, 403);

    // 소통실 명부: 장흥총괄·대덕 외근, 팀별 묶음 + 시험 집배원. Editing it from the control room is refused.
    const ctl = (await login('jip4', pw, 'safety')).body.token;
    const config = (await call('GET', '/api/safety/config', null, ctl)).body;
    assert.equal(config.rosterSource, 'staff');
    const team = config.groups.find(g => g.name === '1팀');
    assert.deepEqual(config.roster.filter(r => r.groupId === team.id).map(r => r.name).sort(), ['임꺽정', '홍길동']);
    assert.ok(config.groups.some(g => g.name === '장흥대덕' && g.area === '대덕읍'), 'the branch group shows its real delivery area');
    // 알림은 읍·면 단위: 장흥읍을 고르면 1팀 두 사람이 받는다.
    const town = config.zones.find(z => z.name === '장흥읍');
    const sent = await call('POST', '/api/safety/alerts', { level: 'caution', text: '장흥읍 도로 결빙 주의', zones: [town.id] }, ctl);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const alertTargets = (await call('GET', '/api/safety/state', null, ctl)).body.alerts.at(-1)?.targets || sent.body.alert?.targets || [];
    assert.deepEqual(alertTargets.map(t => typeof t === 'string' ? t : t.id).map(id => config.roster.find(r => r.id === id)?.name).sort(), ['임꺽정', '홍길동']);
    assert.ok(config.roster.some(r => r.name === '심청'), 'the 대덕 carrier too');
    assert.ok(!config.roster.some(r => r.name === '전우치'), 'inside staff are not on the roster');
    assert.ok(config.roster.some(r => r.test && r.name === '집배원1(시험)'));
    const health = (await call('GET', '/api/health')).body.staff;
    assert.deepEqual([health.ready, health.count, health.rosterSource], [true, 4, 'staff'], 'health shows counts only');
    assert.equal((await call('GET', '/api/safety/state', null, ctl)).body.rosterSource, 'staff');
    assert.equal((await call('POST', '/api/safety/config/zones', { name: 'x' }, ctl)).status, 409);
    // The carrier's app sees itself on the roster (return report and team alerts possible).
    const state = await call('GET', '/api/safety/state', null, app.body.token);
    assert.equal(state.status, 200); assert.equal(state.body.role, 'carrier'); assert.equal(state.body.me.zoneName, '1팀');
    // 귀국보고 is accepted for a field carrier on the roster.
    const ret = await call('POST', '/api/on/return', { returned: true, bodyIssue: false, equipmentIssue: false }, app.body.token);
    assert.equal(ret.status, 200, JSON.stringify(ret.body));

    // 소통실 권한 for 전우치, who then signs into the control room with the same name.
    const jeon = supa.tables.staff.find(r => r.name === '전우치');
    assert.equal((await call('PATCH', `/api/staff/${jeon.id}`, { control: true }, admin)).status, 200);
    await call('POST', '/api/staff/signup', { name: '전우치', phone: '010-3000-0003', password: 'jeon-pass1', consent: true });
    const jeonCtl = await login('전우치', 'jeon-pass1', 'safety');
    assert.equal(jeonCtl.status, 200); assert.equal(jeonCtl.body.user.kind, 'safety');
    assert.equal((await call('GET', '/api/safety/config', null, jeonCtl.body.token)).status, 200);
    // Risk roles are kept in the staff list (survive a redeploy): add 전우치 as 공정 담당자 from the settings tab.
    const roles = await call('GET', '/api/risk/roles', null, admin);
    assert.ok(roles.body.staff.some(s => s.name === '전우치'));
    assert.equal((await call('PUT', `/api/risk/roles/st${jeon.id}`, { writer: true, title: '소통팀장' }, admin)).status, 200);
    assert.equal(supa.tables.staff.find(r => r.name === '전우치').roles.risk.title, '소통팀장');
    const jeonRisk = await login('전우치', 'jeon-pass1', 'risk');
    assert.equal(jeonRisk.status, 200); assert.equal(jeonRisk.body.user.kind, 'safety_mgr');
    assert.equal((await call('GET', '/api/risk/state', null, jeonRisk.body.token)).status, 200);
    // Fixed accounts still work as before.
    assert.equal((await login('jip', pw, 'app')).status, 200);
    console.log('PASS: server + Supabase REST stand-in: admin upload, app signup/login by name, team roster for the control room (edits refused there), 소통실 right and risk role for the same person, fixed accounts unchanged');
  } finally {
    child.kill(); supa.server.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
