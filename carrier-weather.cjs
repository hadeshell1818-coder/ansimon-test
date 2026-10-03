const REGIONS = { '장흥군': [34.6816,126.9072], '강진군': [34.6417,126.7672] };
const dayKst = now => new Date(now + 9*3600000).toISOString().slice(0,10);
function createWeatherService(request=fetch, clock=Date.now){
  const cache=new Map(),pending=new Map();
  return async region=>{
    if(!REGIONS[region])throw Error('등록된 근무지역의 날씨 위치가 없습니다.');
    const now=clock(),previous=cache.get(region),date=dayKst(now);
    if(previous&&previous.date===date&&now-previous.saved<15*60000)return {...previous.data,stale:false};
    if(pending.has(region))return pending.get(region);
    const work=(async()=>{
      try{
        const [latitude,longitude]=REGIONS[region];
        const fields='temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m';
        const query=new URLSearchParams({latitude,longitude,current:fields,hourly:fields+',precipitation_probability',timezone:'Asia/Seoul',wind_speed_unit:'ms',forecast_days:'1'});
        const response=await request('https://api.open-meteo.com/v1/forecast?'+query,{signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw Error('날씨 제공기관 응답 오류');
        const raw=await response.json();
        if(!raw.current?.time?.startsWith(date)||!Array.isArray(raw.hourly?.time))throw Error('오늘의 날씨 자료를 확인할 수 없습니다.');
        const number=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
        const point=(source,index)=>({time:index===undefined?source.time:source.time[index],temperature:number(index===undefined?source.temperature_2m:source.temperature_2m?.[index]),feelsLike:number(index===undefined?source.apparent_temperature:source.apparent_temperature?.[index]),humidity:number(index===undefined?source.relative_humidity_2m:source.relative_humidity_2m?.[index]),wind:number(index===undefined?source.wind_speed_10m:source.wind_speed_10m?.[index]),rainChance:number(source.precipitation_probability?.[index]),code:number(index===undefined?source.weather_code:source.weather_code?.[index])});
        const hourly=raw.hourly.time.map((_,i)=>point(raw.hourly,i)).filter(row=>row.time.startsWith(date)).slice(0,24);
        if(!hourly.length)throw Error('시간대별 날씨 자료가 없습니다.');
        const data={region,locationLabel:region+' 중심부 기준',date,current:point(raw.current),hourly,fetchedAt:new Date(now).toISOString(),source:'Open-Meteo',sourceUrl:'https://open-meteo.com/',stale:false};
        cache.set(region,{data,saved:now,date});return data;
      }catch(error){
        if(previous&&previous.date===date&&now-previous.saved<2*3600000)return {...previous.data,stale:true};
        throw Error('날씨를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }finally{pending.delete(region);}
    })();pending.set(region,work);return work;
  };
}
function registerWeatherRoute(app,userFromReq,service=createWeatherService()){
  app.get('/api/carrier/weather',async(req,res)=>{
    const user=userFromReq(req);if(!user)return res.status(401).json({error:'로그인이 필요합니다.'});
    if(user.kind!=='carrier')return res.status(403).json({error:'집배원·직원 계정만 이용할 수 있습니다.'});
    res.set('Cache-Control','no-store');
    try{res.json(await service(user.region));}catch(error){res.status(503).json({error:error.message});}
  });
}
module.exports={createWeatherService,registerWeatherRoute};
