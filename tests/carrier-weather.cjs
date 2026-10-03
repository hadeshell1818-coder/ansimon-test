const assert=require('node:assert/strict');
const {createWeatherService,registerWeatherRoute}=require('../carrier-weather.cjs');
async function main(){
 let now=Date.parse('2026-10-04T01:00:00Z'),calls=0,fail=false;
 const payload={current:{time:'2026-10-04T10:00',temperature_2m:21,relative_humidity_2m:70,apparent_temperature:22,weather_code:3,wind_speed_10m:2},hourly:{time:Array.from({length:24},(_,i)=>'2026-10-04T'+String(i).padStart(2,'0')+':00'),temperature_2m:Array(24).fill(21),relative_humidity_2m:Array(24).fill(70),apparent_temperature:Array(24).fill(22),precipitation_probability:Array(24).fill(60)}};
 const service=createWeatherService(async url=>{calls++;assert.equal(new URL(url).searchParams.get('timezone'),'Asia/Seoul');if(fail)throw Error('offline');return{ok:true,json:async()=>payload}},()=>now);
 const first=await service('장흥군');assert.equal(first.hourly.length,24);assert.equal(first.current.humidity,70);assert.equal(first.hourly[0].wind,null);
 await service('장흥군');assert.equal(calls,1);
 now+=16*60000;fail=true;assert.equal((await service('장흥군')).stale,true);
 now=Date.parse('2026-10-04T16:00:00Z');await assert.rejects(service('장흥군'),/날씨를 불러오지/);
 await assert.rejects(service('미등록'),/위치가 없습니다/);
 let route;registerWeatherRoute({get:(_,handler)=>route=handler},req=>req.user,service);
 const res={status(n){this.code=n;return this},json(x){this.body=x;return this},set(){}};
 await route({},res);assert.equal(res.code,401);await route({user:{kind:'control'}},res);assert.equal(res.code,403);
 console.log('PASS: weather units, nulls, cache, stale notice, Korea day rollover, unsupported region and authorization');
}
main().catch(e=>{console.error(e);process.exitCode=1});
