const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{chromium}=require('playwright'),{createRobotServer}=require('./robot-server.cjs');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port))),close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
async function protocol(){
 let clock=Date.now();const server=createRobotServer({now:()=>clock,operatorToken:'operator',devices:[{id:'robot-a',token:'device-a'},{id:'robot-b',token:'device-b'}]}),base=await listen(server);
 async function request(action,data,token='operator',device='robot-a'){
  const r=await fetch(base+'/api/robots/'+device+'/'+action,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,body:await r.json()};
 }
 const poll=(boot='boot1',ready=true)=>request('poll',{boot,ready,error:0},'device-a');
 const move={kind:'forward',unit:'m',value:.1};
 try {
  // 1. Проверка авторизации и изоляции устройств
  assert.equal(
    (await request('commands', {commands:[move]}, 'device-a')).status,
    401
  );

  assert.equal(
    (await request('poll', {boot:'b',ready:true}, 'device-a', 'robot-b')).status,
    401
  );

  assert.equal(
    (await request('commands', {commands:[move]})).status,
    409
  );

  const hello = await poll();
  assert.equal(hello.body.command, null);
  const epoch = hello.body.epoch;

  // 2. Проверка валидации команд
  assert.equal(
    (await request('commands', {
      commands:[move,{kind:'forward',value:100,unit:'m'}]
    })).status,
    422
  );

  assert.equal(
    (await request('status')).body.queue.length,
    0,
    'Invalid batches never partially enqueue'
  );

  assert.equal(
    (await request('commands', {
      commands:[{...move,manual:true}]
    })).status,
    422
  );

  assert.equal(
    (await request('commands', {
      commands:[{kind:'loading',value:4,unit:'s'}]
    })).status,
    422
  );

  // 3. Добавление команд и повторная доставка
  const queued = await request('commands', {
    commands:[move,{kind:'right',unit:'deg',value:30}]
  });

  assert.equal(queued.status,201);
  assert.notEqual(queued.body.ids[0],queued.body.ids[1]);

  const command = (await poll()).body.command;
  assert.equal(command.id,queued.body.ids[0]);

  assert.deepEqual(
    (await poll()).body.command,
    command,
    'Unacknowledged delivery keeps same id'
  );

  assert.equal(
    (await request('commands',{commands:[move]})).status,
    409
  );

  // 4. Проверка ACK
  assert.equal(
    (await request('ack',{
      epoch:'old',
      boot:'boot1',
      id:command.id,
      status:'done'
    },'device-a')).status,
    409
  );

  const ack = {
    epoch,
    boot:'boot1',
    id:command.id,
    status:'done'
  };

  assert.equal(
    (await request('ack',ack,'device-a')).status,
    200
  );

  assert.equal(
    (await request('ack',ack,'device-a')).status,
    200
  );

  assert.equal(
    (await poll()).body.command.id,
    queued.body.ids[1]
  );

  assert.equal(
    (await request('ack',{
      ...ack,
      id:queued.body.ids[1],
      status:'failed'
    },'device-a')).status,
    200
  );

  assert.equal(
    (await request('status')).body.queue.length,
    0
  );

  // 5. Перезапуск устройства (смена boot)
  await poll();
  await request('commands',{commands:[move]});

  assert.equal(
    (await poll('boot2')).body.stop,
    true
  );

  assert.equal(
    (await request('status')).body.queue.length,
    0
  );

  assert.equal(
    (await request('commands',{commands:[move]})).status,
    409
  );

  // 6. Операторская остановка
  await poll('boot2');

  const beforeStop = await request('commands',{
    commands:[move]
  });

  console.log('BEFORE STOP:', beforeStop.status, beforeStop.body);
  console.log('PASS: beforeStop');
  assert.equal(
    (await request('stop',{})).status,
    200
  );

  const stopped = await poll('boot2');
  assert.equal(stopped.body.stop,true);

  assert.equal(
    (await request('status')).body.queue.length,
    0
  );

  // 7. Проверка блокировки после STOP
  await poll('boot2',false);

  assert.equal(
    (await request('commands',{commands:[move]})).status,
    409
  );

  // 8. Проверка устаревшего heartbeat
  await poll('boot2');
  clock += 2001;

  assert.equal(
    (await request('commands',{commands:[move]})).status,
    409,
    'Stale device health prevents issuing commands'
  );

  // 9. Восстановление через штатный RESET
  await poll('boot2',true);

  const reset = await request('reset',{confirm:true});
  console.log('RESET RESPONSE:',reset);

  assert.equal(reset.status,200);

  // Следующий heartbeat подтверждает восстановление
  await poll('boot2',true);

  assert.equal(
    (await request('status')).body.fault,
    null
  );

  // 10. Проверка истечения команды
  console.log('STATUS BEFORE EXPIRY TEST:',
  (await request('status')).body);

const issueResult = await request('commands',{
  commands:[move]
});

  console.log('ISSUE RESULT:',issueResult);
  assert.equal(issueResult.status,201);
  console.log('PASS: issueResult');
  assert.equal(
    (await request('status')).body.queue.length,
    1
  );

  await poll('boot2',true);

  let expired;

  for(let i=0;i<15;i++){
    clock += 1000;
    expired = await poll('boot2',true);
  }

  assert.equal(expired.body.stop,true);
assert.equal(expired.body.error,'command_expired');

assert.equal(
  (await request('status')).body.queue.length,
  0
);

// Восстанавливаем устройство после COMMAND_EXPIRED
await poll('boot2',true);

const resetAfterExpiry = await request('reset',{
  confirm:true
});

console.log('RESET AFTER EXPIRY:',resetAfterExpiry);

assert.equal(resetAfterExpiry.status,200);

await poll('boot2',true);

assert.equal(
  (await request('status')).body.fault,
  null
);

// 11. Проверка задержанной доставки
  await poll('boot2',true);

  console.log('STATUS BEFORE DELAYED COMMAND:',
  (await request('status')).body);
  
const delayedCommand = await request('commands',{
  commands:[move]
});
  console.log('PASS: delayedCommand');
console.log('DELAYED COMMAND RESULT:',delayedCommand);

  console.log('DELAYED STATUS:', delayedCommand.status);
console.log('DELAYED BODY:', delayedCommand.body);
console.log('ROBOT STATUS:', (await request('status')).body);
  clock += 1501;

  const delayed = await poll('boot2',true);

  assert.equal(
    delayed.body.stop,
    true,
    'A delayed first delivery cannot start stale motion'
  );

  assert.equal(
    (await request('status')).body.queue.length,
    0
  );

  console.log(
    'PASS device isolation, operator/device auth, structured commands, atomic validation, retry ids, acknowledgements, failure, restart and stop'
  );

} finally {
  await close(server);
}
}
function unzip(data){const files={};let i=0;while(data.readUInt32LE(i)===0x04034b50){const size=data.readUInt32LE(i+18),n=data.readUInt16LE(i+26),e=data.readUInt16LE(i+28),start=i+30+n+e;files[data.subarray(i+30,i+30+n).toString()]=data.subarray(start,start+size).toString();i=start+size;}assert.equal(data.readUInt32LE(i),0x02014b50);return files;}
async function browserTest(){
 const server=http.createServer((req,res)=>{const name=decodeURIComponent(req.url.split('?')[0]).replace(/^\/roi-site\//,''),file=path.resolve('dist',name);if(name==='harness.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="setup.css"><link rel="stylesheet" href="firmware.css"><script src="firmware-ui.js"></script>');return;}if(!file.startsWith(path.resolve('dist')+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/plain');res.end(fs.readFileSync(file));});
 const base=await listen(server),browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/roi-site/harness.html');await page.evaluate(()=>RobotFirmware.open({id:'robot-a',polygon_id:'polygon-a',marker_id:1,name:'Test <script>alert(1)</script>'}));await page.getByText('Проект требует настройки оборудования.',{exact:true}).waitFor();
  assert.equal(await page.locator('.firmware-dialog h2 script').count(),0);await page.getByRole('button',{name:'Исходники',exact:true}).click();assert.match(await page.locator('pre').textContent(),/Arduino-ESP32/);
  await page.getByRole('button',{name:'Сигналы LED',exact:true}).click();assert.equal(await page.locator('.firmware-dialog tr').count(),14);
  await page.getByRole('button',{name:'Подключение',exact:true}).click();await page.locator('[name=ssid]').fill('ssid"\\\nend');await page.locator('[name=password]').fill('private-wifi');await page.locator('[name=token]').fill('device-test-token-private-123456789');
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать проект ESP32 (.zip)',exact:true}).click();const download=await pending,files=unzip(fs.readFileSync(await download.path()));
  assert.equal(Object.keys(files).length,14);assert.match(files['roi_robot/config.h'],/#define DEVICE_ID "robot-a"/);assert.match(files['roi_robot/config.h'],/#define POLYGON_ID "polygon-a"/);assert.match(files['roi_robot/config.h'],/private-wifi/);assert.match(files['roi_robot/config.h'],/\\042\\134/);assert.match(files['roi_robot/hardware.h'],/return false/);assert.equal(files['roi_robot/roi_robot.ino'],fs.readFileSync('firmware/roi_robot.ino','utf8'));assert.match(files['roi_robot/hardware-config.h'],/25,26,27,12/);assert.match(files['roi_robot/indicators.h'],/Adafruit_NeoPixel/);
  for(const [name,text]of Object.entries(files))if(!name.endsWith('config.h'))assert(!text.includes('private-wifi')&&!text.includes('device-test-token-private-123456789'));
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.equal(await page.evaluate(()=>sessionStorage.length),0);
  await page.getByRole('button',{name:'Закрыть',exact:true}).click();await page.evaluate(()=>RobotFirmware.open({id:'robot-b',polygon_id:'polygon-b',marker_id:1,name:'Second robot'}));assert.equal(await page.locator('[name=token]').inputValue(),'');assert.equal(await page.locator('[name=password]').inputValue(),'');
  await page.getByRole('button',{name:'Исходники',exact:true}).click();await page.getByLabel('Файл прошивки').selectOption('config.h');assert.match(await page.locator('pre').textContent(),/#define DEVICE_ID "robot-b"/);
  for(const [width,height]of [[1440,900],[1024,768],[800,600],[480,800],[800,450]]){await page.setViewportSize({width,height});assert(await page.locator('.firmware-dialog').evaluate(e=>e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1));}
  assert.deepEqual(errors,[]);console.log('PASS firmware modal, source viewer, LED table, ZIP source integrity, C++ escaping, UUID isolation, memory-only credentials and responsive dialog');
 }finally{await browser.close();await close(server);}
}
(async()=>{await protocol();await browserTest();})().catch(e=>{console.error(e);process.exitCode=1;});
