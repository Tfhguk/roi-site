'use strict';
// Outbound-only Supabase bridge. Never expose a service_role key in the browser or firmware.
const fs=require('node:fs');
const {setTimeout:pause}=require('node:timers/promises');
const {randomUUID}=require('node:crypto');
function startCloudBridge(config,localBase){
  const cloud=config.cloud;
  if(!cloud||!/^https:\/\/[^/?#]+$/.test(cloud.url||'')||!cloud.publishableKey||!cloud.refreshToken){
    throw Error('cloud.url, cloud.publishableKey, cloud.refreshToken are required');
  }
  if(cloud.publishableKey.startsWith('sb_secret_'))throw Error('Do not use Supabase secret/service-role key here');
  const url=cloud.url,ms=Math.max(700,Number(cloud.pollMs)||1500);
  const runs=new Map();let token='',expires=0,userId='';
  async function cloudFetch(endpoint,options={}){
    const headers={apikey:cloud.publishableKey,Authorization:'Bearer '+token,'Content-Type':'application/json',...(options.headers||{})};
    const response=await fetch(url+endpoint,{...options,headers,signal:AbortSignal.timeout(5000)});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw Error('Supabase '+response.status+': '+JSON.stringify(body).slice(0,200));
    return body;
  }
  async function refresh(){
    if(token&&Date.now()+60000<expires)return;
    const result=await fetch(url+'/auth/v1/token?grant_type=refresh_token',{
      method:'POST',headers:{apikey:cloud.publishableKey,'Content-Type':'application/json'},
      body:JSON.stringify({refresh_token:cloud.refreshToken}),signal:AbortSignal.timeout(6000)});
    if(!result.ok)throw Error('Cloud refresh failed: '+result.status);
    const body=await result.json();
    token=body.access_token;cloud.refreshToken=body.refresh_token;expires=Date.now()+body.expires_in*1000;userId=body.user?.id||'';
    if(!userId)throw Error('Cloud user ID unavailable');
    if(config.privateConfigPath){
      const file=config.privateConfigPath,tmp=file+'.'+randomUUID()+'.tmp';
      fs.writeFileSync(tmp,JSON.stringify(config,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);
    }
  }
  async function local(path,method='GET',payload){
    const response=await fetch(localBase+path,{method,headers:{Authorization:'Bearer '+config.operatorToken,'Content-Type':'application/json'},
      ...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(4500)});
    const body=await response.json();
    if(!response.ok)throw Error('Local '+response.status+': '+(body.detail||body.error));
    return body;
  }
  let arenaSynced=false;
  async function syncArenaFromCloud(){
    const polyIds=[...new Set(config.devices.map(d=>d.polygon_id).filter(Boolean))];
    for(const pid of polyIds){
      const rows=await cloudFetch('/rest/v1/polygons?id=eq.'+encodeURIComponent(pid)+'&select=id,geometry,config');
      const polyRow=rows?.[0];
      const pts=polyRow?.geometry?.points;
      if(!Array.isArray(pts)||pts.length<3)continue;
      const scaleM=Number(polyRow?.config?.metresPerUnit)||Number(config.arenaScaleM)||0.002;
      const polygonMeters=pts.map(p=>({
        x:Math.round(p.x*scaleM*10000)/10000,
        y:Math.round(p.y*scaleM*10000)/10000
      }));
      const anchors={};
      for(let i=0;i<pts.length;i++){
        const mid=pts[i].markerId??pts[i].marker_id;
        if(Number.isInteger(mid)&&mid>=0)anchors[String(mid)]=[polygonMeters[i].x,polygonMeters[i].y];
      }
      await local('/api/arena','POST',{polygon_id:pid,polygon:polygonMeters,anchors});
      console.log('[cloud] arena & anchors synced for',pid,'anchors:',Object.keys(anchors).length);
      arenaSynced=true;
    }
  }
  async function patch(job,status,details){
    const q='/rest/v1/robot_jobs?id=eq.'+encodeURIComponent(job.id)+'&status=eq.'+encodeURIComponent(job.status);
    const rows=await cloudFetch(q,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({status,details:details||null,updated_at:new Date().toISOString()})});
    if(!Array.isArray(rows)||rows.length!==1)return false;
    job.status=status;return true;
  }
  async function processJob(job){
    if(!await patch(job,'claimed'))return;
    const id=encodeURIComponent(job.robot_id),p=job.payload||{};
    try{
      let result,reference;
      if(p.action==='STOP'){result=await local('/api/robots/'+id+'/stop','POST',{});reference=null;}
      else if(p.action==='MOVE_TO'||p.action==='DUMP'){
        result=await local('/api/robots/'+id+'/mission','POST',p);reference=result.mission_id;
      }else if(p.action==='DRIVE'){
        result=await local('/api/robots/'+id+'/commands','POST',{commands:[p.command]});reference=result.ids?.[0];
      }else if(p.action==='MANUAL_ENABLE'){
        result=await local('/api/robots/'+id+'/manual','POST',{action:'enable',confirm:p.confirm===true});reference=null;
      }else if(p.action==='MANUAL_DRIVE'){
        result=await local('/api/robots/'+id+'/manual','POST',{action:'drive',command:p.command});reference=result.id;
      }else if(p.action==='RESET'){
        result=await local('/api/robots/'+id+'/reset','POST',{confirm:p.confirm===true});reference=null;
      }else throw Error('Unsupported action');
      if(reference){runs.set(job.id,{robot:job.robot_id,reference,job});await patch(job,'queued',{reference});}
      else await patch(job,'done',{ok:true});
    }catch(e){await patch(job,'failed',{error:String(e.message).slice(0,250)});}
  }
  async function syncStatus(){
    for(const device of config.devices){
      let status;
      try{status=await local('/api/robots/'+encodeURIComponent(device.id)+'/status');}catch{continue;}
      await cloudFetch('/rest/v1/robot_states?on_conflict=robot_id',{
        method:'POST',headers:{Prefer:'resolution=merge-duplicates'},
        body:JSON.stringify({robot_id:device.id,user_id:userId,mode:status.mode,
          battery_v:status.health?.battery_v??null,pose:status.pose??null,fault:status.fault??null,
          last_seen:status.health?.seen_at?new Date(status.health.seen_at).toISOString():null,
          updated_at:new Date().toISOString()})});
      for(const [id,run]of Array.from(runs)){
        if(run.robot!==device.id)continue;
        const done=status.history?.find(x=>(x.id===run.reference||x.mission_id===run.reference));
        const bad=status.fault&&!done;
        if(!done&&!bad)continue;
        try{await patch(run.job,done&&done.status==='done'?'done':'failed',done||{error:status.fault.code});runs.delete(id);}catch(e){console.error('[cloud] status sync',e.message);}
      }
    }
  }
  (async()=>{
    console.log('[cloud] outbound polling started');
    let tick=0;
    for(;;){
      try{
        await refresh();
        if(!arenaSynced||tick%15===0)await syncArenaFromCloud();
        const rows=await cloudFetch('/rest/v1/robot_jobs?status=eq.pending&select=*&order=created_at.asc&limit=25');
        rows.sort((a,b)=>(b.payload?.action==='STOP')-(a.payload?.action==='STOP'));
        for(const job of rows){if(!config.devices.some(d=>d.id===job.robot_id))continue;await processJob(job);}
        if(tick++%2===0)await syncStatus();
      }catch(e){console.error('[cloud] '+String(e.message).slice(0,180));}
      await pause(ms);
    }
  })();
}
module.exports={startCloudBridge};
