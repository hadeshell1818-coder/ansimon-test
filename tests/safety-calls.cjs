const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

function createFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const app = express(); app.use(express.json({ limit: '1mb' }));
  const SAFE = { seq: 1, calls: [], alerts: [] };
  const ROSTER = [{ id: 'c1', name: '시험 직원1', zone: 'z1', phone: '010-0000-0001' }, { id: 'c2', name: '시험 직원2', zone: 'z2' }];
  const ZONES = [{ id: 'z1', name: '시험 1구', places: [], near: [] }, { id: 'z2', name: '시험 2구', places: [], near: [] }, { id: 'empty', name: '미배정구', places: [], near: [] }];
  const sent = [], state = { failSave: false };
  const userFromReq = req => req.headers.authorization === 'Bearer control-test' ? { kind: 'safety', name: '시험 관제', org: '시험 우체국' }
    : req.headers.authorization === 'Bearer carrier-test' ? { kind: 'carrier', id: 'c1', name: '시험 직원1' } : null;
  const ctx = vm.createContext({ app, Date, console, Set,
    SAFE, ROSTER, ZONES, LEVELS: { urgent: '긴급', caution: '주의', notice: '전달말씀' }, SAFETY_CALL_NUMBER: '061-000-0000',
    userFromReq, isSafetyCtl: u => u?.kind === 'safety', safetyCarrier: u => u?.kind === 'carrier' ? ROSTER.find(r => r.id === u.id) : null,
    rosterById: id => ROSTER.find(r => r.id === id), zoneById: id => ZONES.find(z => z.id === id),
    callLabel: c => c.callerName || c.carrierId,
    nextSafeId: prefix => prefix + SAFE.seq++, broadcastSafety() {},
    saveSafety() { if (state.failSave) throw Error('disk failure'); },
    sendSafetyPush: async alert => { sent.push([...alert.targets]); },
  });
  function load(begin, end) {
    const start = source.indexOf(begin), stop = source.indexOf(end, start);
    assert(start >= 0 && stop > start, 'source markers found: ' + begin);
    vm.runInContext(source.slice(start, stop), ctx);
  }
  load('function alertTargets(', 'const isToday = iso =>');
  load('function createAlert(', 'async function sendPush(');
  load("app.post('/api/safety/alerts',", "app.patch('/api/safety/alerts/:id'");
  load('/* Legacy call recordings', "app.get('/api/safety/files/:hid/:kind'");
  app.get('/api/me', (req, res) => res.json({ user: userFromReq(req) }));
  app.get('/api/safety/state', (req, res) => res.json({ today: '2026-09-24', hazards: [], calls: SAFE.calls.map(ctx.callForCtl), alerts: SAFE.alerts,
    roster: ROSTER, zones: ZONES, levels: { urgent: '긴급', caution: '주의', notice: '전달말씀' }, push: { enabled: false } }));
  app.get('/api/on/returns', (_req, res) => res.json({ date: '2026-09-24', summary: { total: 2, absent: 0, target: 2, reported: 0, missing: 2, healthOnly: 0, equipmentOnly: 0, both: 0, ok: 0, selfReported: 0, controlConfirmed: 0 }, rows: ROSTER.map(r => ({ ...r, zoneName: r.zone, report: null })) }));
  app.get('/api/safety/history', (_req, res) => res.json({ hazards: [], calls: SAFE.calls.map(ctx.callForCtl), alerts: SAFE.alerts }));
  app.use(express.static(path.join(__dirname, '../public')));
  return { app, ctx, SAFE, state, sent };
}

async function main() {
  const { app, SAFE, state, sent, ctx } = createFixture();
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(url, body, auth = 'control-test') {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => null) };
  }
  try {
    // The carrier's call button only records an attempt; it never claims a connected call.
    const dial = await request('/api/safety/calls', {}, 'carrier-test');
    assert.equal(dial.status, 200); assert.equal(SAFE.calls[0].source, 'app_dial'); assert.equal(SAFE.calls[0].note, '');
    SAFE.calls.length = 0;

    assert.equal((await request('/api/safety/calls/manual', { callerName: '시험' }, null)).status, 403);
    assert.equal((await request('/api/safety/calls/manual', { carrierId: 'unknown' })).status, 400);
    state.failSave = true;
    assert.equal((await request('/api/safety/calls/manual', { carrierId: 'c1', note: '저장 실패' })).status, 500);
    assert.equal(SAFE.calls.length, 0, 'failed save is rolled back');
    state.failSave = false;
    const manual = { carrierId: 'c1', note: '도로 낙석 위험', requestId: 'manual-1' };
    const created = await request('/api/safety/calls/manual', manual);
    assert.equal(created.status, 200); assert.equal(created.data.call.phone, '010-0000-0001');
    assert.equal((await request('/api/safety/calls/manual', manual)).data.call.id, created.data.call.id);
    assert.equal(SAFE.calls.length, 1, 'network retry must not duplicate call');
    const call = SAFE.calls[0];

    // Legacy recordings stored on older records are never exposed.
    call.recordings = [{ id: 'old', audioFile: 'private.webm' }];
    assert.equal('recordings' in ctx.callForCtl(call), false);
    delete call.recordings;

    await request(`/api/safety/calls/${call.id}/note`, { note: '시험 1구 낙석 위험' });
    assert.equal(call.note, '시험 1구 낙석 위험'); assert.equal(call.noteHistory[0].note, '도로 낙석 위험');

    const body = { fromCall: call.id, text: '낙석 구간 우회', level: 'urgent', zones: ['z1'] };
    assert.equal((await request('/api/safety/alerts', body)).status, 200); assert.deepEqual(sent[0], ['c1']);
    assert.equal((await request('/api/safety/alerts', { ...body, zones: 'all' })).status, 200); assert.deepEqual(sent[1], ['c1', 'c2']);
    assert.equal(call.alertIds.length, 2); assert.equal(SAFE.alerts[0].callNote, '시험 1구 낙석 위험');
    assert.equal((await request('/api/safety/alerts', { ...body, zones: ['empty'] })).status, 400);
    assert.equal((await request('/api/safety/alerts', { ...body, fromCall: 'missing' })).status, 404);
    assert.equal(SAFE.alerts.length, 2);
    console.log('PASS: dial attempt only, manual call auth/validation/retry/rollback, legacy recordings hidden, note history, call-linked zone/all alerts');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
module.exports = { createFixture };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
