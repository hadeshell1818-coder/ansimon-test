window.CarrierWeather=(()=>{
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const value=(n,unit)=>Number.isFinite(n)?Math.round(n*10)/10+unit:'—';
  let mode='temperature',data=null;
  function miniChart(d){
    const rows=d.hourly.filter(r=>Number(r.time.slice(11,13))>=6&&Number(r.time.slice(11,13))<=18);
    const values=rows.flatMap(r=>[r.temperature,r.feelsLike]).filter(Number.isFinite);
    if(!values.length)return '<small>그래프 자료 없음</small>';
    const low=Math.min(...values)-2,high=Math.max(...values)+2,x=i=>3+i*139/Math.max(1,rows.length-1),y=n=>39-(n-low)*34/(high-low);
    const path=key=>{let gap=true;return rows.map((r,i)=>{if(!Number.isFinite(r[key])){gap=true;return '';}const cmd=gap?'M':'L';gap=false;return cmd+x(i)+' '+y(r[key]);}).join(' ')};
    return '<svg viewBox="0 0 145 55" role="img" aria-label="06시부터 18시까지 기온과 체감온도 변화"><line x1="3" x2="142" y1="40" y2="40" stroke="#cbdfe9"/><path d="'+path('temperature')+'" stroke="#2668a5" stroke-width="2.3" fill="none"/><path d="'+path('feelsLike')+'" stroke="#ad5b25" stroke-width="2.3" fill="none"/><text x="3" y="53">06시</text><text x="64" y="53">12시</text><text x="123" y="53">18시</text></svg><div class="weather-mini-legend"><span>● 기온</span><span>● 체감</span></div>';
  }
  function chart(d){
    const rows=d.hourly,humidity=mode==='humidity',series=humidity?[{key:'humidity',color:'#287c78'}]:[{key:'temperature',color:'#2668a5'},{key:'feelsLike',color:'#ad5b25'}];
    const values=rows.flatMap(row=>series.map(s=>row[s.key])).filter(Number.isFinite);
    if(!values.length)return '<p>그래프 자료가 없습니다.</p>';
    const low=humidity?0:Math.floor(Math.min(...values)-2),high=humidity?100:Math.ceil(Math.max(...values)+2),x=i=>32+i*292/Math.max(1,rows.length-1),y=n=>112-(n-low)*88/(high-low);
    const grid=[low,(low+high)/2,high].map(n=>'<line x1="32" x2="324" y1="'+y(n)+'" y2="'+y(n)+'" stroke="#cddfe8"/><text x="27" y="'+(y(n)+3)+'" text-anchor="end">'+Math.round(n)+(humidity?'%':'°')+'</text>').join('');
    const path=s=>{let gap=true;return rows.map((row,i)=>{const n=row[s.key];if(!Number.isFinite(n)){gap=true;return '';}const cmd=gap?'M':'L';gap=false;return cmd+x(i)+' '+y(n)}).join(' ')};
    const currentHour=Number(d.current.time.slice(11,13));
    return '<svg viewBox="0 0 340 140" role="img" aria-label="오늘 시간대별 '+(humidity?'습도':'기온과 체감온도')+' 예보">'+grid+'<rect x="'+x(8)+'" y="20" width="'+(x(18)-x(8))+'" height="92" fill="#d8eae5" opacity=".45"/>'+series.map(s=>'<path d="'+path(s)+'" fill="none" stroke="'+s.color+'" stroke-width="2.5" stroke-linejoin="round"/>').join('')+(currentHour<rows.length?'<line x1="'+x(currentHour)+'" x2="'+x(currentHour)+'" y1="20" y2="112" stroke="#476578" stroke-dasharray="3 3"/>':'')+[0,6,12,18,23].filter(i=>i<rows.length).map(i=>'<text x="'+x(i)+'" y="132" text-anchor="middle">'+rows[i].time.slice(11,13)+'시</text>').join('')+'</svg><div class="weather-legend">'+(humidity?'● 습도 (%)':'<span>● 기온</span><span>● 체감온도</span>')+'<small>음영 08~18시 · 점선 현재 시간대</small></div>';
  }
  function condition(code){if(code===0)return '☀️ 맑음';if(code<=3&&code!==null)return '⛅ 구름';if([45,48].includes(code))return '🌫️ 안개';if([71,73,75,77,85,86].includes(code))return '❄️ 눈';if(code>=95)return '⛈️ 뇌우';if(code>=51)return '🌧️ 비';return '날씨'}
  function render(host){
    const expanded=host.querySelector('.weather-expanded')?.open||false;
    const d=data,c=d.current,working=d.hourly.filter(r=>Number(r.time.slice(11,13))>=Math.max(8,Number(c.time.slice(11,13)))&&Number(r.time.slice(11,13))<=18),rain=working.filter(r=>r.rainChance>=60),hints=[];
    if(rain.length)hints.push(rain[0].time.slice(11,13)+'시부터 강수확률이 높아요. 우의와 방수 준비를 확인하세요.');
    if(working.some(r=>r.feelsLike>=30))hints.push('더운 시간대에는 물과 휴식 여건을 확인하세요.');
    if(working.some(r=>r.feelsLike<=0))hints.push('방한 준비와 노면 상태를 확인하세요.');
    if(working.some(r=>r.wind>=8))hints.push('바람이 강한 시간대, 이륜차 운행과 적재물에 주의하세요.');
    const shortHint=d.stale?'갱신 지연 · 이전 예보':rain.length?rain[0].time.slice(11,13)+'시부터 강수확률 높음':working.some(r=>r.feelsLike>=30)?'더운 시간대, 물·휴식 준비':working.some(r=>r.feelsLike<=0)?'추운 시간대, 방한 준비':working.some(r=>r.wind>=8)?'강한 바람, 운행 주의':'시간대별 예보 확인';
    const table='<div class="weather-table"><table><thead><tr><th>시각</th><th>기온</th><th>체감</th><th>습도</th><th>강수확률</th></tr></thead><tbody>'+d.hourly.map(r=>'<tr><td>'+esc(r.time.slice(11,16))+'</td><td>'+value(r.temperature,'°')+'</td><td>'+value(r.feelsLike,'°')+'</td><td>'+value(r.humidity,'%')+'</td><td>'+value(r.rainChance,'%')+'</td></tr>').join('')+'</tbody></table></div>';
    host.innerHTML='<div class="weather-title"><b>오늘의 배달 날씨</b><span class="weather-place">'+esc(d.region||d.locationLabel.replace(' 중심부 기준',''))+' · 중심부</span></div><div class="weather-compact-main"><div class="weather-compact-now"><div class="weather-reading"><strong>'+value(c.temperature,'°')+'</strong><b>체감 '+value(c.feelsLike,'°C')+'</b></div><div class="weather-condition">'+condition(c.code)+' · 습도 '+value(c.humidity,'%')+'</div></div><div class="weather-mini">'+miniChart(d)+'</div></div><details class="weather-expanded" '+(expanded?'open':'')+'><summary><span class="weather-short-hint">'+esc(shortHint)+'</span><span class="weather-expand-label"><span class="when-closed">상세 펼치기 ⌄</span><span class="when-open">상세 접기 ⌃</span></span></summary><div class="weather-detail"><div class="weather-detail-meta">'+esc(d.locationLabel)+' · '+esc(d.date)+'<button type="button" data-weather="refresh" aria-label="날씨 새로고침">↻</button></div><div class="weather-metrics"><span>바람 <b>'+value(c.wind,'m/s')+'</b></span><span>현재 시간 강수 <b>'+value(d.hourly.find(r=>r.time.slice(0,13)===c.time.slice(0,13))?.rainChance,'%')+'</b></span></div><p class="weather-tip">'+esc(hints.slice(0,2).join(' ')||'출발 전 시간대별 날씨와 현장 노면 상태를 확인하세요.')+'</p><div class="weather-tabs"><button data-weather="temperature" aria-pressed="'+(mode==='temperature')+'">기온·체감</button><button data-weather="humidity" aria-pressed="'+(mode==='humidity')+'">습도</button></div><div class="weather-full-chart">'+chart(d)+'</div><details class="weather-hourly"><summary>하루 시간대별 상세 예보</summary>'+table+'</details><div class="weather-source">'+(d.stale?'최근 갱신 실패 · 이전 예보 표시<br>':'')+'현재값도 모델 추정 · 예보 '+esc(c.time.slice(11,16))+' 기준<br>갱신 '+new Date(d.fetchedAt).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'})+' · <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a></div></div></details>';
  }
  async function mount(api){
    const host=document.getElementById('carrier-weather');if(!host)return;
    host.innerHTML='<b>오늘의 배달 날씨</b><p>날씨를 불러오는 중…</p>';
    const refresh=async()=>{host.setAttribute('aria-busy','true');try{const result=await api('/api/carrier/weather');if(document.getElementById('carrier-weather')!==host)return;data=result;render(host);}catch(error){if(document.getElementById('carrier-weather')===host)host.innerHTML='<b>오늘의 배달 날씨</b><p>'+esc(error.message||'날씨를 불러오지 못했습니다.')+'</p><button data-weather="refresh">다시 시도</button>';}finally{host.setAttribute('aria-busy','false');}};
    host.onclick=event=>{const button=event.target.closest('button[data-weather]');if(!button)return;if(button.dataset.weather==='refresh'){if(host.getAttribute('aria-busy')!=='true')refresh();}else{mode=button.dataset.weather;render(host);}};
    await refresh();
  }
  return {mount};
})();
