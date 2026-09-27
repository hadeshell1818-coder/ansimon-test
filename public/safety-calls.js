const CallAudio = (() => {
  const maxBytes = 6 * 1024 * 1024;
  const fileTypes = { webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };
  let state = null;
  function field() {
    return `<section class="call-audio"><h3>통화 녹음</h3>
      <p class="sub">입력: 이 기기의 마이크 또는 연결된 녹음 장치. 전화 상대방의 음성은 스피커폰이나 녹음 장치로 입력되어야 합니다.</p>
      <div class="call-audio-tools"><button type="button" class="btn" id="caStart" onclick="CallAudio.start()"><span aria-hidden="true">●</span> 녹음 시작</button>
      <button type="button" class="btn red" id="caStop" onclick="CallAudio.stop()" disabled><span aria-hidden="true">■</span> 녹음 정지</button>
      <label class="btn" for="caFile">녹음 파일 선택</label><input id="caFile" type="file" accept=".webm,.ogg,.m4a,.mp4,.mp3,.wav" onchange="CallAudio.choose(this.files[0]);this.value=''" hidden></div>
      <p id="caStatus" class="sub" role="status">녹음 최대 10분 · 파일당 6MB</p><div id="caPending"></div><div id="caSaved"></div></section>`;
  }
  function mount(call = null) {
    dispose();
    state = { call, requestId: crypto.randomUUID(), blob: null, urls: [], recorder: null, stream: null, busy: false, acquiring: false };
    renderSaved();
    const pending = (call?.recordings || []).find(r => !r.transcript && (!r.transcriptionStatus || r.transcriptionStatus === 'not_started'));
    if (pending) setTimeout(() => {
      const button = document.querySelector(`[data-transcribe="${CSS.escape(pending.id)}"]`);
      if (button && state?.call?.id === call.id) transcribe(pending.id, button);
    }, 0);
  }
  function status(message) { if (document.getElementById('caStatus')) $('caStatus').textContent = message; }
  function controls() {
    if (!state || !document.getElementById('caStart')) return;
    const recording = state.recorder && state.recorder.state !== 'inactive';
    $('caStart').disabled = state.busy || state.acquiring || !!recording;
    $('caStop').disabled = !recording;
    $('caFile').disabled = state.busy || state.acquiring || !!recording;
    $('sheet').querySelectorAll('[data-call-submit]').forEach(button => { button.disabled = state.busy || state.acquiring || !!recording; });
  }
  function url(blob) { const value = URL.createObjectURL(blob); state.urls.push(value); return value; }
  function pending(blob) {
    state.blob = blob; state.recordingRequestId = crypto.randomUUID();
    $('caPending').innerHTML = `<p>저장 전 녹음 · ${(blob.size / 1024 / 1024).toFixed(2)}MB</p><audio controls src="${url(blob)}"></audio>
      <div class="call-audio-tools">${state.call ? '<button class="btn primary" type="button" onclick="CallAudio.save()">녹음 저장</button>' : ''}
      <button class="btn" type="button" onclick="CallAudio.clear()">녹음 취소</button></div>`;
    status('녹음 준비됨 · 재생하여 양쪽 목소리가 들리는지 확인하세요.'); controls();
  }
  async function start() {
    if (!state || state.busy || state.acquiring || state.recorder?.state === 'recording') return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return status('마이크 녹음을 지원하지 않습니다. 녹음 파일을 선택하세요.');
    if (state.blob && !confirm('저장 전 녹음을 새 녹음으로 바꿀까요?')) return;
    const current = state; current.acquiring = true; controls(); status('마이크 권한 확인 중…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (state !== current) { stream.getTracks().forEach(track => track.stop()); return; }
      current.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw Error('지원 가능한 녹음 형식이 없습니다. 녹음 파일을 선택하세요.');
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48000 });
      current.recorder = recorder; current.chunks = []; current.bytes = 0; current.started = Date.now();
      recorder.ondataavailable = event => {
        if (!event.data.size) return;
        current.chunks.push(event.data); current.bytes += event.data.size;
        if (current.bytes > maxBytes - 128 * 1024 && recorder.state === 'recording') recorder.stop();
      };
      recorder.onstop = () => {
        clearInterval(current.timer); stream.getTracks().forEach(track => track.stop());
        if (state !== current) return;
        const blob = new Blob(current.chunks, { type: recorder.mimeType });
        if (blob.size < 500 || blob.size > maxBytes) { status('녹음이 너무 짧거나 6MB를 초과했습니다. 다시 녹음하세요.'); controls(); return; }
        pending(blob);
      };
      recorder.onerror = () => { status('녹음 장치에 오류가 발생했습니다. 저장 전 음성을 재생해 확인하세요.'); stop(); };
      current.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - current.started) / 1000);
        status(`녹음 중 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · 최대 10분`);
        if (seconds >= 600) stop();
      }, 1000);
      recorder.start(1000); status('녹음 중 0:00 · 최대 10분');
    } catch (error) {
      current.stream?.getTracks().forEach(track => track.stop());
      if (state === current) status(error.name === 'NotAllowedError' ? '마이크 권한이 거부되었습니다. 권한을 허용하거나 녹음 파일을 선택하세요.' : error.message);
    } finally { if (state === current) { current.acquiring = false; controls(); } }
  }
  function stop() { if (state?.recorder?.state === 'recording') state.recorder.stop(); }
  function choose(file) {
    if (!file || !state || state.busy || state.acquiring || state.recorder?.state === 'recording') return;
    const type = fileTypes[file.name.split('.').pop().toLowerCase()];
    if (!type) return status('WEBM, OGG, M4A, MP4, MP3, WAV 파일을 선택하세요.');
    if (file.size < 500 || file.size > maxBytes) return status('녹음 파일은 500바이트 이상, 6MB 이하여야 합니다.');
    if (state.blob && !confirm('저장 전 녹음을 선택한 파일로 바꿀까요?')) return;
    pending(new Blob([file], { type }));
  }
  function clear() { if (state && !state.busy) { state.blob = null; $('caPending').innerHTML = ''; status('녹음 최대 10분 · 파일당 6MB'); } }
  function pendingData() {
    if (state?.acquiring || state?.recorder?.state === 'recording') return Promise.reject(Error('녹음을 정지한 다음 저장하세요.'));
    if (!state?.blob) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(Error('녹음을 읽을 수 없습니다.'));
      reader.readAsDataURL(state.blob);
    });
  }
  function renderSaved() {
    if (!state || !document.getElementById('caSaved')) return;
    $('caSaved').innerHTML = (state.call?.recordings || []).map(r => `<article class="call-recording"><div><b>저장된 녹음</b> · ${esc(r.by)} · ${new Date(r.at).toLocaleString('ko-KR')}</div>
      <div class="call-audio-tools"><button class="btn" type="button" onclick="CallAudio.play('${r.id}',this)">녹음 재생</button>
      <button class="btn" type="button" data-transcribe="${r.id}" onclick="CallAudio.transcribe('${r.id}',this)" ${r.transcript ? 'disabled' : ''}>${r.transcript ? '문자 변환 완료' : r.transcriptionStatus === 'unavailable' ? '문자 변환 재시도' : '문자로 변환'}</button></div><div id="caPlayer-${r.id}"></div>
      ${r.transcript ? `<div class="field"><label>문자 변환 결과</label><textarea id="caText-${r.id}" readonly>${esc(r.transcript)}</textarea></div><button class="btn" type="button" onclick="CallAudio.useTranscript('${r.id}')">통화 메모에 반영</button>` : ''}</article>`).join('');
  }
  async function save() {
    if (!state?.call || !state.blob || state.busy) return;
    const current = state; current.busy = true; controls(); status('녹음 저장 중…');
    try {
      const audioBase64 = await pendingData();
      const result = await api('/api/safety/calls/' + encodeURIComponent(current.call.id) + '/recordings', {
        method: 'POST', body: JSON.stringify({ audioBase64, requestId: current.recordingRequestId }),
      });
      rememberCall(result.call); if (state !== current) return;
      current.call = result.call; current.blob = null; $('caPending').innerHTML = ''; renderSaved(); status('녹음 저장 완료 · 문자 변환을 시작합니다.');
      const recording = current.call.recordings.find(r => r.requestId === current.recordingRequestId);
      const button = recording && document.querySelector(`[data-transcribe="${CSS.escape(recording.id)}"]`);
      current.busy = false; controls();
      if (button) await transcribe(recording.id, button);
    } catch (error) { if (state === current) status(error.message); }
    finally { current.busy = false; controls(); }
  }
  async function play(id, button) {
    const current = state, recording = current?.call?.recordings.find(r => r.id === id);
    if (!recording) return;
    button.disabled = true;
    try {
      const response = await fetch(recording.audioUrl, { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) throw Error('녹음을 열지 못했습니다. 로그인 상태와 파일을 확인하세요.');
      const blob = await response.blob(); if (state !== current) return;
      const player = document.createElement('audio'); player.controls = true; player.src = url(blob);
      $('caPlayer-' + id).replaceChildren(player); player.play().catch(() => {});
    } catch (error) { if (state === current) status(error.message); }
    finally { button.disabled = false; }
  }
  async function transcribe(id, button) {
    if (!state || state.busy) return;
    const current = state; current.busy = true; button.disabled = true; controls(); status('녹음을 문자로 변환 중…');
    try {
      const result = await api(`/api/safety/calls/${encodeURIComponent(current.call.id)}/recordings/${encodeURIComponent(id)}/transcribe`, { method: 'POST' });
      rememberCall(result.call); if (state !== current) return;
      current.call = result.call; renderSaved(); status('문자 변환 완료 · 내용을 확인한 후 통화 메모에 반영하세요.');
    } catch (error) { if (state === current) status(error.message); button.disabled = false; }
    finally { current.busy = false; controls(); }
  }
  function useTranscript(id) {
    const text = state?.call?.recordings.find(r => r.id === id)?.transcript;
    if (!text || !document.getElementById('callnote')) return;
    if ($('callnote').value.trim() && !confirm('현재 통화 메모를 문자 변환 결과로 바꿀까요?')) return;
    $('callnote').value = text.slice(0, 3000);
    status(text.length > 3000 ? '메모에 앞 3,000자를 반영했습니다. 알림에 필요한 내용을 정리하세요.' : '통화 메모에 반영했습니다. 내용 확인 후 저장하거나 알림을 작성하세요.');
  }
  function canLeave() {
    if (state?.busy) { toast('저장 또는 문자 변환이 끝날 때까지 기다려주세요.'); return false; }
    return !state || (!state.blob && !state.acquiring && state.recorder?.state !== 'recording') || confirm('저장하지 않은 녹음을 취소하고 닫을까요?');
  }
  function dispose() {
    const previous = state; state = null; if (!previous) return;
    clearInterval(previous.timer); if (previous.recorder?.state === 'recording') previous.recorder.stop();
    previous.stream?.getTracks().forEach(track => track.stop()); previous.urls.forEach(value => URL.revokeObjectURL(value));
  }
  return { field, mount, start, stop, choose, clear, pendingData, save, play, transcribe, useTranscript, canLeave, dispose,
    requestId: () => state?.requestId, saved: () => { if (state) state.blob = null; },
    setBusy: value => { if (state) { state.busy = value; controls(); } },
    hasPending: () => !!state?.blob };
})();
function rememberCall(call) {
  for (const collection of [S, H]) {
    if (!collection?.calls) continue;
    const index = collection.calls.findIndex(c => c.id === call.id);
    if (index >= 0) collection.calls[index] = call;
  }
}
function callSourceLabel(call) {
  return { manual_incoming: '상황실 수신 통화 기록', control_confirm: '관제실 귀국 확인 통화', app_dial: '앱 전화 버튼 요청' }[call.source] || '통화 기록';
}
