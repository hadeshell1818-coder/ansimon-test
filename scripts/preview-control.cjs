// Read-only UI preview. No credentials, production data, recording uploads, or notifications.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const app = express(), root = path.join(__dirname, '..');
const roster = [{ id: 'preview-1', name: '미리보기 직원', zone: 'preview-zone' }];
app.get('/safety.html', (_req, res) => res.type('html').send(
  fs.readFileSync(path.join(root, 'public/safety.html'), 'utf8').replace('boot();', "token='preview-only'; boot(); showTab('stats');")
));
app.get('/api/me', (_req, res) => res.json({ user: { id: 'preview', kind: 'safety', org: '화면 미리보기', name: '저장·발송 없음' } }));
app.get('/api/safety/state', (_req, res) => res.json({ today: '2026-09-24', roster,
  zones: [{ id: 'preview-zone', name: '예시 집배구' }], levels: { urgent: '긴급', caution: '주의', notice: '전달말씀' },
  hazards: [], calls: [], alerts: [], push: { enabled: false } }));
app.get('/api/on/returns', (_req, res) => res.json({ date: '2026-09-24', rows: roster.map(r => ({ ...r, zoneName: '예시 집배구', report: null })),
  summary: { total: 1, absent: 0, target: 1, reported: 0, missing: 1, ok: 0, healthOnly: 0, equipmentOnly: 0, both: 0, selfReported: 0, controlConfirmed: 0 } }));
app.use('/api', (_req, res) => res.status(403).json({ error: '화면 미리보기에서는 실제 조회·저장·발송을 하지 않습니다.' }));
app.use(express.static(path.join(root, 'public')));
const server = app.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/safety.html`));
