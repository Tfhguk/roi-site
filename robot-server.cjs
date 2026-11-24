'use strict';
// Local fail-closed dispatcher for roi-site. Built-in Node.js modules only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const equal = (a,b) => typeof a === 'string' && typeof b === 'string' &&
  crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
const number = v => typeof v === 'number' && Number.isFinite(v);
const round = (v,n=5) => Math.round(v * 10**n) / 10**n;
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const wrap = a => Math.atan2(Math.sin(a),Math.cos(a));
const uuid = () => crypto.randomUUID();
const fsId = s => /^[a-zA-Z0-9_-]{1,100}$/.test(s) ? s : crypto.createHash('sha256').update(s).digest('hex');

function atomic(file,data){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp = file+'.'+process.pid+'.'+uuid()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});
  fs.renameSync(tmp,file);
}
function contains(p,polygon){
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];
    if(((a.y>p.y)!==(b.y>p.y)) && p.x < (b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
  }
  return inside;
}
function segmentDistance(p,a,b){
  const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
  const t=den?clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/den,0,1):0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
function signedBoundaryDistance(p,poly){
  let d=Infinity;
  for(let i=0;i<poly.length;i++) d=Math.min(d,segmentDistance(p,poly[i],poly[(i+1)%poly.length]));
  return contains(p,poly)?d:-d;
}
function validPolygon(poly){
  return Array.isArray(poly) && poly.length>=3 && poly.length<=100 && poly.every(p=>p&&number(p.x)&&number(p.y));
}
function validPose(p){return !!p&&number(p.x)&&number(p.y)&&number(p.heading)&&Math.abs(p.heading)<=Math.PI*4;}
function makeModel(device){
  const m=device.model||{};
  const pick=(field,def,min,max)=>number(m[field])&&m[field]>=min&&m[field]<=max?m[field]:def;
  return {calibrated:m.calibrated===true,linear_m_s:pick('linear_m_s',0.10,0.01,1),angular_rad_s:pick('angular_rad_s',0.6,0.05,6),
    track_width_m:pick('track_width_m',0.15,0.04,2),wheel_radius_m:pick('wheel_radius_m',0.03,0.005,0.5),
    max_wheel_rad_s:pick('max_wheel_rad_s',15,0.1,200),
    robot_radius_m:pick('robot_radius_m',0.08,0.01,1),max_step_m:pick('max_step_m',0.10,0.01,0.25),
    max_turn_rad:pick('max_turn_rad',Math.PI/4,0.05,Math.PI/4),
    model_tolerance_m:pick('model_tolerance_m',0.12,0.01,1),model_tolerance_rad:pick('model_tolerance_rad',0.65,0.01,Math.PI)};
}

