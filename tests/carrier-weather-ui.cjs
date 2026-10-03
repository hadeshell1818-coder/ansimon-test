const assert=require('node:assert/strict'),express=require('express'),path=require('node:path');
const {chromium}=require('playwright');
async function main(){
 const app=express();app.use(express.static(path.join(__dirname,'../public')));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));let browser;
 try{
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const weather={locationLabel:'장흥군 중심부 기준',date:'2026-10-04',current:{time:'2026-10-04T10:00',temperature:22,feelsLike:24,humidity:72,wind:2.3,code:2},hourly:Array.from({length:24},(_,i)=>({time:'2026-10-04T'+String(i).padStart(2,'0')+':00',temperature:18+Math.sin(i/24*Math.PI)*8,feelsLike:19+Math.sin(i/24*Math.PI)*9,humidity:60+i,rainChance:i>=14?70:10})),fetchedAt:'2026-10-04T01:00:00Z'};
  let fail=false;
  await page.route('**/api/**',async route=>{const url=new URL(route.request().url());let data={};if(url.pathname==='/api/me')data={user:{name:'김철수',kind:'carrier',org:'장흥우체국',region:'장흥군'}};if(url.pathname==='/api/on/notices')data={notices:[]};if(url.pathname==='/api/carrier/weather'){if(fail){await route.fulfill({status:503,json:{error:'날씨 연결 실패'}});return}data=weather}await route.fulfill({json:data});});
  await page.addInitScript(()=>localStorage.setItem('cv_token','test'));await page.goto('http://127.0.0.1:'+server.address().port+'/report.html');
  await page.getByText('오늘의 배달 날씨',{exact:true}).waitFor();await page.locator('.weather-now').waitFor();
  assert.equal(await page.getByText('필요한 기능을 바로 선택하세요.').count(),0);assert.match(await page.locator('.weather-now').innerText(),/24°C/);
  await page.getByRole('button',{name:'습도',exact:true}).click();assert.match(await page.locator('#carrier-weather svg').getAttribute('aria-label'),/습도/);
  await page.getByRole('button',{name:'기온·체감',exact:true}).click();await page.locator('#carrier-weather summary').click();assert.equal(await page.locator('.weather-table tbody tr').count(),24);await page.locator('#carrier-weather summary').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(__dirname,'../carrier-weather-preview.png'),fullPage:true});
  fail=true;await page.getByRole('button',{name:'날씨 새로고침'}).click();await page.getByText('날씨 연결 실패',{exact:true}).waitFor();assert.equal(await page.locator('button[onclick*=openReturnReport]').count(),1);
  fail=false;await page.getByRole('button',{name:'다시 시도'}).click();await page.locator('.weather-now').waitFor();assert.deepEqual(errors,[]);
  console.log('PASS: mobile weather, graph switching, hourly details, no overflow, failure/retry and existing functions');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1});
