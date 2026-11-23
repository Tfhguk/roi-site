'use strict';
/** Local-only robot setup wizard for existing roi-site. Node.js 20+; no npm packages. */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const core=require('./setup-core.cjs');
function validHost(host){return /^(?:127\.0\.0\.1|localhost):\d{2,5}$/.test(host||'');}
function validOrigin(origin,host){return !origin||origin==='http://'+host;}
function guessIps(){return Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal).map(x=>x.address);}
function safeError(s){return String(s||'Unexpected error').slice(0,250);}
async function json(response){const v=await response.json().catch(()=>({}));if(!response.ok)throw Error(v.error_description||v.msg||v.message||v.error||'HTTP '+response.status);return v;}
async function supa(url,key,endpoint,{method='GET',body=null,token=null}={}){
  const response=await fetch(url+endpoint,{method,headers:{apikey:key,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
    ...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12000)});
  return json(response);
}
async function supaSignIn(url,key,email,password){return supa(url,key,'/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});}
async function supaOtpSend(url,key,email){return supa(url,key,'/auth/v1/otp',{method:'POST',body:{email,create_user:false}});}
async function supaOtpVerify(url,key,email,token){return supa(url,key,'/auth/v1/verify',{method:'POST',body:{email,token,type:'email'}});}
function createWizardServer(root,options={}){
  if(!fs.existsSync(path.join(root,'setup.js'))||!fs.existsSync(path.join(root,'firmware','roi_robot.ino')))
    throw Error('Run from the root of installed roi-site, not from inside the patch folder.');
  const local=path.join(root,'local','robot-private.json');
  const cookieKey=crypto.randomBytes(24).toString('base64url');
  let config=core.readJson(local), session=null, project=null, discovered=[],loggedEmail='';
  const defaults=core.detectPublicConfig(root);
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(value));};
    if(!validHost(req.headers.host)||!validOrigin(req.headers.origin,req.headers.host))return send(403,{error:'Only the local setup page may connect.'});
    if(req.method==='GET'&&url.pathname==='/'&&url.searchParams.get('key')===cookieKey){
      res.writeHead(302,{Location:'/',...headers,'Set-Cookie':'roi-wizard='+cookieKey+'; HttpOnly; SameSite=Strict; Path=/'});res.end();return;
    }
    if(req.method==='GET'&&url.pathname==='/'){
      const body=fs.readFileSync(path.join(__dirname,'wizard.html'));
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8',...headers});res.end(body);return;
    }
    if(req.method==='GET'&&url.pathname==='/wizard-ui.js'){
      const body=fs.readFileSync(path.join(__dirname,'wizard-ui.js'));
      res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8',...headers});res.end(body);return;
    }
    const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('roi-wizard='))?.slice(11);
    if(cookie!==cookieKey)return send(401,{error:'Launch the setup link printed in the Windows console.'});
    if(req.method==='GET'&&url.pathname==='/api/state'){
      return send(200,{detected:defaults,cloud:{url:config?.cloud?.url||'',publishableKey:config?.cloud?.publishableKey||''},
        robots:(config?.devices||[]).map(d=>({id:d.id,marker_id:d.marker_id,polygon_id:d.polygon_id||null,configured:true})),
        loggedEmail,connected:!!session, ips:guessIps(), trackerReady:Object.keys(core.readJson(path.join(root,'local','tracker-private.json'))?.anchors||{}).length>=4,
        note:'The entire setup runs on localhost. Passwords and Wi-Fi credentials are never stored.'});
    }
    if(req.method==='GET'&&url.pathname==='/api/robots'){
      if(!session)return send(401,{error:'First log in to Supabase.'});
      try{
        const rows=await supa(project.url,project.key,'/rest/v1/equipment?select=*&limit=500',{token:session.access_token});
        discovered=Array.isArray(rows)?rows:[];
        return send(200,{robots:discovered.map(r=>({id:r.id,name:r.name||r.title||'Без названия',
          marker_id:r.marker_id??r.aruco_id??r.aruco_marker_id??null,
          polygon_id:r.polygon_id??r.arena_id??null}))});
      }catch(e){return send(400,{error:'Cannot load equipment. '+safeError(e.message)});}
    }
    if(req.method==='GET'&&url.pathname==='/api/token'){
      const id=url.searchParams.get('id');const robot=config?.devices?.find(x=>x.id===id);
      if(!robot)return send(404,{error:'Robot not found in local config.'});
      return send(200,{token:robot.token});
    }
    if(req.method!=='POST')return send(404,{error:'Not found'});
    let body={};
    try{
      const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>64*1024)throw Error('Request too large');parts.push(chunk);}
      if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Error('JSON required');
      body=JSON.parse(Buffer.concat(parts).toString('utf8'));
    }catch(e){return send(400,{error:safeError(e.message)});}
    if(url.pathname==='/api/login'||url.pathname==='/api/otp/send'||url.pathname==='/api/otp/verify'){
      const cloudUrl=core.serverUrl(body.url),key=body.key;
      if(!cloudUrl||!core.publicKey(key))return send(422,{error:'Need the project URL and a publishable/legacy anon key, not a secret key.'});
      const email=String(body.email||'').trim();if(!/^.+@.+\..+$/.test(email)||email.length>254)return send(422,{error:'Enter the Supabase account email.'});
      try{
        if(url.pathname==='/api/otp/send'){
          await supaOtpSend(cloudUrl,key,email);
          return send(200,{ok:true,message:'If numeric OTP is configured, check your email. Otherwise use a password login.'});
        }
        const auth=url.pathname==='/api/login'
          ?await supaSignIn(cloudUrl,key,email,String(body.password||''))
          :await supaOtpVerify(cloudUrl,key,email,String(body.otp||''));
        if(!auth.access_token||!auth.refresh_token||!core.uuid(auth.user?.id))throw Error('Auth response did not include a complete session');
        project={url:cloudUrl,key};session=auth;loggedEmail=email;discovered=[];
        return send(200,{ok:true,user:auth.user.email||email});
      }catch(e){return send(401,{error:'Supabase login failed: '+safeError(e.message)});}
    }
    if(url.pathname==='/api/save'){
      try{
        let robots=body.robots;
        if(!Array.isArray(robots)||!robots.length||robots.length>200)throw Error('Select at least one robot.');
        robots=robots.map(r=>({id:r.id,marker_id:r.marker_id,polygon_id:r.polygon_id||null}));
        if(session){
          const allowed=new Set(discovered.map(r=>r.id));
          if(!robots.every(r=>allowed.has(r.id)))throw Error('Robot does not belong to the signed-in user. Reload equipment list.');
        }
        const updated=core.mergeRobots(config,robots);
        if(session){updated.cloud={url:project.url,publishableKey:project.key,refreshToken:session.refresh_token,pollMs:1200};}
        else if(!config?.cloud){delete updated.cloud;}
        // Do not rewrite server data while it is already running on LAN.
        await fetch('http://127.0.0.1:8766/api/health',{signal:AbortSignal.timeout(300)})
          .then(()=>{throw Error('Stop the running robot server before changing its configuration.');})
          .catch(e=>{if(e.message.includes('Stop the running'))throw e;});
        core.saveConfig(root,updated);config=updated;
        return send(200,{ok:true,robots:updated.devices.map(d=>({id:d.id,marker_id:d.marker_id,polygon_id:d.polygon_id||null}))});
      }catch(e){return send(422,{error:safeError(e.message)});}
    }
    if(url.pathname==='/api/firmware'){
      try{
        const d=config?.devices?.find(r=>r.id===body.id);
        const zip=core.firmwareZip(root,d,body);
        res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="roi_robot-'+d.id.slice(0,8)+'.zip"',...headers});
        res.end(zip);return;
      }catch(e){return send(422,{error:safeError(e.message)});}
    }
    return send(404,{error:'Unknown API path'});
  });
  server.setupLink=port=>'http://127.0.0.1:'+port+'/?key='+cookieKey;
  return server;
}
function main(){
  const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
  const server=createWizardServer(root);
  const port=8767;
  server.listen(port,'127.0.0.1',()=>{
    const link=server.setupLink(port);
    console.log('\nROI / НАСТРОЙКА РОБОТОВ\n'+link+'\n');
    console.log('Мастер доступен только с этого компьютера. Не публикуйте ссылку с кодом доступа.');
    if(process.platform==='win32'){
      const child=cp.spawn('cmd.exe',['/c','start','',link],{detached:true,stdio:'ignore',windowsHide:true});
      child.unref();
    }
  });
}
if(require.main===module){try{main();}catch(e){console.error('Setup:',e.message);process.exitCode=1;}}
module.exports={createWizardServer};
