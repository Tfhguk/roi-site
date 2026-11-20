const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const {Simulation,limits}=require('./charging-model.js');

function finish(sim){
  let cv=false,charged=false;
  for(let i=0;i<20000&&sim.active;i++){
    sim.advance(.5);cv ||= sim.mode==='CV';charged ||= sim.current>0;
    assert(sim.q.every((v,j)=>v>=limits[j][0]&&v<=limits[j][1]));
    assert(sim.soc>=sim.config.initialSoc&&sim.soc<=sim.config.targetSoc);
    assert(sim.current>=0&&sim.current<=sim.config.currentA);
    assert(sim.outputVoltage<=4.2001,'Output voltage respects CV limit');
    if(sim.current>0)assert(sim.stage==='charge'&&sim.homed&&sim.contact&&sim.connected);
  }
  assert(!sim.active,'Cycle must reach a terminal state');return {cv,charged};
}
async function run(){
  const sim=new Simulation();sim.start();const {cv,charged}=finish(sim);
  assert.equal(sim.stage,'complete');assert(cv&&charged);assert(Math.abs(sim.soc-.95)<1e-8);
  assert.equal(sim.current,0);assert.equal(sim.contact,false);assert(sim.energyWh>0&&sim.lossWh>0);
  assert.deepEqual(sim.history.map(e=>e.stage),['homing','detect','align','dock','charge','disconnect','undock','return','complete']);
  for(const scenario of ['no-contact','connection','unreachable']){
    const failed=new Simulation({scenario});failed.start();finish(failed);assert.equal(failed.stage,'error');assert.equal(failed.current,0);
    if(scenario!=='connection')assert.equal(failed.soc,failed.config.initialSoc,'No charge before confirmed contact');
    const q=[...failed.q];failed.advance(10);assert.deepEqual(failed.q,q,'Failed mechanism stays still');
  }
  for(const stage of ['homing','align','charge']){
    const stopped=new Simulation();stopped.start();while(stopped.stage!==stage&&stopped.active)stopped.advance(.02);
    assert.equal(stopped.stage,stage);stopped.stop();assert.equal(stopped.current,0);finish(stopped);assert.equal(stopped.stage,'stopped');
  }
  const low=new Simulation({targetSoc:.5});low.start();finish(low);assert.equal(low.stage,'complete');assert(Math.abs(low.soc-.5)<1e-8);
  assert.throws(()=>new Simulation({targetSoc:.2}));assert.throws(()=>new Simulation({capacityAh:NaN}));
  const snapshot=JSON.parse(JSON.stringify(sim.export()));assert(snapshot.synthetic&&snapshot.samples.length&&snapshot.history.length);
  sim.reset();assert.equal(sim.stage,'idle');assert.equal(sim.soc,.35);assert.equal(sim.samples.length,1);
  console.log('PASS: CC/CV, state sequence, current interlocks, faults, stop, limits and reset');

  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  const server=http.createServer((req,res)=>{
    const relative=decodeURIComponent(req.url.split('?')[0]).replace(/^\/roi-site\//,'');
    const file=path.resolve(__dirname,'dist',relative);
    if(!file.startsWith(path.join(__dirname,'dist')+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',mime[path.extname(file)]||'text/plain');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'msedge',headless:true});
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    const base='http://127.0.0.1:'+server.address().port+'/roi-site/';
    await page.goto(base+'charging.html');await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#stage').textContent!==ChargingModel.labels.idle);
    await page.locator('#pause').click();const clock=await page.locator('#clock').textContent();await page.waitForTimeout(150);assert.equal(await page.locator('#clock').textContent(),clock);
    await page.locator('#settings').click();await page.locator('[name=scenario]').selectOption('unreachable');await page.locator('#settingsForm button[type=submit]').click();
    await page.locator('#speed').selectOption('fast');await page.locator('#start').click();
    await page.locator('#toast').waitFor({state:'visible',timeout:20000});assert.equal(await page.locator('#stage').textContent(),await page.evaluate(()=>ChargingModel.labels.error));
    await page.locator('#toast button').click();
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download').click()]);
    assert.equal(download.suggestedFilename(),'charging-test.json');
    await page.locator('#reset').click();assert(await page.locator('#start').isEnabled());
    for(const viewport of [{width:1440,height:900},{width:1280,height:720},{width:390,height:844},{width:360,height:640},{width:844,height:390}]){
      await page.setViewportSize(viewport);
      for(const modal of [null,'settings','help']){
        if(modal)await page.locator('#'+modal).click();
        const size=await page.evaluate(()=>{
          const d=document.querySelector('dialog[open]');const scene=document.querySelector('#scene').getBoundingClientRect();
          const controls=[...document.querySelectorAll('.toolbar button,.toolbar select')].map(el=>el.getBoundingClientRect());
          return {scroll:document.documentElement.scrollHeight>innerHeight||document.documentElement.scrollWidth>innerWidth,dialogScroll:d&&(d.scrollHeight>d.clientHeight+1||d.scrollWidth>d.clientWidth+1),sceneHeight:scene.height,clipped:controls.some(r=>r.bottom>innerHeight||r.right>innerWidth)};
        });
        assert(!size.scroll&&!size.dialogScroll&&!size.clipped,JSON.stringify({viewport,modal,size}));assert(size.sceneHeight>75);
        if(modal==='help'){
          await page.locator('#helpToggle').click();assert(await page.locator('#helpModel').isVisible());
          assert(await page.locator('#helpDialog').evaluate(d=>d.scrollHeight<=d.clientHeight+1));
          await page.locator('#helpToggle').click();
        }
        if(modal)await page.keyboard.press('Escape');
      }
    }
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#settings').click();await page.locator('[name=scenario]').selectOption('normal');await page.locator('#settingsForm button[type=submit]').click();
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#stage').textContent===ChargingModel.labels.charge,{},{timeout:30000});
    fs.mkdirSync(path.join(__dirname,'test-output'),{recursive:true});await page.screenshot({path:path.join(__dirname,'test-output','charging-desktop.png')});
    await page.waitForFunction(()=>document.querySelector('#stage').textContent===ChargingModel.labels.complete,{},{timeout:30000});
    assert.equal(await page.locator('#current').textContent(),'0,00 А');assert.equal(await page.locator('#contact').textContent(),'Нет');
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(__dirname,'test-output','charging-mobile.png')});
    const welcome=fs.readFileSync(path.join(__dirname,'dist','welcome.html'),'utf8');assert(welcome.includes('href="charging.html"'));
    assert.deepEqual(errors,[]);console.log('PASS: browser controls, fault popup, JSON download, /roi-site/ assets and five viewport layouts');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
