'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const src=fs.existsSync(path.join(__dirname,'local','setup-core.cjs'))?__dirname:path.resolve(__dirname,'..');
const core=require(path.join(src,'local','setup-core.cjs'));
const {createWizardServer}=require(path.join(src,'local','setup-wizard.cjs'));
const {execFileSync}=require('node:child_process');
const id='12345678-1234-4234-8234-123456789abc';
const row={id,marker_id:17,polygon_id:null};
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'roi-wizard-'));
  fs.mkdirSync(path.join(dir,'firmware'));fs.mkdirSync(path.join(dir,'local'));
  fs.writeFileSync(path.join(dir,'setup.js'),'// fixture');
  for(const name of ['roi_robot.ino','hardware.h','hardware-config.h','indicators.h'])
    fs.writeFileSync(path.join(dir,'firmware',name),'// '+name+'\n');
  return dir;
}
test('Generate tokens independently, preserve on re-run and no invented arena',()=>{
  const first=core.mergeRobots(null,[row]);
  assert.ok(first.operatorToken.length>=40&&first.trackerToken.length>=40);
  assert.ok(first.devices[0].token.length>=40);
  assert.notEqual(first.trackerToken,first.operatorToken);
  assert.notEqual(first.devices[0].token,first.operatorToken);
  assert.equal(first.devices[0].model.calibrated,false);
  assert.equal(first.arena,undefined);
  const second=core.mergeRobots(first,[row]);
  assert.equal(second.devices[0].token,first.devices[0].token);
  assert.equal(second.trackerToken,first.trackerToken);
  assert.equal(second.operatorToken,first.operatorToken);
});
test('Only public project keys accepted, rejects secret keys and invalid URLs',()=>{
  const token=r=>{
    const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
    return enc({alg:'HS256'})+'.'+enc({role:r})+'.sig';
  };
  assert.equal(core.publicKey('sb_publishable_1234567890123456'),true);
  assert.equal(core.publicKey('sb_secret_1234567890123456'),false);
  assert.equal(core.publicKey(token('anon')),true);
  assert.equal(core.publicKey(token('service_role')),false);
  assert.equal(core.serverUrl('https://myid.supabase.co'),'https://myid.supabase.co');
  assert.equal(core.serverUrl('http://myid.supabase.co'),null);
  assert.equal(core.serverUrl('https://myid.supabase.co.attacker.com'),null);
});
test('Firmware ZIP config has identical device token and is valid ZIP',()=>{
  const d=fixture();try{
    const robot=core.mergeRobots(null,[row]).devices[0];
    const zip=core.firmwareZip(d,robot,{ssid:'School_2G',password:'secretwifi',host:'192.168.1.20',port:8766});
    const target=path.join(d,'firmware.zip');fs.writeFileSync(target,zip);
    const contents=execFileSync('unzip',['-p',target,'roi_robot/config.h'],{encoding:'utf8'});
    assert.ok(contents.includes('DEVICE_ID "'+id+'"'));
    assert.ok(contents.includes('DEVICE_TOKEN "'+robot.token+'"'));
    assert.ok(contents.includes('SERVER_URL "http://192.168.1.20:8766"'));
    assert.ok(!contents.includes('refreshToken'));
    assert.throws(()=>core.firmwareZip(d,robot,{ssid:'x',password:'y',host:'127.0.0.1'}));
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('Local wizard protects tokens behind launch cookie; saves once',async()=>{
  const root=fixture();
  const server=createWizardServer(root);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    let resp=await fetch(base+'/api/state');assert.equal(resp.status,401);
    resp=await fetch(server.setupLink(server.address().port),{redirect:'manual'});
    assert.equal(resp.status,302);const cookie=resp.headers.get('set-cookie').split(';')[0];
    const request=(p,method='GET',data)=>fetch(base+p,{method,headers:{cookie, ...(data?{'Content-Type':'application/json'}:{})}, ...(data?{body:JSON.stringify(data)}:{})});
    resp=await request('/api/save','POST',{robots:[row]});assert.equal(resp.status,200,await resp.text());
    const token=(await (await request('/api/token?id='+id)).json()).token;
    assert.equal(core.readJson(path.join(root,'local','robot-private.json')).devices[0].token,token);
    assert.equal(core.readJson(path.join(root,'local','tracker-private.json')).trackerToken,
      core.readJson(path.join(root,'local','robot-private.json')).trackerToken);
    resp=await request('/api/save','POST',{robots:[row]});assert.equal(resp.status,200);
    assert.equal(core.readJson(path.join(root,'local','robot-private.json')).devices[0].token,token);
    assert.equal((await request('/api/state')).status,200);
    assert.equal((await fetch(base+'/api/token?id='+id)).status,401);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
test('Dashboard public settings can be prefilled from existing site sources',()=>{
  const dir=fixture();try{
    fs.writeFileSync(path.join(dir,'supabase-config.js'),
      'export const URL="https://robotacademy.supabase.co", KEY="sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAA";');
    const found=core.detectPublicConfig(dir);
    assert.equal(found.url,'https://robotacademy.supabase.co');
    assert.equal(found.publishableKey,'sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAA');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Sign-in creates cloud refresh token privately while device selection is owner-scoped',async()=>{
  const root=fixture(),server=createWizardServer(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const realFetch=global.fetch;
  global.fetch=(url,options)=>{
    const value=String(url);
    if(!value.startsWith('https://robotacademy.supabase.co'))return realFetch(url,options);
    let v;
    if(value.includes('grant_type=password')){
      assert.equal(JSON.parse(options.body).password,'only-in-memory-password');
      v={access_token:'access-token',refresh_token:'refresh-token',user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'teacher@example.org'}};
    }else if(value.includes('/rest/v1/equipment'))v=[{id,marker_id:17,polygon_id:null,name:'Бульдозер'}];
    else throw Error('unexpected request');
    return Promise.resolve({ok:true,json:async()=>v});
  };
  try{
    const resp=await realFetch(server.setupLink(server.address().port),{redirect:'manual'});
    const cookie=resp.headers.get('set-cookie').split(';')[0];
    const call=(p,body)=>realFetch(base+'/api/'+p,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    let r=await call('login',{url:'https://robotacademy.supabase.co',key:'sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAA',
      email:'teacher@example.org',password:'only-in-memory-password'});
    assert.equal(r.status,200,JSON.stringify(await r.json()));
    r=await call('robots');assert.equal(r.status,200);
    assert.equal((await r.json()).robots[0].id,id);
    r=await call('save',{robots:[row]});assert.equal(r.status,200,JSON.stringify(await r.json()));
    const saved=fs.readFileSync(path.join(root,'local','robot-private.json'),'utf8');
    assert.ok(saved.includes('"refreshToken": "refresh-token"'));
    assert.ok(!saved.includes('only-in-memory-password'));
    assert.ok(!saved.includes('access-token'));
    assert.equal(JSON.parse(saved).devices[0].marker_id,17);
    r=await call('save',{robots:[{id:'11111111-1111-4111-8111-111111111111',marker_id:22}]});
    assert.equal(r.status,422,'Cannot add someone else\'s device while signed in');
  } finally {
    global.fetch=realFetch;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});
  }
});
