const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/report.html', 'utf8');
const elements = { cw: {} };
let tick, payload, fallback = false, finished = false;
Object.defineProperty(elements.cw, 'innerHTML', {
  set(value) {
    this.markup = value;
    for (const id of ['autoInternalNote', 'internalIdleCountdown', 'internalSubmitButton']) {
      if (value.includes(`id="${id}"`)) elements[id] = { value: '', addEventListener() {} };
    }
  },
});
const context = vm.createContext({
  $: id => elements[id], console, Date,
  cur: { requestedInternal: true, internalNote: '</textarea><script>example</script>' },
  me: { region: '장흥군' },
  fileToBase64: async () => 'data:image/jpeg;base64,example',
  captureInternalLocation() { context.cur.lat = 34.68; context.cur.lng = 126.9; context.cur.addr = '장흥로 15'; },
  showManualLocationPicker() { fallback = true; },
  showAutoLocating() { throw Error('Wrong camera branch'); },
  startQuickReport() { throw Error('Unexpected restart'); },
  toast(message) { throw Error(message); },
  setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
  api: async (_, options) => { payload = JSON.parse(options.body); return { report: { id: 'R-test' } }; },
  reportRoutingScreen: async () => { finished = true; },
});
vm.runInContext(html.slice(html.indexOf('async function onQuickPhoto('), html.indexOf('function showAutoLocating(')), context);
vm.runInContext(html.slice(html.indexOf('function showInternalExplanation('), html.indexOf('let routingView=')), context);
(async () => {
  await context.onQuickPhoto({ target: { files: [{}], value: 'photo' } }, true);
  assert.equal(fallback, false, 'Internal camera must render without falling back to address entry');
  assert.equal(elements.autoInternalNote.value, context.cur.internalNote);
  assert(!elements.cw.markup.includes('<script>example</script>'));
  elements.autoInternalNote.value = '';
  vm.runInContext('internalIdleDeadline=0', context);
  tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payload.addr, '장흥로 15');
  assert.equal(payload.lat, 34.68);
  assert.equal(payload.requestedInternal, true);
  assert.equal(payload.internalNote, '');
  assert(finished);
  console.log('PASS: internal camera renders, preserves text safely, auto-submits optional blank note with captured location');
})().catch(error => { console.error(error); process.exitCode = 1; });
