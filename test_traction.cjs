const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Traction=require('./truck-traction.js'),Truck=require('./truck-model.js');
const c={...Truck.defaults},p={x:2,y:3,yaw:0},target={x:2,y:3,yaw:0,v:0,omega:0};
const released=Traction.forces(c,1.4,p,{...target,x:100,y:100,yaw:2},[.7,.2],[.1,.1],.1,true);
assert.equal(released.fx,0);assert.equal(released.fy,0);assert.equal(released.torque,0);assert.equal(released.contactFriction,c.mu,'Released manual controls use full contact friction, without coordinate anchoring');
const full=Traction.forces(c,1.4,p,{...target,v:.09},[.8,0],[0,0],0,true);assert(Math.hypot(full.fx,full.fy)<=full.driveLimit+1e-12);assert(full.normal<1.4*9.81,'Inclines reduce normal load and grip');
const weak=Traction.forces({...c,mu:.1},1.4,p,{...target,v:.09},[.8,0],[0,0],0,true);assert(weak.driveLimit<full.driveLimit);assert(Math.hypot(weak.fx,weak.fy)<Math.hypot(full.fx,full.fy),'A weak surface cannot produce unlimited climbing force');
(async()=>{
 global.wasmModule=await import('@mujoco/mujoco');require('./polygon-geometry.js');require('./setup-geometry.js');
 Object.assign(global,{ChargingModel:require('./charging-model.js'),TruckModel:Truck,TruckNavigation:require('./truck-navigation.js'),TruckLearning:require('./truck-learning.js'),TruckCommandLog:require('./truck-command-log.js'),TruckTraction:Traction,MujocoPlanning:require('./mujoco-planning.js'),MujocoScene:require('./mujoco-scene.js')});
 const grade=35,slope=Math.tan(grade*Math.PI/180);
 global.MetricTerrain={...require('./mujoco_sim/terrain.cjs'),generate:()=>({unit:'m',cols:101,rows:71,cells:Array.from({length:7171},(_,i)=>(i%101)*.1*slope)})};
 const box=(id,kind,x,y,w,h)=>({id,name:id,kind,points:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]});
 const source={boundary:box('p',null,20,20,960,660).points,zones:[box('t','transport',45,45,910,610),box('c','charging',100,470,160,140)],depth:SetupGeometry.emptyDepth(),routes:[]};
 const route={id:'slope',equipmentId:'truck',points:[{x:400,y:300},{x:800,y:300}],fromKind:'mining',toKind:'warehouse',markerClearance:0,boundaryClearance:5};source.routes=[route];
 global.self=global;let resolver;global.postMessage=m=>{if(m.id)resolver(m);};
 vm.runInThisContext(fs.readFileSync('mujoco-browser-worker.js','utf8').replace(/importScripts\([^;]+;/,'').replace("import('./assets/vendor/mujoco.js')","Promise.resolve(global.wasmModule)"));
 let id=0;const request=m=>new Promise((resolve,reject)=>{resolver=r=>r.error?reject(Error(r.error)):resolve(r);self.onmessage({data:{...m,id:++id,session:'traction'}});});
 async function slide(mu){
  let r=await request({op:'configure',source,route,config:{...c,mu,maxGradeDeg:18,emergencyGradeDeg:25}});assert(r.state.analysis.attemptedFallback,'The 35 degree map must start with a risk warning, not a no-path error');
  await request({op:'start'});r=await request({op:'manual'});const start=r.state.x;
  r=await request({op:'advance',seconds:1});
  assert.equal(r.state.recovery.mode,'manual');assert.equal(vm.runInThisContext('data.qfrc_applied[ids.x.d]'),0);assert.equal(vm.runInThisContext('data.qfrc_applied[ids.y.d]'),0);
  assert(Math.abs(vm.runInThisContext('model.geom_friction[supportGeoms[0]*3]')-mu)<1e-10);
  assert(r.state.x<start-.02,'An unpowered truck must slide downhill when gravity exceeds grip; no invisible slope wall');
  return start-r.state.x;
 }
 const slippery=await slide(.1),grippy=await slide(.5);assert(grippy<slippery*.8,'Higher physical contact friction must reduce downhill sliding');
 await request({op:'input',drive:1,turn:0});vm.runInThisContext('data.qpos[ids.z.q]+=1;engine.mj_forward(model,data);');await request({op:'advance',seconds:.02});
 assert.equal(vm.runInThisContext('data.qfrc_applied[ids.x.d]'),0,'A truck without ground contact cannot generate drive force in the air');assert.equal(vm.runInThisContext('data.qfrc_applied[ids.y.d]'),0);
 console.log('PASS traction: bounded drive, real MuJoCo friction, free downhill sliding without hidden anchors, more grip reduces sliding, 35 degree fallback starts');
})().catch(e=>{console.error(e);process.exitCode=1;});
