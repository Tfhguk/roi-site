/* Public, serverless MuJoCo: physics in a worker, WebGL rendering on the GPU. */
(()=>{
 'use strict';
 const params=new URLSearchParams(location.search);
 if(params.get('view')==='2d'||params.get('mujoco')==='1')return;
 const $=id=>document.getElementById(id),host=$('scene');
 const release=document.querySelector('meta[name="roi-build"]')?.content||'dev';
 let threePromise,view,active,worker,serial=0;const pending=new Map();
 function rpc(message){
  if(!worker){worker=new Worker(new URL('mujoco-browser-worker.js?v='+release,document.baseURI));worker.onmessage=event=>{if(event.data.progress){$('stage').textContent=event.data.progress;return;}const item=pending.get(event.data.id);if(item){pending.delete(event.data.id);event.data.error?item.reject(Error(event.data.error)):item.resolve(event.data);}};worker.onerror=()=>{for(const item of pending.values())item.reject(Error('Не удалось запустить MuJoCo. Обновите страницу и проверьте поддержку WebAssembly.'));pending.clear();worker.terminate();worker=null;};}
  const id=++serial;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({...message,id});});
 }
 document.body.classList.add('mujoco-mode');$('map').style.visibility='hidden';$('depthReadout').hidden=true;
 document.querySelector('h1').textContent='3D симуляция';document.querySelector('.badge').textContent='MuJoCo · в браузере';
 document.querySelector('.truck-side').hidden=true;document.querySelector('.note').textContent='Высоты — в метрах. Рельеф и техника тестовые. Физика рассчитывается в браузере.';
 $('showDepthValues').closest('label').hidden=true;$('showDepth').parentElement.lastChild.textContent='Высоты, м';
 document.querySelector('.metrics').insertAdjacentHTML('beforeend','<div><span>Высота поверхности</span><strong id="height3d">0,00 м</strong></div><div><span>Продольный / боковой наклон</span><strong id="slope3d">0° / 0°</strong></div>');
 for(const id of ['leftSpeed','rightSpeed'])$(id).parentElement.classList.add('shaft-metric');
 document.querySelector('#settingsForm .fields').insertAdjacentHTML('beforeend','<label>Перепад рельефа, м<input name="terrainReliefM" type="number" min="0" max="1.5" step="0.05" required></label><label>Предельный уклон, °<input name="maxGradeDeg" type="number" min="2" max="25" step="1" required></label>');
 const tools=document.createElement('div');Object.assign(tools.style,{position:'absolute',right:'8px',top:'8px',display:'flex',gap:'6px',zIndex:2});tools.innerHTML='<button id="follow3d">За самосвалом</button><button id="overview3d">Общий вид</button>';host.append(tools);
 $('follow3d').onclick=()=>{if(view){view.follow=true;view.zoom=1;view.dirty=true;}};
 $('overview3d').onclick=()=>{if(view){view.follow=false;view.zoom=1;view.dirty=true;}};
 function loadView(){return threePromise??=import('./assets/vendor/three.module.js').then(T=>{
  const renderer=new T.WebGLRenderer({antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.setClearColor(0x101e31);renderer.outputColorSpace=T.SRGBColorSpace;
  const canvas=renderer.domElement;canvas.id='mujoco3d';canvas.setAttribute('aria-label','Интерактивная 3D сцена MuJoCo');Object.assign(canvas.style,{position:'absolute',inset:0,width:'100%',height:'100%',touchAction:'none',userSelect:'none',cursor:'grab'});host.append(canvas);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(42,1,.01,200);camera.up.set(0,0,1);
  scene.add(new T.HemisphereLight(0xc9e6ff,0x344128,2.4));const light=new T.DirectionalLight(0xffffff,2);light.position.set(3,2,8);scene.add(light);
  const root=new T.Group();scene.add(root);const v={T,renderer,canvas,scene,camera,root,meshes:new Map(),azimuth:90,elevation:-55,zoom:1,follow:false,dirty:true,depth:true};view=v;
  let drag;
  for(const type of ['contextmenu','dragstart','selectstart'])canvas.addEventListener(type,e=>e.preventDefault());
  canvas.onpointerdown=e=>{e.preventDefault();canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY};canvas.style.cursor='grabbing';};
  canvas.onpointermove=e=>{if(!drag)return;v.azimuth-=(e.clientX-drag.x)*.5;v.elevation=Math.max(-89,Math.min(-10,v.elevation+(e.clientY-drag.y)*.3));drag={x:e.clientX,y:e.clientY};v.dirty=true;};
  canvas.onpointerup=canvas.onpointercancel=e=>{drag=null;canvas.style.cursor='grab';if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);};canvas.onlostpointercapture=()=>{drag=null;};
  canvas.addEventListener('wheel',e=>{e.preventDefault();v.zoom=Math.max(.2,Math.min(4,v.zoom*Math.exp(e.deltaY*.001)));v.dirty=true;},{passive:false});
  new ResizeObserver(()=>{v.dirty=true;}).observe(host);
  renderer.setAnimationLoop(()=>{
   if(!v.dirty||!v.info)return;v.dirty=false;const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;
   if(v.w!==w||v.h!==h){renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();v.w=w;v.h=h;}
   const bounds=v.info.boundary,s=v.info.config.metresPerUnit;
   const target=v.follow&&active?[active.x,active.y,(active.groundHeightM||0)+.08]:[bounds.reduce((a,p)=>a+p.x,0)/bounds.length*s,bounds.reduce((a,p)=>a+p.y,0)/bounds.length*s,(v.low+v.high)/2];
   const size=Math.max(Math.max(...bounds.map(p=>p.x))-Math.min(...bounds.map(p=>p.x)),Math.max(...bounds.map(p=>p.y))-Math.min(...bounds.map(p=>p.y)))*s;
   const distance=(v.follow?1:Math.max(1,size*1.35))*v.zoom,a=v.azimuth*Math.PI/180,e=-v.elevation*Math.PI/180;
   camera.position.set(target[0]+Math.cos(a)*Math.cos(e)*distance,target[1]+Math.sin(a)*Math.cos(e)*distance,target[2]+Math.sin(e)*distance);camera.lookAt(...target);renderer.render(scene,camera);
  });
  return v;
 });}
 function clearView(v){v.root.traverse(o=>{o.geometry?.dispose();if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material?.dispose();});v.root.clear();v.meshes.clear();}
 function matrix(T,poses,i){const o=i*12,p=poses;return new T.Matrix4().set(p[o+3],p[o+4],p[o+5],p[o],p[o+6],p[o+7],p[o+8],p[o+1],p[o+9],p[o+10],p[o+11],p[o+2],0,0,0,1);}
 function height(info,x,y){const e=info.elevation,s=info.config.metresPerUnit,u=Math.max(0,Math.min(e.cols-1,x/(1000*s)*(e.cols-1))),v=Math.max(0,Math.min(e.rows-1,y/(700*s)*(e.rows-1))),c=Math.min(e.cols-2,Math.floor(u)),r=Math.min(e.rows-2,Math.floor(v)),a=u-c,b=v-r;return (1-b)*((1-a)*e.cells[r*e.cols+c]+a*e.cells[r*e.cols+c+1])+b*((1-a)*e.cells[(r+1)*e.cols+c]+a*e.cells[(r+1)*e.cols+c+1]);}
 function line(v,points,color){const T=v.T,vertices=[];for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/.1));for(let j=0;j<n;j++)for(const t of [j/n,(j+1)/n]){const x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;vertices.push(x,y,height(v.info,x,y)+.012);}}return new T.LineSegments(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(vertices,3)),new T.LineBasicMaterial({color}));}
 function setupView(v,info){
  clearView(v);v.path=null;v.pathKey=null;v.info=info;const T=v.T,e=info.elevation,s=info.config.metresPerUnit;v.low=Math.min(...e.cells);v.high=Math.max(...e.cells);
  const geometry=new T.PlaneGeometry(1000*s,700*s,e.cols-1,e.rows-1),positions=geometry.attributes.position,colors=[];
  for(let r=0;r<e.rows;r++)for(let c=0;c<e.cols;c++){const i=r*e.cols+c,z=e.cells[i],t=(z-v.low)/Math.max(.001,v.high-v.low);positions.setXYZ(i,c/(e.cols-1)*1000*s,r/(e.rows-1)*700*s,z);const color=new T.Color().setHSL(.43-.3*t,.5,.34+.13*t);colors.push(color.r,color.g,color.b);}
  geometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));geometry.computeVertexNormals();v.terrain=new T.Mesh(geometry,new T.MeshLambertMaterial({vertexColors:true,side:T.DoubleSide}));v.root.add(v.terrain);
  const staticBoxes=info.geoms.map((g,i)=>({...g,index:i})).filter(g=>!g.moving&&g.type===6),instances=new T.InstancedMesh(new T.BoxGeometry(2,2,2),new T.MeshLambertMaterial({color:0xa82b35}),staticBoxes.length);
  staticBoxes.forEach((g,j)=>{const m=matrix(T,info.poses,g.index);m.scale(new T.Vector3(...g.size));instances.setMatrixAt(j,m);});instances.computeBoundingSphere();v.root.add(instances);
  info.geoms.forEach((g,i)=>{
   if(!g.moving)return;const [x,y,z]=g.size;let shape;
   if(g.type===6)shape=new T.BoxGeometry(2*x,2*y,2*z);
   else if(g.type===5){shape=new T.CylinderGeometry(x,x,2*y,12);shape.rotateX(Math.PI/2);}
   else if(g.type===3){shape=new T.CapsuleGeometry(x,2*y,4,8);shape.rotateX(Math.PI/2);}
   else {shape=new T.SphereGeometry(g.type===4?1:x,10,6);if(g.type===4)shape.scale(x,y,z);}
   const mesh=new T.Mesh(shape,new T.MeshLambertMaterial({color:new T.Color(...g.rgba.slice(0,3))}));mesh.matrixAutoUpdate=false;mesh.matrix.copy(matrix(T,info.poses,i));mesh.visible=g.rgba[3]>0;v.root.add(mesh);v.meshes.set(g.id,mesh);if(g.rgba[3]===0)v.cargo=mesh;
  });
  const zoneColors={transport:0x60a5fa,mining:0xfb923c,warehouse:0xc4b5fd,charging:0x4ade80};for(const zone of info.zones){const points=[...zone.points,zone.points[0]].map(p=>({x:p.x*s,y:p.y*s}));v.root.add(line(v,points,zoneColors[zone.kind]||0xffffff));}
  v.dirty=true;
 }
 function updateView(v,message){message.dynamic.forEach((id,i)=>{const mesh=v.meshes.get(id);if(mesh)mesh.matrix.copy(matrix(v.T,message.poses,i));});if(v.cargo)v.cargo.visible=message.cargo;
  const points=message.state.points,key=message.state.pathRole+JSON.stringify(points);if(key!==v.pathKey){if(v.path){v.root.remove(v.path);v.path.geometry.dispose();v.path.material.dispose();}v.path=line(v,points,message.state.pathRole==='to-charge'?0xfbbf24:message.state.pathRole==='to-work'?0xe879f9:0x22d3ee);v.root.add(v.path);v.pathKey=key;}v.dirty=true;
 }
 class BrowserTruck extends TruckModel.Simulation{
  static defaults={terrainReliefM:.75,maxGradeDeg:18};
  constructor(route,config,source,onUpdate,onError){super(route,config,null);this.isMuJoCo=true;this.initializing=true;this.session=crypto.randomUUID();this.update=onUpdate;this.onError=onError;active=this;this.command('configure',{source,route,config});}
  async command(op,values={}){
   try{const message=await rpc({op,session:this.session,...values});if(this.disposed)return;
    const v=await loadView();if(this.disposed)return;if(message.info){if(!message.info.reusedScene||!v.info)setupView(v,message.info);this.elevationMap=message.info.elevation;this.stations=message.info.stations;}
    const {soc,...state}=message.state;this.battery.soc=soc;Object.assign(this,state);this.initializing=false;if(this.station)this.station.export=()=>({stage:this.station.stage});updateView(v,message);
    const n=v=>Number(v).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});$('height3d').textContent=n(this.groundHeightM)+' м';$('slope3d').textContent=n(this.pitchDeg)+'° / '+n(this.rollDeg)+'°';$('depthRange').textContent=n(this.heightMinM)+' — '+n(this.heightMaxM)+' м';
    if(this.time>=(this.nextSample||0)){this.sample();this.nextSample=this.time+.5;}this.update();
   }catch(error){if(!this.disposed){this.initializing=false;this.stage='error';this.error=error.message;this.onError(error.message);this.update();}}
  }
  start(){this.command('start');}stop(){this.command('stop');}
  advance(seconds){if(this.busy||this.disposed||seconds<=0)return;this.busy=true;this.command('advance',{seconds:Math.min(1,seconds)}).finally(()=>{this.busy=false;});}
  paint(){if(view)view.dirty=true;}
  dispose(){this.disposed=true;}
  export(){const result=super.export();return {...result,engine:'MuJoCo WASM',elevation:this.elevationMap,stations:this.stations,performance:this.stats,camera:view?{azimuth:view.azimuth,elevation:view.elevation,zoom:view.zoom,follow:view.follow}:null,assumptions:{...result.assumptions,drive:'MuJoCo WASM heightfield contacts; simplified track supports; supervisory trajectory controller'}};}
 }
 $('showDepth').addEventListener('change',()=>{if(view){view.terrain.material.vertexColors=$('showDepth').checked;view.terrain.material.needsUpdate=true;view.dirty=true;}});
 window.MuJoCoTruck=BrowserTruck;
})();
