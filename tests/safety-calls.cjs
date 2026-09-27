const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const express = require('express');

function createFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ansimon-call-test-'));
  const app = express(); app.use(express.json({ limit: '10mb' }));
  const SAFE = { seq: 1, calls: [], alerts: [] };
  const ROSTER = [{ id: 'c1', name: '시험 직원1', zone: 'z1' }, { id: 'c2', name: '시험 직원2', zone: 'z2' }];
  const ZONES = [{ id: 'z1', name: '시험 1구', places: [], near: [] }, { id: 'z2', name: '시험 2구', places: [], near: [] }, { id: 'empty', name: '미배정구', places: [], near: [] }];
  const sent = [], state = { failSave: false, stt: '시험 1구 도로에 낙석이 있습니다.', sttCalls: 0, saved: '' };
  const userFromReq = req => req.headers.authorization === 'Bearer control-test' ? { kind: 'safety', name: '시험 관제', org: '시험 우체국' } : null;
  const ctx = vm.createContext({ app, fs, path, crypto, Buffer, Date, console, Set,
    SAFE, ROSTER, ZONES, UP_DIR: directory, LEVELS: { urgent: '긴급', caution: '주의', notice: '전달말씀' },
    process: { env: { OPENAI_API_KEY: 'test-stub-only' } },
    userFromReq, isSafetyCtl: u => u?.kind === 'safety', safetyCarrier: () => null,
    rosterById: id => ROSTER.find(r => r.id === id), zoneById: id => ZONES.find(z => z.id === id),
    callLabel: c => c.callerName || c.carrierId,
    nextSafeId: prefix => prefix + SAFE.seq++, broadcastSafety() {},
    saveSafety() { if (state.failSave) throw Error('disk failure'); state.saved = JSON.stringify(SAFE); },
    openaiTranscribe: async () => { state.sttCalls++; return state.stt; },
    openaiDraft: async () => null,
    stubDraft: note => ({ text: note.slice(0, 100), zones: ['z1'], level: 'urgent', mode: 'rule' }),
    sendSafetyPush: async (alert) => { sent.push([...alert.targets]); },
  });
  function load(begin, end) {
    const start = source.indexOf(begin), stop = source.indexOf(end, start);
    assert(start >= 0 && stop > start, 'source markers found');
    vm.runInContext(source.slice(start, stop), ctx);
  }
  load('const AUDIO_EXT =', 'function signedSafetyUrl');
  load('function alertTargets(', 'function shiftRows');
  load('function createAlert(', 'async function sendPush(');
  load("app.post('/api/safety/alerts',", "app.patch('/api/safety/alerts/:id'");
  load('/* Call audio stays', 'const SHIFT_ST');
  app.get('/api/me', (req, res) => res.json({ user: userFromReq(req) }));
  app.get('/api/safety/state', (req, res) => res.json({ today: '2026-09-24', hazards: [], calls: SAFE.calls.map(ctx.callForCtl), alerts: SAFE.alerts,
    roster: ROSTER, zones: ZONES, levels: { urgent: '긴급', caution: '주의', notice: '전달말씀' }, push: { enabled: false } }));
  app.get('/api/on/returns', (_req, res) => res.json({ date: '2026-09-24', summary: { total: 2, absent: 0, target: 2, reported: 0, missing: 2, healthOnly: 0, equipmentOnly: 0, both: 0, ok: 0, selfReported: 0, controlConfirmed: 0 }, rows: ROSTER.map(r => ({ ...r, zoneName: r.zone, report: null })) }));
  app.get('/api/safety/history', (_req, res) => res.json({ hazards: [], calls: SAFE.calls.map(ctx.callForCtl), alerts: SAFE.alerts }));
  app.use(express.static(path.join(__dirname, '../public')));
  return { app, ctx, SAFE, state, sent, directory,
    cleanup() { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); } };
}
function wavBuffer() {
  const data = Buffer.alloc(16044); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}
