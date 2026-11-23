'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {makeZip}=require('./zip-safe.cjs');
const uuidRX=/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const randomToken=()=>crypto.randomBytes(32).toString('base64url');
const unique=(items)=>[...new Set(items)];
const uuid=x=>typeof x==='string'&&uuidRX.test(x);
const serverUrl=s=>{try{const u=new URL(s);return u.protocol==='https:'&&u.hostname.endsWith('.supabase.co')&&!u.username&&!u.password&&!u.port&&!u.pathname.replace(/\//g,'')&&!u.search&&!u.hash?u.origin:null;}catch{return null;}};
function publicKey(key){
  if(typeof key!=='string')return false;
  if(/^sb_publishable_[a-zA-Z0-9_-]{12,}$/.test(key))return true;
  // Legacy public anon JWT, reject service_role and user JWTs.
  if(!key.startsWith('eyJ')||key.split('.').length!==3)return false;
  try{return JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString('utf8')).role==='anon';}catch{return false;}
}
function detectPublicConfig(root){
  const candidates=unique([root, path.join(root,'src'),path.join(root,'public')]);
  let all='';
  for(const dir of candidates){if(!fs.existsSync(dir))continue;
    for(const file of fs.readdirSync(dir)){
      if(!/\.(?:js|html|json|env|ts)$/i.test(file)||/private|secret|service|backup/i.test(file))continue;
      const f=path.join(dir,file);if(!fs.statSync(f).isFile()||fs.statSync(f).size>1024*1024)continue;
      all+='\n'+fs.readFileSync(f,'utf8');
    }
  }
  const url=(all.match(/https:\/\/[\w-]+\.supabase\.co/g)||[]).find(x=>!!serverUrl(x))||'';
  const key=(all.match(/sb_publishable_[A-Za-z0-9_-]{12,}/g)||[]).find(publicKey)||'';
  const anon=(all.match(/eyJ[A-Za-z0-9_-]{80,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)||[]).find(publicKey)||'';
  return {url,publishableKey:key||anon};
}
function baseConfig(existing){
  const c=existing&&typeof existing==='object'?structuredClone(existing):{};
  if(!c.operatorToken||/^REPLACE_/.test(c.operatorToken))c.operatorToken=randomToken();
  if(!c.trackerToken||/^REPLACE_/.test(c.trackerToken))c.trackerToken=randomToken();
  if(!c.stateDir)c.stateDir='./robot-runtime';
  // Deliberately do not invent arena coordinates. Dispatcher blocks all motion until calibrated.
  if(!Array.isArray(c.devices))c.devices=[];
  return c;
}
function deviceFromRow(row,existing){
  if(!uuid(row.id))throw Error('Invalid robot UUID');
  const marker=Number(row.marker_id);
  if(!Number.isSafeInteger(marker)||marker<0||marker>9999)throw Error('Invalid ArUco marker number for '+row.id);
  const polygonId=row.polygon_id||null;
  if(polygonId&&!uuid(polygonId))throw Error('Invalid polygon UUID');
  const device=existing?structuredClone(existing):{};
  device.id=row.id;device.polygon_id=polygonId;device.marker_id=marker;
  if(!device.token||/^REPLACE_/.test(device.token))device.token=randomToken();
  if(!Number.isFinite(device.minBatteryVoltage))device.minBatteryVoltage=6.6;
  if(!Number.isFinite(device.maxBatteryVoltage))device.maxBatteryVoltage=8.5;
  device.model={calibrated:false,linear_m_s:0.1,track_width_m:0.15,wheel_radius_m:0.03,max_wheel_rad_s:15,
    angular_rad_s:0.6,robot_radius_m:0.10,max_step_m:0.08,max_turn_rad:0.4,
    model_tolerance_m:0.12,model_tolerance_rad:0.65,...(device.model||{})};
  return device;
}
function mergeRobots(existing,robots){
  const c=baseConfig(existing);
  const previous=new Map(c.devices.map(d=>[d.id,d]));
  const seen=new Set();
  for(const row of robots){if(seen.has(row.id))throw Error('Repeated robot UUID');seen.add(row.id);
    previous.set(row.id,deviceFromRow(row,previous.get(row.id)));
  }
  c.devices=Array.from(previous.values());return c;
}
function trackerConfig(robotConfig,existing){
  const c=existing?structuredClone(existing):{};
  c.camera??=0;c.server??='http://127.0.0.1:8766';c.dictionary??='DICT_4X4_50';
  c.trackerToken=robotConfig.trackerToken;
  c.anchors??={}; // calibrated anchors must be measured by user
  c.robots=robotConfig.devices.map(r=>({id:r.id,polygon_id:r.polygon_id,marker_id:r.marker_id,yaw_offset_deg:
    (existing?.robots||[]).find(x=>x.id===r.id)?.yaw_offset_deg??90}));
  return c;
}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function atomicJson(file,data){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});
  try{fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  try{fs.chmodSync(file,0o600);}catch{}
}
function saveConfig(root,config){
  const filename=path.join(root,'local','robot-private.json');
  const tracker=path.join(root,'local','tracker-private.json');
  const old=readJson(tracker);
  if(fs.existsSync(filename))fs.copyFileSync(filename,filename+'.backup');
  if(fs.existsSync(tracker))fs.copyFileSync(tracker,tracker+'.backup');
  atomicJson(filename,config);atomicJson(tracker,trackerConfig(config,old));
  return {filename,tracker};
}
function firmwareZip(root,device,wifi){
  if(!device||!uuid(device.id)||!device.token)throw Error('Robot is not set up');
  const ssid=String(wifi?.ssid||''),password=String(wifi?.password||'');
  if(!ssid||ssid.length>32||password.length>63)throw Error('Wi-Fi SSID/password invalid');
  const ip=String(wifi?.host||'').trim();
  if(!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)||ip.split('.').some(x=>Number(x)>255))throw Error('Enter a valid IPv4 address of the local computer');
  if(ip.startsWith('127.'))throw Error('127.0.0.1 is not the local computer address for ESP32');
  const port=Number(wifi?.port||8766);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('Invalid server port');
  const escaped=x=>JSON.stringify(String(x));
  const header=`#pragma once\n// Generated locally. Never publish this file or firmware ZIP.\n#define WIFI_SSID ${escaped(ssid)}\n#define WIFI_PASSWORD ${escaped(password)}\n#define SERVER_URL ${escaped('http://'+ip+':'+port)}\n#define DEVICE_ID ${escaped(device.id)}\n#define DEVICE_TOKEN ${escaped(device.token)}\n`;
  const sources=['roi_robot.ino','hardware.h','hardware-config.h','indicators.h'];
  const contents={'roi_robot/config.h':header};
  for(const name of sources){const file=path.join(root,'firmware',name);
    if(!fs.existsSync(file))throw Error('Missing firmware source '+name);
    contents['roi_robot/'+name]=fs.readFileSync(file);
  }
  return makeZip(contents);
}
module.exports={uuid,randomToken,serverUrl,publicKey,detectPublicConfig,baseConfig,deviceFromRow,mergeRobots,trackerConfig,readJson,saveConfig,firmwareZip};
