// Read-only localhost preview; no application credentials or production data.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const app = express();
const root = path.join(__dirname, '..');
const { createKnowledgeRepository } = require('../safety-knowledge.cjs');
app.get('/risk.html', (req, res) => {
  const html = fs.readFileSync(path.join(root, 'public/risk.html'), 'utf8')
    .replace('boot();', "token='preview-only'; boot();");
  res.type('html').send(html);
});
app.get('/api/me', (req, res) => res.json({ user: { id: 'preview', kind: 'safety_mgr', org: '화면 미리보기', name: '실제 업무 저장 불가' } }));
app.get('/api/risk/state', (req, res) => res.json({ inbox: [], registered: [], processes: [], hazardTypes: {}, threshold: 10 }));
app.get('/api/risk/report-summary', (req, res) => res.json({ total: 0, assessed: 0, highRisk: 0, pending: 0, days: 30, office: '화면 미리보기', generatedAt: new Date().toISOString(), byProc: [], improved: [] }));
app.get('/api/safety-knowledge', async (req, res) => res.json(await createKnowledgeRepository({}).list()));
app.use('/api', (req, res) => res.status(403).json({ error: '화면 미리보기에서는 저장할 수 없습니다.' }));
app.use(express.static(path.join(root, 'public')));
const server = app.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/risk.html`));