async function main() {
  const fixture = createFixture(), { app, SAFE, state, sent, ctx } = fixture;
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const audioBase64 = 'data:audio/wav;base64,' + wavBuffer().toString('base64');
  async function request(url, body, auth = true, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer control-test' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => null); return { status: response.status, data };
  }
  try {
    assert.equal((await request('/api/safety/calls/manual', { callerName: '시험' }, false)).status, 403);
    const manual = { carrierId: 'c1', note: '도로 낙석 위험', audioBase64, requestId: 'manual-1' };
    const created = await request('/api/safety/calls/manual', manual);
    assert.equal(created.status, 200); assert.equal(SAFE.calls.length, 1);
    const call = created.data.call, recording = call.recordings[0];
    assert(!('audioFile' in recording), 'private storage path must not leave server');
    assert.equal((await request('/api/safety/calls/manual', manual)).data.call.id, call.id);
    assert.equal(SAFE.calls.length, 1, 'network retry must not duplicate call');
    assert.equal((await request(recording.audioUrl, undefined, false)).status, 403);
    const playback = await fetch(base + recording.audioUrl, { headers: { Authorization: 'Bearer control-test' } });
    assert.equal(playback.status, 200); assert.equal((await playback.arrayBuffer()).byteLength, wavBuffer().length);
    const endpoint = `/api/safety/calls/${call.id}/recordings`;
    assert.equal((await request(endpoint, { audioBase64 }, false)).status, 403);
    assert.equal((await request(endpoint, { audioBase64: 'data:text/html;base64,AAAA' })).status, 400);
    assert.equal((await request(endpoint, { audioBase64: 'data:audio/wav;base64,' + Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') })).status, 400);
    state.failSave = true;
    assert.equal((await request(endpoint, { audioBase64 })).status, 500);
    assert.equal(SAFE.calls[0].recordings.length, 1); assert.equal(fs.readdirSync(fixture.directory).length, 1);
    state.failSave = false;
    assert.equal((await request(endpoint, { audioBase64, requestId: 'audio-2' })).status, 200);
    await request(endpoint, { audioBase64, requestId: 'audio-2' }); assert.equal(SAFE.calls[0].recordings.length, 2);
    const transcribe = endpoint + '/' + recording.id + '/transcribe';
    assert.equal((await request(transcribe, {}, false)).status, 403);
    ctx.process.env.OPENAI_API_KEY = '';
    assert.equal((await request(transcribe, {})).status, 503); ctx.process.env.OPENAI_API_KEY = 'test-stub-only';
    state.stt = null; assert.equal((await request(transcribe, {})).status, 502);
    assert.equal(SAFE.calls[0].recordings[0].transcript, '');
    assert(fs.existsSync(path.join(fixture.directory, SAFE.calls[0].recordings[0].audioFile)), 'STT failure preserves audio');
    state.stt = '시험 1구 낙석 위험'; const converted = await request(transcribe, {});
    assert.equal(converted.data.call.recordings[0].transcript, state.stt);
    assert.equal(SAFE.calls[0].note, '도로 낙석 위험', 'transcription must not overwrite approved note');
    const count = state.sttCalls; await request(transcribe, {}); assert.equal(state.sttCalls, count);
    const draft = await request(`/api/safety/calls/${call.id}/draft`, { note: '시험 1구 낙석 위험' });
    assert.equal(draft.status, 200); assert.equal(SAFE.alerts.length, 0, 'draft must not send a notification');
    const body = { fromCall: call.id, text: '낙석 구간 우회', level: 'urgent', zones: ['z1'] };
    assert.equal((await request('/api/safety/alerts', body)).status, 200); assert.deepEqual(sent[0], ['c1']);
    assert.equal((await request('/api/safety/alerts', { ...body, zones: 'all' })).status, 200); assert.deepEqual(sent[1], ['c1', 'c2']);
    assert.equal(SAFE.calls[0].alertIds.length, 2); assert.equal(SAFE.alerts[0].callNote, '도로 낙석 위험');
    assert.equal((await request('/api/safety/alerts', { ...body, zones: ['empty'] })).status, 400);
    assert.equal(SAFE.alerts.length, 2);
    const sample = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/safety-stats-sample.js'), 'utf8'), sample);
    const daily = vm.runInContext('summarizeStatsSample(SAFETY_STATS_SAMPLE.slice(-1))', sample);
    assert.equal(daily.target, 8); assert.equal(daily.absent, 2); assert.equal(daily.reported, 7); assert.equal(daily.missing, 1);
    assert.equal(daily.body, 2); assert.equal(daily.equipment, 2); assert.equal(daily.both, 1); assert.equal(daily.issue, 3);
    const monthly = vm.runInContext('summarizeStatsSample(SAFETY_STATS_SAMPLE)', sample);
    assert.equal(monthly.target, 25); assert.equal(monthly.reported, 24); assert.equal(monthly.normal, 17);
    assert.equal(monthly.body, 5); assert.equal(monthly.equipment, 4); assert.equal(monthly.issue, 7);
    console.log('PASS: authorized recording upload/playback, retry, failure rollback, STT failure/success, selected/all targets, sample headcounts');
  } finally { await new Promise(resolve => server.close(resolve)); fixture.cleanup(); }
}
module.exports = { createFixture, wavBuffer };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
