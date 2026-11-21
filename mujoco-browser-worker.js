/* Physics and planning stay off the UI thread; only poses cross the boundary. */
importScripts(...['polygon-geometry.js','setup-geometry.js','charging-model.js','truck-model.js','truck-navigation.js','mujoco-terrain.js','mujoco-planning.js','mujoco-scene.js'].map(file=>file+'?v='+(new URL(self.location.href).searchParams.get('v')||'dev')));
let enginePromise,engine,model,data,reference,prepared,scene,session,ids,dynamic,stats,sceneKey,controls,truckMass,cargoId;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),angle=v=>Math.atan2(Math.sin(v),Math.cos(v));
const joint=name=>{const id=engine.mj_name2id(model,3,name);return {q:model.jnt_qposadr[id],d:model.jnt_dofadr[id]};};
const actuator=name=>engine.mj_name2id(model,19,name);
function pose(){return {x:scene.spawn[0]+data.qpos[ids.x.q],y:scene.spawn[1]+data.qpos[ids.y.q],yaw:data.qpos[ids.yaw.q]};}
function gradient(x,y){const e=.02,h=scene.height;return [(h(x+e,y)-h(x-e,y))/(2*e),(h(x,y+e)-h(x,y-e))/(2*e)];}
async function configure(m){
 self.postMessage({progress:'Загрузка MuJoCo'});
 enginePromise??=import('./assets/vendor/mujoco.js').then(module=>module.default());engine=await enginePromise;
 const key=JSON.stringify([m.source,m.route,m.config]);
 const reusedScene=sceneKey===key;
 if(sceneKey!==key){
  self.postMessage({progress:'Построение рельефа и маршрута'});prepared=MujocoPlanning.prepare(m.source,m.route,m.config);scene=MujocoScene.build(prepared);
  self.postMessage({progress:'Подготовка физической сцены'});data?.delete();model?.delete();model=engine.MjModel.from_xml_string(scene.xml);data=new engine.MjData(model);sceneKey=key;
 }else engine.mj_resetData(model,data);
 ids=Object.fromEntries(['x','y','z','yaw','pitch','roll'].map(name=>[name,joint(name)]));
 controls=Object.fromEntries(['pitch_support','roll_support','tip_servo',...prepared.stations.flatMap((s,i)=>['arm_x_'+i,'arm_z_'+i,'wrist_'+i])].map(name=>[name,actuator(name)]));
 truckMass=model.body_subtreemass[engine.mj_name2id(model,1,'truck')];cargoId=engine.mj_name2id(model,5,'cargo');
 reference=new TruckModel.Simulation({...prepared.route,continuous:true},prepared.config,prepared.navigation);
 data.qpos[ids.yaw.q]=Math.atan2(reference.points[1].y-reference.y,reference.points[1].x-reference.x);
 reference.psi=data.qpos[ids.yaw.q];prepared.stations.forEach((s,i)=>{data.qpos[joint('arm_z_'+i).q]=.08;});
 engine.mj_forward(model,data);session=m.session;stats={steps:0,heldSteps:0,reusedScene};
 dynamic=[];const geoms=[];
 for(let i=0;i<model.ngeom;i++){
  const type=model.geom_type[i];if(type===1||model.geom_rgba[i*4+3]===0&&engine.mj_name2id(model,5,'cargo')!==i)continue;
  geoms.push({id:i,type,size:Array.from(model.geom_size.slice(i*3,i*3+3)),rgba:Array.from(model.geom_rgba.slice(i*4,i*4+4)),moving:model.geom_bodyid[i]>0});
  if(model.geom_bodyid[i]>0)dynamic.push(i);
 }
 return {geoms,elevation:prepared.source.elevation,zones:prepared.source.zones,boundary:prepared.source.boundary,config:prepared.config,stations:prepared.stations,poses:poses(geoms.map(g=>g.id)),route:prepared.route,version:engine.mj_versionString(),reusedScene};
}
function poses(indices=dynamic){const array=new Float32Array(indices.length*12);indices.forEach((id,i)=>{array.set(data.geom_xpos.slice(id*3,id*3+3),i*12);array.set(data.geom_xmat.slice(id*9,id*9+9),i*12+3);});return array;}
function step(){
 const dt=.004,c=reference.config,p=pose(),error=Math.hypot(reference.x-p.x,reference.y-p.y),yawError=angle(reference.psi-p.yaw);
 // The supervisory controller waits for the physical chassis at corners/docks.
 const advancing=error<.03&&Math.abs(yawError)<.2||!['driving','turning','dock-align','waiting','station'].includes(reference.stage);
 if(advancing)reference.advance(dt);else stats.heldSteps++;
 const mass=truckMass,grad=gradient(p.x,p.y),vx=data.qvel[ids.x.d],vy=data.qvel[ids.y.d];
 const maxForce=Math.min(c.mu*mass*9.81,2*c.torqueLimit/c.k);
 data.qfrc_applied.fill(0);
 const targetV=advancing?reference.v:0;
 const fx=mass*(25*(reference.x-p.x)+8*(targetV*Math.cos(reference.psi)-vx))+mass*9.81*grad[0];
 const fy=mass*(25*(reference.y-p.y)+8*(targetV*Math.sin(reference.psi)-vy))+mass*9.81*grad[1];
 const mag=Math.hypot(fx,fy),ratio=Math.min(1,maxForce/Math.max(1e-9,mag));
 data.qfrc_applied[ids.x.d]=fx*ratio;data.qfrc_applied[ids.y.d]=fy*ratio;
 data.qfrc_applied[ids.yaw.d]=clamp(.25*angle(reference.psi-p.yaw)+.04*((advancing?reference.omega:0)-data.qvel[ids.yaw.d]),-.15,.15);
 const along=grad[0]*Math.cos(p.yaw)+grad[1]*Math.sin(p.yaw),across=-grad[0]*Math.sin(p.yaw)+grad[1]*Math.cos(p.yaw);
 data.ctrl[controls.pitch_support]=-Math.atan(along);data.ctrl[controls.roll_support]=Math.atan(across);data.ctrl[controls.tip_servo]=reference.theta;
 for(let i=0;i<prepared.stations.length;i++){
  const active=reference.chargingSite?.id===prepared.stations[i].id,q=active&&reference.station?reference.station.q:[.01,.08,0,0];
  data.ctrl[controls['arm_x_'+i]]=q[0];data.ctrl[controls['arm_z_'+i]]=q[1];data.ctrl[controls['wrist_'+i]]=q[2];
 }
 model.geom_rgba[cargoId*4+3]=reference.payload>0?1:0;
 engine.mj_step(model,data);stats.steps++;
 if(!Number.isFinite(data.qpos[ids.x.q])||error>.25||Math.abs(data.qpos[ids.roll.q])>.65||Math.abs(data.qpos[ids.pitch.q])>.65)reference.fail('Шасси не может безопасно пройти участок. Уменьшите перепад или измените маршрут.');
}
function snapshot(){
 const r=reference,p=pose(),c=r.config;
 return {engine:'MuJoCo WASM',stage:r.stage,time:r.time,x:p.x,y:p.y,psi:p.yaw,v:Math.hypot(data.qvel[ids.x.d],data.qvel[ids.y.d]),distance:r.distance,soc:r.soc,payload:r.payload,theta:data.qpos[joint('tip').q],current:r.current,voltage:r.voltage,deliveries:r.deliveries,wL:r.wL,wR:r.wR,error:r.error,pathRole:r.pathRole,workGoal:r.workGoal,points:r.points,station:r.station?{stage:r.station.stage}:null,groundHeightM:scene.height(p.x,p.y),heightMinM:scene.minimum,heightMaxM:scene.maximum,pitchDeg:data.qpos[ids.pitch.q]*180/Math.PI,rollDeg:data.qpos[ids.roll.q]*180/Math.PI,history:r.history,stats:{...stats,positionError:Math.hypot(r.x-p.x,r.y-p.y),yawError:angle(r.psi-p.yaw),referenceX:r.x,referenceY:r.y,physicsTime:data.time}};
}
let tasks=Promise.resolve();
self.onmessage=event=>{tasks=tasks.then(async()=>{
 const m=event.data;
 try{
  let info;
  if(m.op==='configure')info=await configure(m);
  else if(m.session!==session)throw Error('Устаревший расчёт');
  else if(m.op==='start')reference.start();
  else if(m.op==='stop')reference.stop();
  else if(m.op==='advance'){
   // Bound the work per message so pause/reset and the UI remain responsive.
   const steps=Math.min(250,Math.max(0,Math.round(m.seconds/.004)));
   for(let i=0;i<steps&&reference.active;i++)step();
   engine.mj_forward(model,data);
  }
  const transforms=poses();self.postMessage({id:m.id,session,state:snapshot(),poses:transforms,info,dynamic,cargo:reference.payload>0},[transforms.buffer]);
 }catch(error){console.error(error);self.postMessage({id:m.id,session:m.session,error:error.message||String(error)});}
}).catch(()=>{});};
