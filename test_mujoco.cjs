// End-to-end test against the local Python server and actual MuJoCo renderer.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],snapshots=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async response=>{if(response.url().endsWith('/api/mujoco')){const data=await response.json();if(data.state)snapshots.push(data.state);else errors.push(data.error);}});
  await page.goto((process.env.MUJOCO_URL||'http://127.0.0.1:8766')+'/truck.html?mujoco=1');
  await page.waitForFunction(()=>document.querySelector('#scene img')?.src.startsWith('data:image/jpeg'));
  assert.match(await page.locator('h1').textContent(),/MuJoCo/);
  const spawn={x:snapshots.at(-1).x,y:snapshots.at(-1).y};
  await page.locator('#speed').selectOption('20');await page.locator('#start').click();
  await page.waitForFunction(()=>parseFloat(document.querySelector('#distance').textContent.replace(',','.'))>.1,{},{timeout:45000});
  await page.locator('#pause').click();await page.waitForTimeout(2000);
  const clock=await page.locator('#clock').textContent();await page.waitForTimeout(700);assert.equal(await page.locator('#clock').textContent(),clock);
  await page.locator('#reset').click();await page.waitForFunction(()=>document.querySelector('#stage').textContent==='Готов к запуску');await page.waitForTimeout(2000);
  assert(Math.abs(snapshots.at(-1).x-spawn.x)<1e-9&&Math.abs(snapshots.at(-1).y-spawn.y)<1e-9,'Reset restores route spawn, not origin');
  assert.equal(snapshots.at(-1).time,0);assert.equal(snapshots.at(-1).payload,0);
  assert(Math.abs(snapshots.at(-1).physicalPosition[0]-spawn.x)<1e-9&&Math.abs(snapshots.at(-1).physicalPosition[1]-spawn.y)<1e-9,'Actual rendered body matches spawn');
  await page.locator('#follow3d').click();await page.waitForTimeout(1500);await page.locator('#overview3d').click();
  await page.locator('#settings').click();await page.locator('[name=initialSoc]').fill('50');await page.locator('#settingsForm button[type=submit]').click();await page.waitForTimeout(2000);assert.equal(snapshots.at(-1).soc,.5);
  const visible=await page.evaluate(async()=>{const image=document.querySelector('#scene img');await image.decode();const c=document.createElement('canvas');c.width=96;c.height=60;const ctx=c.getContext('2d');ctx.drawImage(image,0,0,96,60);const data=ctx.getImageData(0,0,96,60).data;let min=255,max=0;for(let i=0;i<data.length;i+=4){min=Math.min(min,data[i]);max=Math.max(max,data[i]);}return max-min;});assert(visible>40,'Rendered scene remains visible after reset and settings');
  for(const viewport of [{width:1440,height:900},{width:390,height:844},{width:360,height:640}]){
   await page.setViewportSize(viewport);
   assert(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight&&document.documentElement.scrollWidth<=innerWidth),'No page scroll');
  }
  await page.setViewportSize({width:1440,height:900});await page.screenshot({path:'test-output/mujoco-interface.png'});
  assert.deepEqual(errors,[]);console.log('PASS MuJoCo browser: existing controls, real rendered image and physics, pause, reset spawn, camera, settings and responsive layout');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
