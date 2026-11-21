/* Physics and planning stay off the UI thread; only poses cross the boundary. */
importScripts(...['polygon-geometry.js','setup-geometry.js','charging-model.js','truck-model.js','truck-navigation.js','truck-learning.js','truck-command-log.js','mujoco-terrain.js','mujoco-planning.js','mujoco-scene.js'].map(file=>file+'?v='+(new URL(self.location.href).searchParams.get('v')||'dev')));
let enginePromise,engine,model,data,reference,prepared,scene,session,ids,dynamic,stats,sceneKey,controls,truckMass,cargoId;
let recovery,leg,watch,manualInput={drive:0,turn:0,until:0};
let knowledge,lastMemoryRevision=-1,trace=[],traceRole;
let commands,lastCommandRevision=-1;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),angle=v=>Math.atan2(Math.sin(v),Math.cos(v));
const joint=name=>{const id=engine.mj_name2id(model,3,name);return {q:model.jnt_qposadr[id],d:model.jnt_dofadr[id]};};
const actuator=name=>engine.mj_name2id(model,19,name);
function pose(){return {x:scene.spawn[0]+data.qpos[ids.x.q],y:scene.spawn[1]+data.qpos[ids.y.q],yaw:data.qpos[ids.yaw.q]};}
function gradient(x,y){const e=.02,h=scene.height;return [(h(x+e,y)-h(x-e,y))/(2*e),(h(x,y+e)-h(x,y-e))/(2*e)];}
async function configure(m){
 self.postMessage({progress:'Загрузка MuJoCo'});
 enginePromise??=import('./assets/vendor/mujoco.js').then(module=>module.default());engine=await enginePromise;
 knowledge=TruckLearning.create(TruckLearning.key(m.source,m.route,m.config),m.memory);lastMemoryRevision=-1;trace=[];traceRole=null;
 const key=JSON.stringify([m.source,m.route,m.config]);
 const reusedScene=sceneKey===key;
 if(sceneKey!==key){
  self.postMessage({progress:'Анализ проходимости и построение маршрута'});prepared=MujocoPlanning.prepare(m.source,m.route,m.config,knowledge);scene=MujocoScene.build(prepared);
  self.postMessage({progress:'Подготовка физической сцены'});data?.delete();model?.delete();model=engine.MjModel.from_xml_string(scene.xml);data=new engine.MjData(model);sceneKey=key;
 }else engine.mj_resetData(model,data);
 ids=Object.fromEntries(['x','y','z','yaw','pitch','roll'].map(name=>[name,joint(name)]));
 controls=Object.fromEntries(['pitch_support','roll_support','tip_servo',...prepared.stations.flatMap((s,i)=>['arm_x_'+i,'arm_z_'+i,'wrist_'+i])].map(name=>[name,actuator(name)]));
 truckMass=model.body_subtreemass[engine.mj_name2id(model,1,'truck')];cargoId=engine.mj_name2id(model,5,'cargo');
 prepared.navigation=TruckNavigation.create(prepared.source,prepared.config,prepared.route,knowledge);
 const selected=prepared.navigation.plan(m.route.points[0],m.route.points.at(-1));if(!selected)throw Error('Не найден проходимый путь с учётом сохранённого опыта. Можно очистить память маршрутов.');prepared.route.points=selected;
 reference=new TruckModel.Simulation({...prepared.route,continuous:true},prepared.config,prepared.navigation);
 recovery={mode:'auto',attempts:0,message:'',events:[]};leg=null;watch=null;manualInput={drive:0,turn:0,until:0};
 commands=TruckCommandLog.create();lastCommandRevision=-1;
 const arrived=reference.arrived.bind(reference);
 reference.arrived=()=>{const final=reference.index===(reference.direction===1?reference.points.length-1:0);if(final)rememberPassage(true);if(leg&&reference.pathRole!==leg.role)leg=null;if(leg&&final){reference.points=leg.points;reference.direction=leg.direction;reference.index=leg.direction===1?leg.points.length-1:0;leg=null;}arrived();if(final){trace=[];traceRole=null;}};
 data.qpos[ids.yaw.q]=Math.atan2(reference.points[1].y-reference.y,reference.points[1].x-reference.x);
 reference.psi=data.qpos[ids.yaw.q];prepared.stations.forEach((s,i)=>{data.qpos[joint('arm_z_'+i).q]=.08;});
 engine.mj_forward(model,data);session=m.session;stats={steps:0,heldSteps:0,reusedScene};
 dynamic=[];const geoms=[];
 for(let i=0;i<model.ngeom;i++){
  const type=model.geom_type[i];if(type===1||model.geom_rgba[i*4+3]===0&&engine.mj_name2id(model,5,'cargo')!==i)continue;
  geoms.push({id:i,type,size:Array.from(model.geom_size.slice(i*3,i*3+3)),rgba:Array.from(model.geom_rgba.slice(i*4,i*4+4)),moving:model.geom_bodyid[i]>0});
  if(model.geom_bodyid[i]>0)dynamic.push(i);
 }
 return {geoms,elevation:prepared.source.elevation,depth:prepared.source.depth,zones:prepared.source.zones,boundary:prepared.source.boundary,config:prepared.config,stations:prepared.stations,poses:poses(geoms.map(g=>g.id)),route:prepared.route,version:engine.mj_versionString(),reusedScene};
}
function poses(indices=dynamic){const array=new Float32Array(indices.length*12);indices.forEach((id,i)=>{array.set(data.geom_xpos.slice(id*3,id*3+3),i*12);array.set(data.geom_xmat.slice(id*9,id*9+9),i*12+3);});return array;}
function tracePassage(p){
 if(traceRole!==reference.pathRole){trace=[];traceRole=reference.pathRole;}
 const s=reference.config.metresPerUnit,q={x:p.x/s,y:p.y/s};
 if(!trace.length||Math.hypot(q.x-trace.at(-1).x,q.y-trace.at(-1).y)*s>.12)trace.push(q);
 if(trace.length>190){const shorter=trace.filter((p,i)=>i%2===0||i===trace.length-1);if(!prepared.navigation.validate(shorter).length)trace=shorter;else trace.shift();}
}
function rememberPassage(completed=false){
 tracePassage(pose());let points=trace;
 // Millimetre tracking noise near a clearance boundary must not discard a
 // completed, validated plan. Save that plan only after physically reaching its end.
 if(completed&&(points.length<3||prepared.navigation.validate(points).length)){
  const s=reference.config.metresPerUnit,goal=reference.points[reference.direction===1?reference.points.length-1:0],p=pose();
  if(Math.hypot(p.x-goal.x,p.y-goal.y)<.06)points=(reference.direction===1?reference.points:[...reference.points].reverse()).map(q=>({x:q.x/s,y:q.y/s}));
 }
 if(points.length>=2&&!prepared.navigation.validate(points).length)knowledge.success(points,reference.payload>1e-6);
}
function rememberLeg(){
 if(!leg)leg={points:structuredClone(reference.points),direction:reference.direction,role:reference.pathRole};
 return leg.points[leg.direction===1?leg.points.length-1:0];
}
function event(message){recovery.message=message;recovery.events.push({time:reference.time,message});if(recovery.events.length>100)recovery.events.shift();}
function hold(p){recovery.hold={...p};manualInput={drive:0,turn:0,until:0};}
function requestManual(message){rememberLeg();recovery.mode='request';hold(pose());event(message+' Требуется ручное управление.');reference.v=reference.omega=0;}
function safeSegment(a,b){const s=reference.config.metresPerUnit;return !prepared.navigation.validate([a,b].map(p=>({x:p.x/s,y:p.y/s}))).length;}
function manualSegment(a,b){const s=reference.config.metresPerUnit;return SetupGeometry.inPolygon([a,b].map(p=>({x:p.x/s,y:p.y/s})),prepared.source.boundary,false);}
function syncReference(p){reference.x=p.x;reference.y=p.y;reference.psi=p.yaw;reference.v=reference.omega=reference.wL=reference.wR=0;}
function replan(){
 const p=pose(),goal=rememberLeg(),s=reference.config.metresPerUnit;
 try{
  const points=prepared.navigation.plan({x:p.x/s,y:p.y/s},{x:goal.x/s,y:goal.y/s},reference.pathRole==='to-charge'?'shortest':'terrain');
  if(!points)throw Error('Нет безопасного объезда');
  syncReference(p);reference.points=points.map(q=>({x:q.x*s,y:q.y*s}));reference.direction=1;reference.index=1;reference.transition('turning');
  recovery.mode='auto';recovery.progress={...p};watch=null;trace=[];traceRole=null;event('Маршрут перестроен. Продолжаю движение.');return true;
 }catch(error){requestManual('Не удалось построить объезд.');return false;}
}
function recover(){
 const p=pose(),target=reference.target(),goal=rememberLeg();
 if(recovery.attempts>=2){requestManual('Две попытки выезда не помогли.');return;}
 recovery.attempts++;recovery.failed={...p};recovery.heading=Math.atan2(target.y-p.y,target.x-p.x);
 const yaw=p.yaw+(recovery.attempts===2?.35:0),back={x:p.x-.18*Math.cos(yaw),y:p.y-.18*Math.sin(yaw),yaw:p.yaw};
 recovery.elapsed=0;hold(p);
 if(safeSegment(p,back)){recovery.mode='back';recovery.target=back;event('Застревание. Попытка '+recovery.attempts+'/2: отъезжаю назад.');}
 else{event('Отъезд назад небезопасен. Ищу объезд.');finishRecovery();}
}
function finishRecovery(){
 const p=recovery.failed,goal=rememberLeg(),s=reference.config.metresPerUnit;
 // Exclude the failed approach ahead of the chassis, never its current cell or the destination.
 const x=p.x+.24*Math.cos(recovery.heading),y=p.y+.24*Math.sin(recovery.heading),r=.12;
 if(Math.hypot(goal.x-x,goal.y-y)>.25&&Math.hypot(pose().x-x,pose().y-y)>.18)prepared.navigation.avoid([{x:(x-r)/s,y:(y-r)/s},{x:(x+r)/s,y:(y-r)/s},{x:(x+r)/s,y:(y+r)/s},{x:(x-r)/s,y:(y+r)/s}]);
 replan();
}
function monitor(p,dt,error,yawError){
 if(recovery.progress&&Math.hypot(p.x-recovery.progress.x,p.y-recovery.progress.y)>.75){recovery.attempts=0;recovery.progress=null;}
 const moving=reference.stage==='driving',turning=['turning','dock-align'].includes(reference.stage);
 const expected=moving&&(reference.v>.005||error>.025)||turning&&(Math.abs(reference.omega)>.02||Math.abs(yawError)>.15)||reference.stage==='waiting'&&(error>.025||Math.abs(yawError)>.15);
 if(!expected){watch=null;return;}
 if(!watch||watch.stage!==reference.stage){watch={...p,stage:reference.stage,elapsed:0};return;}
 watch.elapsed+=dt;if(watch.elapsed<3)return;
 const progressed=moving?Math.hypot(p.x-watch.x,p.y-watch.y)>.025:Math.abs(angle(p.yaw-watch.yaw))>.06;
 watch=null;if(!progressed)recover();
}
function controlledTarget(p,dt){
 if(recovery.mode==='back'){
  recovery.elapsed+=dt;
  if(Math.hypot(p.x-recovery.target.x,p.y-recovery.target.y)<.025||recovery.elapsed>=4){finishRecovery();return {x:p.x,y:p.y,yaw:p.yaw,v:0,omega:0};}
  const dx=recovery.target.x-p.x,dy=recovery.target.y-p.y,d=Math.hypot(dx,dy);
  return {x:p.x+dx/d*.008,y:p.y+dy/d*.008,yaw:recovery.target.yaw,v:-.035,omega:0};
 }
 if(recovery.mode==='manual'){
  const input=performance.now()<manualInput.until?manualInput:{drive:0,turn:0},v=input.drive*Math.min(.045,reference.config.speed),omega=input.turn*.5;
  const yaw=p.yaw+omega*dt,next={x:p.x+Math.cos(yaw)*v*.2,y:p.y+Math.sin(yaw)*v*.2,yaw};
  if(!v&&!omega){return {...recovery.hold,v:0,omega:0};}
  if(!manualSegment(p,next)){hold(p);recovery.message='Достигнута граница полигона.';return {...p,v:0,omega:0};}
  recovery.hold={...p};return {...next,v,omega};
 }
 return {...recovery.hold,v:0,omega:0};
}
function auxiliaryTime(dt,p,target){
 reference.time+=dt;reference.v=Math.hypot(data.qvel[ids.x.d],data.qvel[ids.y.d]);reference.omega=data.qvel[ids.yaw.d];
 reference.distance+=reference.v*dt;reference.wL=(reference.v-reference.omega*reference.config.trackWidth/2)/reference.config.k;reference.wR=(reference.v+reference.omega*reference.config.trackWidth/2)/reference.config.k;
 const power=.18+(Math.abs(target.v)+Math.abs(target.omega)>0||recovery.mode==='back'?2:0),load=power/(reference.config.converterEfficiency*Math.max(2.5,reference.ocv()));
 reference.battery.soc=Math.max(0,reference.soc-load*dt/(3600*reference.config.capacityAh));reference.current=-load;reference.energyWh+=power*dt/3600;
 if(reference.soc<=.05){reference.fail('Батарея разряжена. Движение остановлено.');recovery.mode='auto';}
}
function step(){
 const dt=.004,c=reference.config,p=pose(),error=Math.hypot(reference.x-p.x,reference.y-p.y),yawError=angle(reference.psi-p.yaw);
 recordCommands(p);
 if((recovery.mode==='auto'&&['driving','turning'].includes(reference.stage))||recovery.mode==='manual')tracePassage(p);
 // The supervisory controller waits for the physical chassis at corners/docks.
 const advancing=error<.03&&Math.abs(yawError)<.2||!['driving','turning','dock-align','waiting','station'].includes(reference.stage);
 let target;
 if(recovery.mode==='auto'){
  if(advancing)reference.advance(dt);else stats.heldSteps++;
  if(leg&&reference.pathRole!==leg.role)leg=null;
  monitor(p,dt,error,yawError);
  target={x:reference.x,y:reference.y,yaw:reference.psi,v:advancing?reference.v:0,omega:advancing?reference.omega:0};
 }
 if(recovery.mode!=='auto'){target=controlledTarget(p,dt);auxiliaryTime(dt,p,target);}
 const mass=truckMass,grad=gradient(p.x,p.y),vx=data.qvel[ids.x.d],vy=data.qvel[ids.y.d];
 const maxForce=Math.min(c.mu*mass*9.81,2*c.torqueLimit/c.k);
 data.qfrc_applied.fill(0);
 const targetV=target.v;
 const fx=mass*(25*(target.x-p.x)+8*(targetV*Math.cos(target.yaw)-vx))+mass*9.81*grad[0];
 const fy=mass*(25*(target.y-p.y)+8*(targetV*Math.sin(target.yaw)-vy))+mass*9.81*grad[1];
 const mag=Math.hypot(fx,fy),ratio=Math.min(1,maxForce/Math.max(1e-9,mag));
 data.qfrc_applied[ids.x.d]=fx*ratio;data.qfrc_applied[ids.y.d]=fy*ratio;
 data.qfrc_applied[ids.yaw.d]=clamp(.25*angle(target.yaw-p.yaw)+.04*(target.omega-data.qvel[ids.yaw.d]),-.15,.15);
 const along=grad[0]*Math.cos(p.yaw)+grad[1]*Math.sin(p.yaw),across=-grad[0]*Math.sin(p.yaw)+grad[1]*Math.cos(p.yaw);
 data.ctrl[controls.pitch_support]=-Math.atan(along);data.ctrl[controls.roll_support]=Math.atan(across);data.ctrl[controls.tip_servo]=reference.theta;
 for(let i=0;i<prepared.stations.length;i++){
  const active=reference.chargingSite?.id===prepared.stations[i].id,q=active&&reference.station?reference.station.q:[.01,.08,0,0];
  data.ctrl[controls['arm_x_'+i]]=q[0];data.ctrl[controls['arm_z_'+i]]=q[1];data.ctrl[controls['wrist_'+i]]=q[2];
 }
 model.geom_rgba[cargoId*4+3]=reference.payload>0?1:0;
 engine.mj_step(model,data);stats.steps++;
 if(!Number.isFinite(data.qpos[ids.x.q]))reference.fail('Ошибка физической модели. Выполните сброс.');
 else if(recovery.mode!=='manual'&&(Math.abs(data.qpos[ids.roll.q])>.65||Math.abs(data.qpos[ids.pitch.q])>.65)){if(recovery.mode!=='request')requestManual('Слишком большой наклон шасси. Автоматический выезд остановлен.');}
 else if(recovery.mode==='auto'&&error>.25)recover();
}
function recordCommands(p=pose()){
 commands.update(reference,p,recovery,performance.now()<manualInput.until?manualInput:{drive:0,turn:0});
}
function snapshot(){
 const r=reference,p=pose(),c=r.config;
 return {engine:'MuJoCo WASM',learning:knowledge.summary(),analysis:prepared.navigation.analysis,recovery:structuredClone(recovery),stage:r.stage,time:r.time,x:p.x,y:p.y,psi:p.yaw,v:Math.hypot(data.qvel[ids.x.d],data.qvel[ids.y.d]),distance:r.distance,soc:r.soc,payload:r.payload,theta:data.qpos[joint('tip').q],current:r.current,voltage:r.voltage,deliveries:r.deliveries,wL:r.wL,wR:r.wR,error:r.error,pathRole:r.pathRole,workGoal:r.workGoal,points:r.points,station:r.station?{stage:r.station.stage}:null,groundHeightM:scene.height(p.x,p.y),heightMinM:scene.minimum,heightMaxM:scene.maximum,pitchDeg:data.qpos[ids.pitch.q]*180/Math.PI,rollDeg:data.qpos[ids.roll.q]*180/Math.PI,history:r.history,stats:{...stats,positionError:Math.hypot(r.x-p.x,r.y-p.y),yawError:angle(r.psi-p.yaw),referenceX:r.x,referenceY:r.y,physicsTime:data.time}};
}
let tasks=Promise.resolve();
self.onmessage=messageEvent=>{tasks=tasks.then(async()=>{
 const m=messageEvent.data;
 try{
  let info;
  if(m.op==='configure')info=await configure(m);
  else if(m.session!==session)throw Error('Устаревший расчёт');
  else if(m.op==='start')reference.start();
  else if(m.op==='stop'){recovery.mode='auto';watch=null;syncReference(pose());reference.stop();}
  else if(m.op==='manual'){
   if(reference.station?.active||reference.theta>.02||reference.soc<=.05)throw Error('Ручное движение недоступно при зарядке, поднятом кузове или разряженной батарее.');
   rememberLeg();hold(pose());recovery.mode='manual';event('Ручное управление. Удерживайте стрелки или кнопки.');
  }else if(m.op==='input'){
   if(recovery.mode==='manual'){manualInput={drive:clamp(Number(m.drive)||0,-1,1),turn:clamp(Number(m.turn)||0,-1,1),until:performance.now()+350};if(!manualInput.drive&&!manualInput.turn)hold(pose());}
  }else if(m.op==='auto'){if(recovery.mode==='manual')rememberPassage();recovery.attempts=0;manualInput={drive:0,turn:0,until:0};replan();}
  else if(m.op==='forget'){
   if(reference.active&&recovery.mode!=='request')throw Error('Остановите симуляцию перед очисткой памяти.');
   knowledge=TruckLearning.create(knowledge.memory.key);lastMemoryRevision=-1;prepared.navigation=TruckNavigation.create(prepared.source,prepared.config,prepared.route,knowledge);reference.navigation=prepared.navigation;
  }
  else if(m.op==='advance'){
   // Bound the work per message so pause/reset and the UI remain responsive.
   const steps=Math.min(250,Math.max(0,Math.round(m.seconds/.004)));
   for(let i=0;i<steps&&reference.active;i++)step();
   engine.mj_forward(model,data);
  }
  recordCommands();
  const commandLog=commands.revision!==lastCommandRevision?commands.export():undefined;lastCommandRevision=commands.revision;
  const memory=knowledge.memory.revision!==lastMemoryRevision?knowledge.export():undefined;lastMemoryRevision=knowledge.memory.revision;
  const transforms=poses();self.postMessage({id:m.id,session,state:snapshot(),memory,commandLog,poses:transforms,info,dynamic,cargo:reference.payload>0},[transforms.buffer]);
 }catch(error){console.error(error);self.postMessage({id:m.id,session:m.session,error:error.message||String(error)});}
}).catch(()=>{});};
