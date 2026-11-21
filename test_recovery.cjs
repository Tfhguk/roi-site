// Exercise real WASM dynamics while a test fixture physically locks the chassis.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
(async()=>{
 global.wasmModule=await import('@mujoco/mujoco');require('./polygon-geometry.js');require('./setup-geometry.js');global.ChargingModel=require('./charging-model.js');global.TruckModel=require('./truck-model.js');global.TruckNavigation=require('./truck-navigation.js');global.MetricTerrain=require('./mujoco_sim/terrain.cjs');global.MujocoPlanning=require('./mujoco-planning.js');global.MujocoScene=require('./mujoco-scene.js');
 const box=(id,kind,x,y,w,h)=>({id,name:id,kind,points:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]});
 const source={boundary:box('p',null,20,20,960,660).points,zones:[box('t','transport',45,45,910,610),box('m','mining',90,90,160,150),box('w','warehouse',700,440,170,150),box('c','charging',90,460,160,140)],depth:null,routes:[]};source.depth=SetupGeometry.generateDepth(source.boundary,source.zones,42,40,28,{boundaryClearance:5,markerClearance:40});
 const route=SetupGeometry.planRoutes(source.boundary,source.zones,[{id:'truck',type:'truck'}],source.depth,{boundaryClearance:5,markerClearance:40}).routes.find(r=>r.purpose==='haul');route.fromKind='mining';route.toKind='warehouse';source.routes=[route];
 global.self=global;let resolver;global.postMessage=m=>{if(m.id)resolver(m);};
 vm.runInThisContext(fs.readFileSync('mujoco-browser-worker.js','utf8').replace(/importScripts\([^;]+;/,'').replace("import('./assets/vendor/mujoco.js')","Promise.resolve(global.wasmModule)"));
 let serial=0;const request=m=>new Promise((resolve,reject)=>{resolver=result=>result.error?reject(Error(result.error)):resolve(result);global.onmessage({data:{...m,id:++serial,session:'recovery-test'}});});
 const configure=()=>request({op:'configure',source,route,config:{...TruckModel.defaults,terrainReliefM:.3,maxGradeDeg:18}});
 await configure();
 vm.runInThisContext(`const physicalStep=engine.mj_step;engine.mj_step=(m,d)=>{const before=d.qpos.slice();physicalStep(m,d);if(globalThis.lockChassis){for(const name of ['x','y','yaw']){d.qpos[ids[name].q]=before[ids[name].q];d.qvel[ids[name].d]=0;}engine.mj_forward(m,d);}};`);
 async function driving(){await request({op:'start'});let r;for(let i=0;i<40;i++){r=await request({op:'advance',seconds:1});if(r.state.stage==='driving'&&r.state.distance>.2)return r;}throw Error('Truck did not begin moving');}
 let r=await driving();global.lockChassis=true;const stuck={x:r.state.x,y:r.state.y};
 for(let i=0;i<70&&r.state.recovery.mode!=='request';i++)r=await request({op:'advance',seconds:1});
 assert.equal(r.state.recovery.mode,'request','A persistent stall requests the operator instead of hanging');assert(r.state.recovery.attempts<=2);assert(r.state.recovery.events.some(e=>e.message.includes('1/2')),'Try backing up before giving up');assert(r.state.recovery.events.some(e=>e.message.includes('перестроен')),'Attempt a new route');assert(Math.hypot(r.state.x-stuck.x,r.state.y-stuck.y)<1e-8,'Recovery must never teleport the physical chassis');
 const cargo=r.state.payload,soc=r.state.soc;await request({op:'manual'});global.lockChassis=false;await request({op:'input',drive:-1,turn:0});const before={x:r.state.x,y:r.state.y};r=await request({op:'advance',seconds:.3});assert(Math.hypot(r.state.x-before.x,r.state.y-before.y)>.001,'Operator can drive the real chassis backwards');assert.equal(r.state.payload,cargo);assert(r.state.soc<=soc);
 await request({op:'input',drive:0,turn:0});r=await request({op:'advance',seconds:1});const braking={x:r.state.x,y:r.state.y};r=await request({op:'advance',seconds:1});assert(Math.hypot(r.state.x-braking.x,r.state.y-braking.y)<.025,'Releasing input brakes the chassis');
 await request({op:'input',drive:1,turn:0});await new Promise(resolve=>setTimeout(resolve,400));r=await request({op:'advance',seconds:.5});assert(Math.hypot(r.state.x-braking.x,r.state.y-braking.y)<.025,'An expired operator command cannot keep the vehicle moving');
 r=await request({op:'auto'});assert.equal(r.state.recovery.mode,'auto','Resume plans from the actual position');assert.equal(r.state.payload,cargo);
 r=await configure();assert.equal(r.state.recovery.attempts,0);assert.equal(r.state.recovery.events.length,0);
 await driving();global.lockChassis=true;for(let i=0;i<15;i++){r=await request({op:'advance',seconds:1});if(r.state.recovery.mode==='back')break;}assert.equal(r.state.recovery.mode,'back');global.lockChassis=false;
 for(let i=0;i<18;i++){r=await request({op:'advance',seconds:1});if(r.state.recovery.mode==='auto')break;}assert.equal(r.state.recovery.mode,'auto','A temporary obstruction allows recovery and automatic continuation');assert(!r.state.error,r.state.error);
 const recoveredAt={x:r.state.x,y:r.state.y};for(let i=0;i<30;i++){r=await request({op:'advance',seconds:1});if(Math.hypot(r.state.x-recoveredAt.x,r.state.y-recoveredAt.y)>.8)break;}assert.equal(r.state.recovery.mode,'auto');assert(Math.hypot(r.state.x-recoveredAt.x,r.state.y-recoveredAt.y)>.8,'Recovery continues making actual progress on the new route');
 console.log('PASS recovery: physical stall, bounded reverse attempts, obstacle avoidance, no teleportation, operator handoff, manual drive/brake, preserved cargo/SOC, auto resume and clean reset');
})().catch(error=>{console.error(error);process.exitCode=1;});
