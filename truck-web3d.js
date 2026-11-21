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
 document.querySelectorAll('#helpDialog li')[3].textContent='Цвет поверхности показывает высоту в метрах. Автопилот предпочитает пологий путь; если его нет — пытается пройти крутой склон. При неудаче пробует выехать и запрашивает ручное управление. Вручную нет удержания в точке: действуют тяжесть, тяга и трение. Красные отметки не создают физических стен.';
 $('showDepthValues').closest('label').hidden=true;$('showDepth').parentElement.lastChild.textContent='Высоты, м';
 document.querySelector('.depth-toolbar').insertAdjacentHTML('afterend','<div class="terrain-toolbar" aria-label="Генерация рельефа"><button id="regenerateTerrain" title="Новый рельеф и пересчёт маршрута; текущий заезд сбросится">Перегенерировать рельеф</button><label for="terrainExtremity">Экстремальность</label><input id="terrainExtremity" type="range" min="0" max="100" step="1" value="50" aria-describedby="terrainHint"><output id="terrainExtremityValue" for="terrainExtremity">50%</output><span id="terrainHint">0 — ровно · 100 — крутые склоны. Заезд сбрасывается.</span></div>');
 document.querySelector('.metrics').insertAdjacentHTML('beforeend','<div><span>Высота поверхности</span><strong id="height3d">0,00 м</strong></div><div><span>Продольный / боковой наклон</span><strong id="slope3d">0° / 0°</strong></div>');
 for(const id of ['leftSpeed','rightSpeed'])$(id).parentElement.classList.add('shaft-metric');
 document.querySelector('#settingsForm .fields').insertAdjacentHTML('beforeend','<label>Перепад рельефа, м<input name="terrainReliefM" type="number" min="0" max="1.5" step="0.05" required></label><label>Предпочтительный уклон, °<input name="maxGradeDeg" type="number" min="2" max="25" step="1" required></label><label>Порог рискованного проезда, °<input name="emergencyGradeDeg" type="number" min="2" max="30" step="1" required></label>');
 const memoryPrefix='roi_truck_learning_v1:'+(window.AppCloud?.session()?.user?.id||'demo')+':';
 function readMemory(key){try{return JSON.parse(localStorage.getItem(memoryPrefix+key))?.data;}catch{return null;}}
 function saveMemory(data){try{localStorage.setItem(memoryPrefix+data.key,JSON.stringify({updatedAt:Date.now(),data}));const keys=Object.keys(localStorage).filter(k=>k.startsWith(memoryPrefix)).sort((a,b)=>{try{return JSON.parse(localStorage.getItem(b)).updatedAt-JSON.parse(localStorage.getItem(a)).updatedAt;}catch{return 0;}});for(const key of keys.slice(8))localStorage.removeItem(key);}catch{if(active)active.memoryVolatile=true;}}
 document.querySelector('.note').insertAdjacentHTML('beforebegin','<button id="routeAnalysis" class="route-analysis">Анализ маршрута</button>');
 document.body.insertAdjacentHTML('beforeend','<dialog id="analysisDialog"><h2>Проходимость и память</h2><p id="analysisDetails"></p><p>Уклон и запас тяги — оценки тестовой модели. Если обычного пути нет, разрешается попытка проезда по крутому склону. Границы, габарит и препятствия остаются ограничениями.</p><div class="dialog-actions"><button id="forgetRoutes">Забыть опыт</button><button id="closeAnalysis">Закрыть</button></div></dialog>');
 $('routeAnalysis').onclick=()=>{$('analysisDialog').showModal();};$('closeAnalysis').onclick=()=>$('analysisDialog').close();$('forgetRoutes').onclick=()=>{$('analysisDialog').close();active?.forget();};
 document.querySelector('.telemetry').insertAdjacentHTML('beforeend','<section class="command-panel" aria-label="Команды самосвала"><div><strong>Команды</strong><button id="openCommandLog">Весь лог</button></div><ol id="recentCommands"><li>Команд пока нет</li></ol></section>');
 document.body.insertAdjacentHTML('beforeend','<dialog id="commandDialog" aria-labelledby="commandTitle"><h2 id="commandTitle">Лог команд самосвала</h2><p>Автопилот: заданные расстояния и углы. Ручное управление: фактически выполненное движение. Время — с начала симуляции. Сохраняются последние 200 записей; они также входят в скачиваемый расчёт.</p><ol id="commandEntries"></ol><div class="dialog-actions"><button id="olderCommands">← Ранее</button><span id="commandPage"></span><button id="newerCommands">Позже →</button><button id="closeCommandLog">Закрыть</button></div></dialog>');
 let commandPage=null,lastCommandView,lastCommandDialog;
 const commandTime=t=>Math.floor(t/60).toString().padStart(2,'0')+':'+Math.floor(t%60).toString().padStart(2,'0');
 function fillCommands(element,rows){
  element.replaceChildren();
  for(const row of rows){const li=document.createElement('li'),time=document.createElement('time'),text=document.createElement('span');time.textContent=commandTime(row.time);text.textContent=row.message;li.append(time,text);element.append(li);}
  if(!rows.length){const li=document.createElement('li');li.textContent='Команд пока нет. Запустите симуляцию.';element.append(li);}
 }
 function commandUI(sim){
  const rows=sim?.commandLog||[],key=sim?.session+':'+(sim?.commandRevision||0);
  if(key!==lastCommandView){fillCommands($('recentCommands'),rows.slice(-2));lastCommandView=key;}
  if(!$('commandDialog').open)return;
  const size=innerHeight<650?4:6,pages=Math.max(1,Math.ceil(rows.length/size)),page=commandPage===null?pages-1:Math.min(commandPage,pages-1);
  const dialogKey=key+':'+page+':'+size;if(dialogKey===lastCommandDialog)return;lastCommandDialog=dialogKey;
  fillCommands($('commandEntries'),rows.slice(page*size,(page+1)*size));$('commandPage').textContent=(page+1)+' / '+pages;
  $('olderCommands').disabled=page===0;$('newerCommands').disabled=page===pages-1;
  $('olderCommands').onclick=()=>{commandPage=page-1;commandUI(active);};$('newerCommands').onclick=()=>{commandPage=page+1;commandUI(active);};
 }
 $('openCommandLog').onclick=()=>{commandPage=null;lastCommandDialog=null;$('commandDialog').showModal();commandUI(active);};$('closeCommandLog').onclick=()=>$('commandDialog').close();
 window.addEventListener('resize',()=>commandUI(active));
 function analysisUI(sim){
  const a=sim.analysis,m=sim.learning;if(!a)return;
  $('routeAnalysis').textContent=(a.passable?(a.attemptedFallback?'Попытка проезда':a.steepFallback?'Крутой участок':'Проезд допустим'):'Проезд не найден')+' · память: '+(m?.routes||0);
  $('analysisDetails').textContent=(a.passable?'Путь допустим по геометрии. ':'Нет проходимого пути. ')+(a.maxGradeDeg!==undefined?'Максимальный уклон '+a.maxGradeDeg.toFixed(1)+'°. Расчётный запас тяги '+Math.round((a.minTractionReserve||0)*100)+'%. ':'')+(a.attemptedFallback?'Обычного пути нет: выполняется попытка проезда, успех не гарантирован. '+(a.warnings||[]).join('; ')+'. ':a.steepFallback?'Пологого пути нет: разрешён более крутой участок. ':'')+(a.remembered?'Использован ранее пройденный путь. ':'')+'Сохранено путей: '+(m?.routes||0)+', проблемных участков: '+(m?.hazards||0)+'. '+(a.reasons||[]).join('; ')+' '+(sim.memoryVolatile?'Память доступна только до закрытия страницы.':'Опыт сохраняется в этом браузере отдельно для полигона, машины и параметров рельефа.');
  $('forgetRoutes').disabled=sim.active;
 }
 const tools=document.createElement('div');Object.assign(tools.style,{position:'absolute',right:'8px',top:'8px',display:'flex',gap:'6px',zIndex:2});tools.innerHTML='<button id="follow3d">За самосвалом</button><button id="overview3d">Общий вид</button>';host.append(tools);
 $('follow3d').onclick=()=>{if(view){view.follow=true;view.zoom=1;view.dirty=true;}};
 $('overview3d').onclick=()=>{if(view){view.follow=false;view.zoom=1;view.dirty=true;}};
 tools.insertAdjacentHTML('beforeend','<button id="manual3d">Ручное управление</button>');
 host.insertAdjacentHTML('beforeend','<div id="manualPanel" hidden><span>Удерживайте стрелки / WASD · ×1</span><div><button data-drive="1" aria-label="Вперёд">↑</button><button data-turn="1" aria-label="Налево">←</button><button id="manualBrake">Стоп</button><button data-turn="-1" aria-label="Направо">→</button><button data-drive="-1" aria-label="Назад">↓</button></div><button id="resumeAuto">Вернуться к маршруту</button></div>');
 document.body.insertAdjacentHTML('beforeend','<dialog id="recoveryDialog"><h2>Самосвал застрял</h2><p id="recoveryMessage"></p><div class="dialog-actions"><button id="takeManual">Взять управление</button><button id="cancelRecovery">Остановить</button></div></dialog>');
 let input={drive:0,turn:0},keys=new Set(),manualTimer,askedSession;
 function sendInput(){if(active?.recovery?.mode==='manual')active.command('input',input);}
 function releaseInput(){keys.clear();input={drive:0,turn:0};sendInput();}
 function takeManual(){releaseInput();$('recoveryDialog').close();active?.command('manual');}
 $('manual3d').onclick=takeManual;$('takeManual').onclick=takeManual;
 $('cancelRecovery').onclick=()=>{$('recoveryDialog').close();active?.stop();};
 $('recoveryDialog').addEventListener('cancel',e=>{e.preventDefault();$('cancelRecovery').click();});
 $('resumeAuto').onclick=()=>{releaseInput();active?.command('auto');};$('manualBrake').onclick=releaseInput;
 for(const button of $('manualPanel').querySelectorAll('[data-drive],[data-turn]')){
  button.onpointerdown=e=>{e.preventDefault();button.setPointerCapture(e.pointerId);input={drive:Number(button.dataset.drive||0),turn:Number(button.dataset.turn||0)};sendInput();};
  button.onpointerup=button.onpointercancel=button.onlostpointercapture=releaseInput;
 }
 function keyboard(e,down){if(active?.recovery?.mode!=='manual'||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;const code=e.code;if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyS','KeyA','KeyD','Space'].includes(code))return;e.preventDefault();if(code==='Space'){releaseInput();return;}down?keys.add(code):keys.delete(code);input={drive:Number(keys.has('ArrowUp')||keys.has('KeyW'))-Number(keys.has('ArrowDown')||keys.has('KeyS')),turn:Number(keys.has('ArrowLeft')||keys.has('KeyA'))-Number(keys.has('ArrowRight')||keys.has('KeyD'))};sendInput();}
 window.addEventListener('keydown',e=>keyboard(e,true));window.addEventListener('keyup',e=>keyboard(e,false));window.addEventListener('blur',releaseInput);document.addEventListener('visibilitychange',()=>{if(document.hidden)releaseInput();});
 function recoveryUI(sim){
  analysisUI(sim);
  const r=sim.recovery,manual=r?.mode==='manual',request=r?.mode==='request';$('manualPanel').hidden=!manual;$('manual3d').disabled=sim.initializing||sim.theta>.02||!manual&&!request&&!['driving','turning','dock-align'].includes(sim.stage)||!!sim.station&&!['complete','stopped','error'].includes(sim.station.stage)||!sim.active&&!request;
  $('speed').disabled=manual;
  if(manual&&!manualTimer)manualTimer=setInterval(sendInput,100);else if(!manual&&manualTimer){clearInterval(manualTimer);manualTimer=null;input={drive:0,turn:0};keys.clear();}
  if(r?.mode==='back'){$('stage').textContent='Попытка выезда '+r.attempts+'/2';$('instruction').textContent=r.message;}
  if(manual||request){$('stage').textContent=manual?'Ручное управление':'Требуется ручное управление';$('instruction').textContent=r.message;}
  if(request&&askedSession!==sim.session+JSON.stringify(r.events)){
   askedSession=sim.session+JSON.stringify(r.events);$('recoveryMessage').textContent=r.message;if(!$('recoveryDialog').open)$('recoveryDialog').showModal();
  }
 }
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
  staticBoxes.forEach((g,j)=>{const m=matrix(T,info.poses,g.index);m.scale(new T.Vector3(...g.size));instances.setMatrixAt(j,m);});if(staticBoxes.length){instances.computeBoundingSphere();v.root.add(instances);}
  if(info.depth){const vertices=[],d=info.depth,cw=1000*s/d.cols,ch=700*s/d.rows;
   d.cells.forEach((value,i)=>{if(value!==null)return;const x=i%d.cols*cw,y=Math.floor(i/d.cols)*ch,n=4;for(let row=0;row<n;row++)for(let col=0;col<n;col++)for(const [a,b]of [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]]){const px=x+(col+a)*cw/n,py=y+(row+b)*ch/n;vertices.push(px,py,height(info,px,py)+.004);}});
   const overlay=new T.Mesh(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(vertices,3)),new T.MeshBasicMaterial({color:0xef4444,transparent:true,opacity:.4,side:T.DoubleSide,depthWrite:false}));v.root.add(overlay);
  }
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
  static defaults={terrainReliefM:.75,terrainSeed:0,maxGradeDeg:18,emergencyGradeDeg:25};
  constructor(route,config,source,onUpdate,onError){super(route,config,null);this.isMuJoCo=true;this.initializing=true;this.session=crypto.randomUUID();this.update=onUpdate;this.onError=onError;active=this;this.memoryKey=TruckLearning.key(source,route,config);this.configureArgs={source,route,config};this.command('configure',{...this.configureArgs,memory:readMemory(this.memoryKey)});}
  async command(op,values={}){
   try{const message=await rpc({op,session:this.session,...values});if(this.disposed)return;
    const v=await loadView();if(this.disposed)return;if(message.info){if(!message.info.reusedScene||!v.info)setupView(v,message.info);this.elevationMap=message.info.elevation;this.stations=message.info.stations;}
    if(message.memory){this.learnedMemory=message.memory;saveMemory(message.memory);}
    if(message.commandLog){this.commandLog=message.commandLog;this.commandRevision=(this.commandRevision||0)+1;}
    const {soc,...state}=message.state;this.battery.soc=soc;const wasManual=this.recovery?.mode==='manual';Object.assign(this,state);this.initializing=false;if(this.station)this.station.export=()=>({stage:this.station.stage});updateView(v,message);
    if(this.recovery?.mode==='manual'&&!wasManual){this.previousSpeed=$('speed').value;$('speed').value='1';this.manualAt=performance.now();}else if(wasManual&&this.recovery?.mode!=='manual'){$('speed').value=this.previousSpeed||'1';}
    const n=v=>Number(v).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});$('height3d').textContent=n(this.groundHeightM)+' м';$('slope3d').textContent=n(this.pitchDeg)+'° / '+n(this.rollDeg)+'°';$('depthRange').textContent=n(this.heightMinM)+' — '+n(this.heightMaxM)+' м';
    if(this.time>=(this.nextSample||0)){this.sample();this.nextSample=this.time+.5;}this.update();recoveryUI(this);if(!wasManual&&this.recovery?.mode==='manual'&&$('pause').textContent==='Продолжить'&&!$('pause').disabled)$('pause').click();
   }catch(error){if(!this.disposed){this.initializing=false;this.stage='error';this.error=error.message;this.onError(error.message);this.update();}}
  }
  get active(){return this.recovery?.mode!=='request'&&super.active;}
  forget(){try{localStorage.removeItem(memoryPrefix+this.memoryKey);}catch{}if(this.stage==='error'||this.initializing){$('toast').hidden=true;this.initializing=true;this.command('configure',{...this.configureArgs,memory:null});}else this.command('forget');}
  renderStatus(){recoveryUI(this);commandUI(this);}
  start(){this.command('start');}stop(){releaseInput();this.command('stop');}
  advance(seconds){if(this.busy||this.disposed||seconds<=0)return;if(this.recovery?.mode==='manual'){const now=performance.now();seconds=Math.min(.05,(now-(this.manualAt||now))/1000);this.manualAt=now;}this.busy=true;this.command('advance',{seconds:Math.min(1,seconds)}).finally(()=>{this.busy=false;});}
  paint(){if(view)view.dirty=true;}
  dispose(){releaseInput();this.disposed=true;clearInterval(manualTimer);manualTimer=null;$('manualPanel').hidden=true;$('recoveryDialog').close();$('analysisDialog').close();$('commandDialog').close();}
  export(){const result=super.export();return {...result,engine:'MuJoCo WASM',commandLog:this.commandLog||[],learning:this.learnedMemory,analysis:this.analysis,recovery:this.recovery,elevation:this.elevationMap,stations:this.stations,performance:this.stats,camera:view?{azimuth:view.azimuth,elevation:view.elevation,zoom:view.zoom,follow:view.follow}:null,assumptions:{...result.assumptions,drive:'MuJoCo WASM heightfield contacts; simplified track supports; supervisory trajectory controller'}};}
 }
 $('showDepth').addEventListener('change',()=>{if(view){view.terrain.material.vertexColors=$('showDepth').checked;view.terrain.material.needsUpdate=true;view.dirty=true;}});
 window.MuJoCoTruck=BrowserTruck;
})();