function createRobotServer(config){
  if(!config||!config.operatorToken||!Array.isArray(config.devices)||!config.devices.length) throw Error('Invalid operator/devices config');
  const now=config.now||Date.now, epoch=uuid(), stateDir=config.stateDir||null;
  const devices=new Map();
  const arenas=new Map();
  let arenaZones=[];
  let elevationGrid=null;

  for(const d of config.devices){
    if(!d.id||!d.token||devices.has(d.id))throw Error('Duplicate or invalid device');
    const model=makeModel(d),poly=d.arena?.polygon || config.arena?.polygon || null;
    if(poly&&!validPolygon(poly))throw Error('Invalid arena polygon for '+d.id);
    if(poly && d.polygon_id && !arenas.has(d.polygon_id)){
      arenas.set(d.polygon_id, { polygon: poly, anchors: d.arena?.anchors || config.arena?.anchors || {} });
    }
    const device={...d,model,polygon:poly,queue:[],history:[],boot:null,health:null,
      pose:null,stop:null,mode:'READY',fault:null,mission:null,waypoints:[],manual:false,resume:false,recoveryPending:false,awaitingPose:null,issued:null,
      stallCheck:null,seenAt:0,lastBattery:null};
    devices.set(d.id,device);
  }

  async function refreshElevationFromAR(){
    try{
      const r=await fetch('http://127.0.0.1:8765/api/v1/depth?cols=40&rows=28',{signal:AbortSignal.timeout(800)});
      if(r.ok)elevationGrid=await r.json();
    }catch{}
  }

  function pointInTransportZones(p){
    if(!p)return true;
    const tZones=arenaZones.filter(z=>z.kind==='transport'&&validPolygon(z.points));
    if(!tZones.length)return true;
    return tZones.some(z=>signedBoundaryDistance(p,z.points)>=0);
  }

  // Построение траектории A* с весами: 50% длина пути + 50% перепад высот
  function planWeightedRoute(startM,goalM,polygonM,lengthWeight=0.5,elevationWeight=0.5){
    const cols=elevationGrid?.cols||40;
    const rows=elevationGrid?.rows||28;
    const xs=polygonM.map(p=>p.x),ys=polygonM.map(p=>p.y);
    const minX=Math.min(...xs),maxX=Math.max(...xs);
    const minY=Math.min(...ys),maxY=Math.max(...ys);
    const w=Math.max(0.2,maxX-minX),h=Math.max(0.2,maxY-minY);

    const toCell=p=>({
      c:clamp(Math.floor(((p.x-minX)/w)*cols),0,cols-1),
      r:clamp(Math.floor(((p.y-minY)/h)*rows),0,rows-1)
    });
    const toWorld=(c,r)=>({
      x:round(minX+((c+0.5)/cols)*w,4),
      y:round(minY+((r+0.5)/rows)*h,4)
    });
    const cellHeight=(c,r)=>{
      if(!elevationGrid?.cells)return 0;
      const v=elevationGrid.cells[r*cols+c];
      return v===null||v===undefined?Infinity:Number(v);
    };

    const s=toCell(startM),g=toCell(goalM);
    const key=(c,r)=>`${c},${r}`;
    const open=[{c:s.c,r:s.r,g:0,f:0}];
    const gScore=new Map([[key(s.c,s.r),0]]);
    const cameFrom=new Map();
    const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

    while(open.length){
      open.sort((a,b)=>a.f-b.f);
      const cur=open.shift();
      if(cur.c===g.c&&cur.r===g.r){
        const path=[];
        let k=key(cur.c,cur.r);
        while(cameFrom.has(k)){
          const [cc,rr]=k.split(',').map(Number);
          path.push(toWorld(cc,rr));
          k=cameFrom.get(k);
        }
        path.reverse();
        return path.length?path:[goalM];
      }
      const hCur=cellHeight(cur.c,cur.r);
      for(const [dc,dr] of dirs){
        const nc=cur.c+dc,nr=cur.r+dr;
        if(nc<0||nr<0||nc>=cols||nr>=rows)continue;
        const hNext=cellHeight(nc,nr);
        if(!Number.isFinite(hNext))continue;
        const pt=toWorld(nc,nr);
        if(!contains(pt,polygonM)||!pointInTransportZones(pt))continue;

        const stepLen=Math.hypot(dc*(w/cols),dr*(h/rows));
        const deltaH=Math.abs(hNext-hCur);
        const stepCost=lengthWeight*stepLen+elevationWeight*deltaH;
        const tentative=cur.g+stepCost;
        const nk=key(nc,nr);
        if(tentative<(gScore.get(nk)??Infinity)){
          cameFrom.set(nk,key(cur.c,cur.r));
          gScore.set(nk,tentative);
          const heur=lengthWeight*Math.hypot((g.c-nc)*(w/cols),(g.r-nr)*(h/rows));
          open.push({c:nc,r:nr,g:tentative,f:tentative+heur});
        }
      }
    }
    return [goalM];
  }

  function dir(d){return stateDir&&path.join(stateDir,'robots',fsId(d.id));}
  function persist(d){
    if(!stateDir)return;
    const root=dir(d);
    atomic(path.join(root,'commands.json'),{epoch,queue:d.queue,mission:d.mission,waypoints:d.waypoints,updated_at:now()});
    atomic(path.join(root,'state.json'),{id:d.id,polygon_id:d.polygon_id||null,marker_id:d.marker_id??null,
      mode:d.mode,fault:d.fault,stop_pending:!!d.stop,boot:d.boot,pose:d.pose,issued:d.issued,updated_at:now()});
    atomic(path.join(root,'telemetry.json'),{health:d.health,battery_v:d.lastBattery,updated_at:now()});
  }
  function log(d,event){if(!stateDir)return;fs.mkdirSync(dir(d),{recursive:true});fs.appendFileSync(path.join(dir(d),'errors.jsonl'),JSON.stringify({at:now(),...event})+'\n',{mode:0o600});}
  function stop(d,code,message,manual=false){
    d.queue=[];d.mission=null;d.waypoints=[];d.issued=null;d.awaitingPose=null;d.stallCheck=null;d.stop=uuid();
    d.mode=manual?'MANUAL_REQUIRED':'EMERGENCY_STOP';d.manual=false;d.resume=false;d.recoveryPending=false;
    if(!d.fault || d.fault.code!==code){d.fault={code,message,at:now()};log(d,{kind:'fault',...d.fault});}
    if(d.health)d.health.ready=false;
    persist(d);
  }
  function poseFresh(d){return d.pose&&now()-d.pose.seen_at<=Math.max(500,config.poseTimeoutMs||2500);}
  function poseSafe(d,p){return !d.polygon||signedBoundaryDistance(p,d.polygon)>=d.model.robot_radius_m;}
  function routeSafe(d,from,to){
    if(!d.polygon)return true;
    const count=Math.max(2,Math.ceil(Math.hypot(to.x-from.x,to.y-from.y)/0.01));
    for(let i=0;i<=count;i++){
      const t=i/count,p={x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t};
      if(!poseSafe(d,p))return false;
      for(const other of devices.values()){
        if(other===d||!other.pose||!poseFresh(other)||
           (d.polygon_id&&other.polygon_id!==d.polygon_id))continue;
        if(Math.hypot(p.x-other.pose.x,p.y-other.pose.y)<d.model.robot_radius_m+other.model.robot_radius_m+.04)return false;
      }
    }
    return true;
  }
  function predict(d,c,p){
    if(c.kind==='stop')return {...p};
    if(c.kind==='left'||c.kind==='right')return {...p,heading:wrap(p.heading+(c.kind==='left'?1:-1)*c.value*Math.PI/180)};
    const direction=c.kind==='forward'?1:-1,dist=c.value*direction;
    return {...p,x:p.x+dist*Math.cos(p.heading),y:p.y+dist*Math.sin(p.heading)};
  }
  function validateMove(d,c,allowManual=false){
    if(!c||c.manual&&!allowManual||!['forward','backward','left','right','stop'].includes(c.kind))return 'invalid_kind';
    if(c.kind==='stop')return null;
    if(!d.polygon)return 'arena_not_calibrated';
    if(!d.model.calibrated)return 'model_uncalibrated';
    const turn=c.kind==='left'||c.kind==='right',unit=turn?'deg':'m',cap=turn?Math.min(45,d.model.max_turn_rad*180/Math.PI):Math.min(.25,d.model.max_step_m);
    if(!number(c.value)||c.value<=0||c.value>cap+1e-7||c.unit!==unit)return 'limits_or_units';
    const durationMs=turn?c.value*Math.PI/180/d.model.angular_rad_s*1000:c.value/d.model.linear_m_s*1000;
    const omega=turn?d.model.angular_rad_s:0,v=turn?0:d.model.linear_m_s;
    const left=(v-omega*d.model.track_width_m/2)/d.model.wheel_radius_m;
    const right=(v+omega*d.model.track_width_m/2)/d.model.wheel_radius_m;
    if(durationMs<10||durationMs>12000||Math.max(Math.abs(left),Math.abs(right))>d.model.max_wheel_rad_s)return 'kinematic_limit';
    if(d.polygon){
      if(!poseFresh(d)){
        if(!allowManual && !c.allowDeadReckoning)return 'pose_stale';
        if(!d.pose){
          const cx=d.polygon.reduce((s,p)=>s+p.x,0)/d.polygon.length;
          const cy=d.polygon.reduce((s,p)=>s+p.y,0)/d.polygon.length;
          d.pose={x:cx,y:cy,heading:0,seen_at:now(),source:'dead_reckoning'};
        }
      }
      const end=predict(d,c,d.pose),inside=poseSafe(d,d.pose);
      if(!inside){
        if(!allowManual)return 'outside_arena';
        if(signedBoundaryDistance(end,d.polygon)<signedBoundaryDistance(d.pose,d.polygon)-1e-5)return 'unsafe_recovery';
      }else if(!routeSafe(d,d.pose,end))return 'crosses_boundary';
    }
    return null;
  }
  function issue(d,c){
    const command={id:uuid(),kind:c.kind,value:c.kind==='stop'?0:round(c.value),unit:c.kind==='stop'?'':c.unit,
      expires_at:now()+15000};
    d.queue.push(command);
    if(d.pose){d.issued={id:command.id,at:now(),from:{x:d.pose.x,y:d.pose.y,heading:d.pose.heading},
      predicted:predict(d,command,d.pose)};}
    d.mode=d.manual?'MANUAL':'AUTO';persist(d);return command;
  }
  function planNext(d){
    if(!d.mission||d.queue.length||d.awaitingPose||d.fault||d.manual)return;
    if(!poseFresh(d)){stop(d,'POSE_STALE','No recent ArUco pose',true);return;}
    const p=d.pose,m=d.mission,dx=m.x-p.x,dy=m.y-p.y,dist=Math.hypot(dx,dy);
    let angle=dist>.03?wrap(Math.atan2(dy,dx)-p.heading):m.heading===null?0:wrap(m.heading-p.heading);
    if(dist<=.03&&Math.abs(angle)<=.10){
      if(Array.isArray(d.waypoints)&&d.waypoints.length>0){
        const nextWp=d.waypoints.shift();
        d.mission={id:uuid(),x:nextWp.x,y:nextWp.y,heading:null,created_at:now()};
        persist(d);
        return planNext(d);
      }
      d.history.push({mission_id:m.id,status:'done',at:now()});d.history=d.history.slice(-200);d.mission=null;d.mode='READY';persist(d);return;
    }
    let command;
    if(Math.abs(angle)>.12){const deg=Math.min(Math.abs(angle),d.model.max_turn_rad)*180/Math.PI;
      command={kind:angle>0?'left':'right',unit:'deg',value:Math.max(.1,deg)};
    }else{command={kind:'forward',unit:'m',value:Math.min(dist,d.model.max_step_m)};}
    const error=validateMove(d,command);
    if(error){stop(d,'MODEL_REJECTED','Mathematical model rejected segment: '+error,true);return;}
    issue(d,command);
  }
  function poll(d,body){
    if(typeof body.boot!=='string'||!body.boot.length||body.boot.length>80)return {code:400,value:{error:'boot_required'}};
    if(d.boot&&d.boot!==body.boot){d.queue=[];d.mission=null;d.waypoints=[];d.issued=null;d.stop=uuid();d.manual=false;d.mode='STOP';}
    if(d.health&&d.queue.length&&now()-d.health.seen_at>1500)stop(d,'LINK_STALE','Robot stopped sending heartbeat');
    d.boot=body.boot;d.seenAt=now();d.health={...body,seen_at:now()};
    if(number(body.battery_v))d.lastBattery=body.battery_v;
    if(number(body.error)&&body.error>0&&!d.fault&&!(d.recoveryPending&&[4,7,10,11,12].includes(body.error)))stop(d,'FIRMWARE_'+body.error,'ESP32 reported an error',true);
    if(d.polygon&&d.mode==='AUTO'&&!poseFresh(d))stop(d,'POSE_STALE','ArUco pose timeout',true);
    if(d.stop){const id=d.stop;d.stop=null;if(d.health)d.health.ready=false;persist(d);return {code:200,value:{epoch,stop:true,id,reason:d.fault?.code||'operator_stop'}};}
    if(d.fault){persist(d);return {code:200,value:{epoch,command:null,hold:true,error:d.fault.code}};}
    if(d.queue.length&&d.queue[0].expires_at<=now()){stop(d,'COMMAND_EXPIRED','Command lease expired',true);return {code:200,value:{epoch,stop:true,error:'command_expired'}};}
    if(!d.queue.length&&d.mission)planNext(d);
    const resume=d.resume===true||d.recoveryPending===true;d.resume=false;
    if(d.recoveryPending&&body.ready===true&&(!number(body.error)||body.error===0))d.recoveryPending=false;
    persist(d);
    return {code:200,value:{epoch,resume,command:body.ready===true&&!d.awaitingPose?d.queue[0]||null:null}};
  }
  function ack(d,body){
    if(body.epoch!==epoch||body.boot!==d.boot)return {code:409,value:{error:'session_changed'}};
    const command=d.queue[0];
    if(!command||body.id!==command.id){
      if(d.history.some(c=>c.id===body.id))return {code:200,value:{ok:true}};
      return {code:409,value:{error:'unknown_command'}};
    }
    if(!['done','failed'].includes(body.status))return {code:400,value:{error:'invalid_status'}};
    d.history.push({...command,status:body.status,detail:String(body.detail||'').slice(0,200),at:now()});
    d.history=d.history.slice(-200);d.queue.shift();
    if(body.status==='failed'){stop(d,'EXECUTION_FAILED','Robot rejected motion: '+String(body.detail||'').slice(0,100),true);return {code:200,value:{ok:true}};}
    if(d.issued?.id===command.id&&d.polygon){
      if((d.pose?.source==='aruco'||d.pose?.source==='camera_vision')&&poseFresh(d)){
        d.awaitingPose={...d.issued,ackAt:now()};
      }else{
        d.pose={...d.issued.predicted,seen_at:now(),source:'dead_reckoning'};
      }
      d.issued=null;
    }
    if(!d.mission&&!d.queue.length&&!d.awaitingPose)d.mode=d.manual?'MANUAL':'READY';
    persist(d);return {code:200,value:{ok:true}};
  }
  async function readBody(req){
    let size=0,chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>65536)throw Object.assign(Error('too_large'),{code:413});chunks.push(chunk);}
    return size?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/api/health'&&req.method==='GET')return send(200,{ok:true,epoch});

      const arenaMatch=url.pathname.match(/^\/api\/arena(?:\/([^/]+))?$/);
      if(arenaMatch){
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');
        const isTracker=config.trackerToken&&equal(token,config.trackerToken);
        const isOperator=equal(token,config.operatorToken);
        if(!isTracker&&!isOperator)return send(401,{error:'unauthorized'});
        if(req.method==='GET'){
          const pid=arenaMatch[1]?decodeURIComponent(arenaMatch[1]):null;
          const arena=pid?arenas.get(pid):arenas.values().next().value;
          if(!arena)return send(404,{error:'arena_not_configured'});
          return send(200,{ok:true,polygon_id:pid,polygon:arena.polygon,anchors:arena.anchors});
        }
        if(req.method==='POST'){
          if(!isOperator)return send(401,{error:'operator_token_required'});
          const b=await readBody(req);
          if(!validPolygon(b.polygon))return send(422,{error:'invalid_polygon'});
          const pid=b.polygon_id||config.devices[0]?.polygon_id||'default';
          const anchors=(b.anchors&&typeof b.anchors==='object')?b.anchors:{};
          arenas.set(pid,{polygon:b.polygon,anchors});
          for(const dev of devices.values()){
            if(!b.polygon_id||!dev.polygon_id||dev.polygon_id===b.polygon_id){
              dev.polygon=b.polygon;
              dev.model.calibrated=true;
              persist(dev);
            }
          }
          return send(200,{ok:true,polygon_id:pid,anchors_count:Object.keys(anchors).length});
        }
      }

      if(url.pathname==='/api/vision-sync'&&req.method==='POST'){
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');
        if(!equal(token,config.operatorToken))return send(401,{error:'unauthorized'});
        const b=await readBody(req);
        if(validPolygon(b.polygon)){
          arenaZones=Array.isArray(b.zones)?b.zones:[];
          for(const dev of devices.values()){
            dev.polygon=b.polygon;
            dev.model.calibrated=true;
          }
        }
        let manualRequired=false,faultMessage=null,activeRobotId=null;
        if(Array.isArray(b.robots)){
          for(const r of b.robots){
            const dev=Array.from(devices.values()).find(x=>x.marker_id===r.marker_id);
            if(!dev)continue;
            activeRobotId=dev.id;
            const prevPose=dev.pose;
            dev.pose={x:r.x,y:r.y,heading:wrap(r.heading),seen_at:now(),source:'camera_vision'};
            if(dev.awaitingPose&&!dev.fault){
              const pred=dev.awaitingPose.predicted,dist=Math.hypot(dev.pose.x-pred.x,dev.pose.y-pred.y),turn=Math.abs(wrap(dev.pose.heading-pred.heading));
              if(dist<=dev.model.model_tolerance_m&&turn<=dev.model.model_tolerance_rad&&dev.pose.seen_at>dev.awaitingPose.at)dev.awaitingPose=null;
            }
            if(!pointInTransportZones(dev.pose)&&!dev.manual){
              stop(dev,'OUTSIDE_TRANSPORT_ZONE','Робот выехал за пределы транспортной зоны',true);
            }
            if((dev.queue.length||dev.mission)&&!dev.manual&&prevPose){
              if(!dev.stallCheck)dev.stallCheck={x:dev.pose.x,y:dev.pose.y,since:now()};
              else if(Math.hypot(dev.pose.x-dev.stallCheck.x,dev.pose.y-dev.stallCheck.y)>0.015){
                dev.stallCheck={x:dev.pose.x,y:dev.pose.y,since:now()};
              }else if(now()-dev.stallCheck.since>2500){
                dev.stallCheck=null;
                stop(dev,'STALL_DETECTED','Робот застрял (нет движения по камере)',true);
              }
            }else{
              dev.stallCheck=null;
            }
            if(dev.mode==='MANUAL_REQUIRED'||dev.fault){
              manualRequired=true;
              faultMessage=dev.fault?.message||'Требуется ручное управление';
            }
            persist(dev);
          }
        }
        return send(200,{ok:true,active_robot_id:activeRobotId,manual_required:manualRequired,fault_message:faultMessage});
      }

      if(url.pathname==='/api/auto-route/start'&&req.method==='POST'){
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');
        if(!equal(token,config.operatorToken))return send(401,{error:'unauthorized'});
        const b=await readBody(req);
        await refreshElevationFromAR();
        const dev=Array.from(devices.values()).find(d=>d.pose)||devices.values().next().value;
        if(!dev||!dev.polygon||!dev.pose)return send(409,{error:'arena_or_robot_not_detected'});
        const targetZone=arenaZones.find(z=>z.kind==='mining')||arenaZones.find(z=>z.kind==='warehouse')||arenaZones.find(z=>z.kind==='charging');
        if(!targetZone||!targetZone.points?.length)return send(422,{error:'no_target_zone',detail:'Добавьте зону добычи, склада или зарядной станции'});
        const goal={
          x:targetZone.points.reduce((s,p)=>s+p.x,0)/targetZone.points.length,
          y:targetZone.points.reduce((s,p)=>s+p.y,0)/targetZone.points.length
        };
        const waypoints=planWeightedRoute(dev.pose,goal,dev.polygon,b.lengthWeight??0.5,b.elevationWeight??0.5);
        dev.waypoints=waypoints;
        const first=dev.waypoints.shift();
        dev.mission={id:uuid(),x:first.x,y:first.y,heading:null,created_at:now()};
        dev.fault=null;dev.manual=false;
        planNext(dev);persist(dev);
        return send(200,{ok:true,waypoints:waypoints.length+1});
      }

      if(url.pathname==='/api/manual-drive'&&req.method==='POST'){
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');
        if(!equal(token,config.operatorToken))return send(401,{error:'unauthorized'});
        const b=await readBody(req);
        const dev=(b.robot_id&&devices.get(b.robot_id))||devices.values().next().value;
        if(!dev)return send(404,{error:'unknown_device'});
        dev.fault=null;dev.stop=null;dev.manual=true;dev.resume=true;dev.recoveryPending=true;dev.mode='MANUAL';
        const cmd=issue(dev,b.command);
        return send(200,{ok:true,id:cmd.id});
      }

      if(url.pathname==='/api/resume-auto'&&req.method==='POST'){
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');
        if(!equal(token,config.operatorToken))return send(401,{error:'unauthorized'});
        const b=await readBody(req);
        const dev=(b.robot_id&&devices.get(b.robot_id))||devices.values().next().value;
        if(!dev)return send(404,{error:'unknown_device'});
        if(!pointInTransportZones(dev.pose))return send(409,{error:'still_outside_transport_zone'});
        dev.fault=null;dev.stop=null;dev.manual=false;dev.resume=true;dev.recoveryPending=true;dev.mode='READY';
        if(dev.waypoints?.length){
          const nextPt=dev.waypoints.shift();
          dev.mission={id:uuid(),x:nextPt.x,y:nextPt.y,heading:null,created_at:now()};
          planNext(dev);
        }
        persist(dev);
        return send(200,{ok:true});
      }

      if(url.pathname==='/api/stop-all'&&req.method==='POST'){
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');
        if(!equal(token,config.operatorToken))return send(401,{error:'unauthorized'});
        for(const dev of devices.values())stop(dev,'OPERATOR_STOP','Остановлено оператором',true);
        return send(200,{ok:true});
      }

      const match=url.pathname.match(/^\/api\/robots\/([^/]+)\/(command|poll|ack|commands|status|stop|telemetry|error|pose|mission|manual|reset)$/);
      if(!match)return send(404,{error:'not_found'});
      let id;try{id=decodeURIComponent(match[1]);}catch{return send(400,{error:'invalid_id'});}
      const d=devices.get(id);if(!d)return send(404,{error:'unknown_device'});
      const action=match[2],operator=['commands','status','stop','pose','mission','manual','reset'].includes(action);
      const token=(req.headers.authorization||'').replace(/^Bearer /,'');
      const target=operator?(action==='pose'&&config.trackerToken&&equal(token,config.trackerToken)?token:config.operatorToken):d.token;
      if(!equal(token,target))return send(401,{error:'unauthorized'});
      if(action==='status'&&req.method==='GET')return send(200,{epoch,boot:d.boot,health:d.health,queue:d.queue,history:d.history,pose:d.pose,mission:d.mission,mode:d.mode,manual:d.manual,recoveryPending:d.recoveryPending,fault:d.fault,model:d.model});
      if(action==='command'&&req.method==='GET'){
        const ready=url.searchParams.get('ready')==='1',boot=url.searchParams.get('boot')||'',error=Number(url.searchParams.get('error')||0),battery=Number(url.searchParams.get('battery_v'));
        const result=poll(d,{boot,ready,error,battery_v:Number.isFinite(battery)&&url.searchParams.has('battery_v')?battery:undefined});
        return send(result.code,result.value);
      }
      if(action==='poll'&&req.method==='POST'){const r=poll(d,await readBody(req));return send(r.code,r.value);}
      if(action==='ack'&&req.method==='POST'){const r=ack(d,await readBody(req));return send(r.code,r.value);}
      if(action==='telemetry'&&req.method==='POST'){
        const b=await readBody(req);if(b.boot&&d.boot&&b.boot!==d.boot)return send(409,{error:'session_changed'});
        if(b.battery_v!==undefined&&(!number(b.battery_v)||b.battery_v<0||b.battery_v>40))return send(422,{error:'invalid_voltage'});
        if(number(b.battery_v))d.lastBattery=b.battery_v;
        if(number(b.error)&&b.error>0&&!(d.recoveryPending&&[4,7,10,11,12].includes(b.error)))stop(d,'FIRMWARE_'+b.error,'Robot error '+b.error,true);
        if(!d.health)d.health={};d.health={...d.health,firmware_error:b.error||0,seen_at:now()};
        if(number(b.battery_v))d.health.battery_v=b.battery_v;
        else delete d.health.battery_v;
        persist(d);
        return send(200,{ok:true,hold:!!d.fault});
      }
      if(action==='error'&&req.method==='POST'){
        const b=await readBody(req),code=String(b.code||'UNKNOWN').slice(0,40);
        stop(d,'DEVICE_'+code,String(b.detail||'Device fault').slice(0,180),true);
        return send(200,{ok:true});
      }
      if(action==='stop'&&req.method==='POST'){
        stop(d,'OPERATOR_STOP','Stop requested by operator');return send(200,{ok:true});
      }
      if(action==='reset'&&req.method==='POST'){
        const b=await readBody(req);
        if(b.confirm!==true)return send(422,{error:'confirmation_required'});
        if(d.polygon&&(!poseFresh(d)||!poseSafe(d,d.pose))){
          const reason=!poseFresh(d)?'pose_stale':`outside_or_near_edge (dist=${round(signedBoundaryDistance(d.pose,d.polygon),3)}m, min=${d.model.robot_radius_m}m)`;
          return send(409,{error:'pose_not_safe',detail:reason,pose:d.pose});
        }
        if(!d.health||now()-d.health.seen_at>2000||(d.health.error>0&&![4,7,10,11,12].includes(d.health.error)))return send(409,{error:'robot_not_ready'});
        d.fault=null;d.stop=null;d.mode='READY';d.manual=false;d.resume=true;d.recoveryPending=true;persist(d);return send(200,{ok:true});
      }
      if(action==='pose'&&req.method==='POST'){
        const b=await readBody(req);
        if(!validPose(b))return send(422,{error:'invalid_pose'});
        if(d.polygon_id&&b.polygon_id!==d.polygon_id)return send(409,{error:'wrong_polygon'});
        if(d.marker_id!==undefined&&b.marker_id!==undefined&&b.marker_id!==d.marker_id)return send(409,{error:'wrong_marker'});
        d.pose={x:b.x,y:b.y,heading:wrap(b.heading),seen_at:now(),source:'aruco'};
        if(d.polygon&&!poseSafe(d,d.pose)&&!d.manual)stop(d,'GEOFENCE','Robot is outside permitted zone',true);
        if(d.awaitingPose&&!d.fault){
          const pred=d.awaitingPose.predicted,dist=Math.hypot(d.pose.x-pred.x,d.pose.y-pred.y),turn=Math.abs(wrap(d.pose.heading-pred.heading));
          if(dist>d.model.model_tolerance_m||turn>d.model.model_tolerance_rad){stop(d,'MODEL_DIVERGENCE',`Pose diverged by ${round(dist)}m / ${round(turn)}rad`,true);}
          else if(d.pose.seen_at>d.awaitingPose.at){d.awaitingPose=null;}
        }
        persist(d);return send(200,{ok:true,hold:!!d.fault});
      }
      if(action==='mission'&&req.method==='POST'){
        const b=await readBody(req);
        if(b.action==='STOP'){stop(d,'OPERATOR_STOP','Mission stopped');return send(200,{ok:true});}
        if(d.fault)return send(409,{error:'fault',detail:d.fault.code});
        if(!d.health||now()-d.health.seen_at>2000||d.health.ready!==true)return send(409,{error:'device_not_ready'});
        if(d.queue.length||d.mission||d.awaitingPose)return send(409,{error:'busy'});
        if(b.action==='DUMP')return send(422,{error:'dump_actuator_not_configured',detail:'DRV8833 pair controls locomotion only'});
        if(b.action!=='MOVE_TO'||!b.target||!number(b.target.x)||!number(b.target.y))return send(422,{error:'invalid_mission'});
        if(!d.polygon)return send(422,{error:'arena_not_calibrated'});
        if(!d.model.calibrated)return send(422,{error:'model_not_calibrated'});
        if(!poseFresh(d)||!poseSafe(d,d.pose)){
          const reason=!poseFresh(d)?'pose_stale':`outside_or_near_edge (dist=${round(signedBoundaryDistance(d.pose,d.polygon),3)}m, min=${d.model.robot_radius_m}m)`;
          return send(409,{error:'pose_not_safe',detail:reason,pose:d.pose});
        }
        const target={x:b.target.x,y:b.target.y,heading:b.target.heading===undefined?null:b.target.heading};
        if(target.heading!==null&&(!number(target.heading)||Math.abs(target.heading)>Math.PI*2))return send(422,{error:'invalid_heading'});
        if(!poseSafe(d,target))return send(422,{error:'target_out_of_bounds'});
        d.mission={id:uuid(),...target,created_at:now()};planNext(d);persist(d);
        return send(201,{mission_id:d.mission?.id||null,ok:!d.fault,error:d.fault?.code});
      }
      if(action==='manual'&&req.method==='POST'){
        const b=await readBody(req);
        if(b.action==='enable'){
          if(b.confirm!==true||!d.health||now()-d.health.seen_at>2000)return send(409,{error:'confirmation_or_connection_missing'});
          if(d.health.error&&![4,7,10,11,12].includes(d.health.error))return send(409,{error:'hardware_fault_requires_local_service'});
          d.fault=null;d.stop=null;d.manual=true;d.resume=true;d.recoveryPending=true;d.mode='MANUAL';persist(d);return send(200,{ok:true});
        }
        if(b.action==='disable'){d.manual=false;stop(d,'OPERATOR_STOP','Manual takeover ended');return send(200,{ok:true});}
        if(b.action!=='drive'||!d.manual||d.queue.length||d.awaitingPose||!d.health?.ready||d.health.error)return send(409,{error:'manual_not_ready'});
        const c=b.command,error=validateMove(d,c,true);
        if(error)return send(422,{error});
        if(c.kind!=='stop'&&(c.value>(['left','right'].includes(c.kind)?10:0.03)))return send(422,{error:'manual_speed_limit'});
        const command=issue(d,c);return send(201,{id:command.id});
      }
      if(action==='commands'&&req.method==='POST'){
        const b=await readBody(req),rows=b.commands;
        if(d.fault)return send(409,{error:'fault',detail:d.fault.code});
        if(!d.health||now()-d.health.seen_at>2000||d.health.ready!==true)return send(409,{error:'device_not_ready'});
        if(d.queue.length||d.mission||d.awaitingPose)return send(409,{error:'queue_not_empty'});
        if(!Array.isArray(rows)||!rows.length||rows.length>100)return send(400,{error:'commands_required'});
        const allowDR=d.pose?.source!=='aruco'&&d.pose?.source!=='camera_vision';
        const err=rows.map(c=>validateMove(d,{...c,allowDeadReckoning:allowDR})).find(Boolean);
        if(err)return send(422,{error:'invalid_command_or_unit',detail:err});
        if(d.polygon&&rows.length!==1)return send(422,{error:'geofenced_commands_require_feedback'});
        const ids=rows.map(c=>issue(d,c).id);
        return send(201,{ids});
      }
      return send(405,{error:'method_not_allowed'});
    }catch(e){return send(e.code===413?413:400,{error:e.code===413?'too_large':'invalid_request',detail:String(e.message||e).slice(0,120)});}
  });
  server.robotDevices=devices;
  server.robotEpoch=epoch;
  return server;
}

if(require.main===module){
  const file=process.argv[2];
  if(!file){console.error('Usage: node robot-server.cjs robot-private.json [host=127.0.0.1] [port=8766]');process.exitCode=1;}
  else{
    const config=JSON.parse(fs.readFileSync(file,'utf8'));
    if(config.stateDir&&!path.isAbsolute(config.stateDir))config.stateDir=path.resolve(path.dirname(file),config.stateDir);
    config.privateConfigPath=path.resolve(file);
    const host=process.argv[3]||'127.0.0.1',port=Number(process.argv[4]||8766),server=createRobotServer(config);
    server.listen(port,host,()=>{
      console.log('ROI robot server on http://'+host+':'+port+' (commands require explicit authorization)');
      if(config.cloud){require('./local/cloud-bridge.cjs').startCloudBridge(config,`http://127.0.0.1:${port}`);}
    });
  }
}
module.exports={createRobotServer,contains,signedBoundaryDistance,wrap};
