/* Read-only workspace integration and synthetic truck simulation. */
(async()=>{
  "use strict";
  const $=id=>document.getElementById(id),G=SetupGeometry,M=TruckModel;
  const clone=x=>structuredClone(x),colors={transport:"#60a5fa",mining:"#fb923c",warehouse:"#c4b5fd",charging:"#4ade80"};
  let source=null,sim=null,navigation=null,paused=false,last=0,config={...M.defaults,...window.MuJoCoTruck?.defaults},loading=false,notice="",generation=0,mapTransform=null,hoveredCell=null;
  const fmt=(x,d=2)=>x.toLocaleString("ru-RU",{minimumFractionDigits:d,maximumFractionDigits:d});
  const box=(id,name,kind,x,y,w,h)=>({id,name,kind,points:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]});
  function toast(message){$("toast").querySelector("span").textContent=message;$("toast").hidden=false;}
  $("toast").querySelector("button").onclick=()=>{$("toast").hidden=true;};
  function demo(){
    const polygon=box("demo","Демонстрационный полигон",null,20,20,960,660);
    const zones=[box("transport","Область движения","transport",45,45,910,610),box("mining","Добыча","mining",90,90,160,150),box("warehouse","Склад","warehouse",700,440,170,150),box("charging","Зарядка","charging",90,460,160,140)];
    const truck={id:"demo-truck",name:"Тестовый самосвал",type:"truck",marker_id:12};
    const depth=G.generateDepth(polygon.points,zones,42,40,28,{boundaryClearance:5,markerClearance:40});
    const planned=G.planRoutes(polygon.points,zones,[truck],depth,{boundaryClearance:5,markerClearance:40});
    return {id:null,name:polygon.name,boundary:polygon.points,zones,depth,trucks:[truck],routes:planned.routes.map((r,i)=>({...r,id:"demo-route-"+i})),testPaths:true};
  }
  function truck(){return source?.trucks.find(t=>t.id===$("truckSelect").value);}
  function route(){return source?.routes.find(r=>r.id===$("routeSelect").value&&r.equipmentId===truck()?.id);}
  function routeErrors(r){
    if(!r)return ["У этого самосвала нет траекторий. Нажмите «Построить тестовые пути»."];
    if(!source.zones.some(z=>z.kind==="transport"))return ["В проекте отсутствует транспортная зона."];
    const areas=source.zones.filter(z=>z.kind==="transport").map(z=>z.points);
    return G.routeErrors({maxDepth:5,maxSlope:2,boundaryClearance:5,markerClearance:40,...r},source.boundary,source.depth,areas,G.safetyContext(source.boundary,areas,G.routingMarkers(source.boundary,source.zones)));
  }
  function reset(){
    sim?.dispose?.();
    paused=false;last=0;notice="";$("toast").hidden=true;sim=null;navigation=null;hoveredCell=null;
    try{
      const r=route();if(!truck())throw Error("На этом полигоне нет ваших самосвалов. Добавьте самосвал в гараже.");
      const errors=routeErrors(r);if(errors.length)throw Error(errors.join("\n"));
      const from=source.zones.find(z=>z.id===r.fromZoneId)||source.zones.find(z=>z.kind!=="transport"&&G.inside(r.points[0],z.points));
      const to=source.zones.find(z=>z.id===r.toZoneId)||source.zones.find(z=>z.kind!=="transport"&&G.inside(r.points.at(-1),z.points));
      const work={...r,fromKind:from?.kind,toKind:to?.kind,continuous:true};
      navigation=TruckNavigation.create(source,config,work);
      const occupied=navigation.validate(r.points);if(occupied.length)throw Error(occupied.join("\n"));
      sim=window.MuJoCoTruck?new MuJoCoTruck(work,config,clone(source),render,toast):new M.Simulation(work,config,navigation);
    }catch(error){notice=error.message;}
    render();if(notice&&route())toast(notice);
  }
  function renderRoutes(){
    const routes=source.routes.filter(r=>r.equipmentId===truck()?.id);
    $("routeSelect").replaceChildren(...routes.map(r=>new Option(r.name,r.id)));
    if(!routes.length){const option=new Option("Нет траекторий","");option.disabled=true;$("routeSelect").append(option);}
    reset();
  }
  function useSource(value){
    source=value;$("truckSelect").replaceChildren(...source.trucks.map(t=>new Option(t.name+" · ID "+t.marker_id,t.id)));
    if(!source.trucks.length)$("truckSelect").append(new Option("Нет самосвалов в гараже",""));
    $("projectStatus").textContent=source.name+(source.id?" · ваш гараж":" · тестовые данные");renderRoutes();
  }
  async function loadProject(){
    if(loading||sim?.active)return;loading=true;render();const version=++generation;
    try{
      const id=$("projectSelect").value;
      if(!id){useSource(demo());return;}
      const [polygons,equipment,ws]=await Promise.all([AppCloud.polygons(),AppCloud.equipment(),AppCloud.projectWorkspace(id)]);
      if(version!==generation)return;
      const p=polygons.find(p=>p.id===id);if(!p||!ws||ws.garage_removed)throw Error("Личный проект недоступен. Откройте полигон и создайте свой гараж.");
      const depth=G.validateDepth(ws.depth||G.emptyDepth());
      useSource({id,name:p.name,boundary:clone(p.geometry.points),zones:clone(ws.zones||[]),depth:clone(depth),trucks:equipment.filter(t=>t.polygon_id===id&&t.type==="truck"),routes:clone(ws.routes||[]).map((r,i)=>({...r,id:r.id||"saved-"+i})),testPaths:false});
      if(notice)toast(notice);
    }catch(error){$("projectSelect").value=source?.id||"";toast(error.message);}finally{loading=false;render();}
  }
  $("loadProject").onclick=loadProject;
  $("truckSelect").onchange=renderRoutes;
  $("routeSelect").onchange=reset;
  $("generate").onclick=()=>{
    try{
      if(!truck())throw Error("Сначала добавьте самосвал в гараже этого полигона.");
      const planned=G.planRoutes(source.boundary,source.zones,[truck()],source.depth,{boundaryClearance:5,markerClearance:40});
      if(!planned.routes.length)throw Error("Не удалось построить проезд по текущей карте глубины. "+planned.unreachable.join("; "));
      source.routes=[...source.routes.filter(r=>r.equipmentId!==truck().id),...planned.routes.map(r=>({...r,id:crypto.randomUUID()}))];source.testPaths=true;renderRoutes();
      if(planned.unreachable.length)toast("Часть зон недоступна: "+planned.unreachable.join("; "));
    }catch(error){toast(error.message);}
  };
  $("start").onclick=()=>{if(!sim){toast(notice);return;}sim.start();paused=false;last=0;render();};
  $("pause").onclick=()=>{paused=!paused;last=0;render();};
  $("stop").onclick=()=>{sim?.stop();paused=false;last=0;render();};
  $("reset").onclick=reset;
  function pause(){if(sim?.active)paused=true;last=0;render();}
  $("help").onclick=()=>{pause();$("helpDialog").showModal();};$("closeHelp").onclick=()=>$("helpDialog").close();
  $("settings").onclick=()=>{pause();for(const input of $("settingsForm").querySelectorAll("input"))input.value=["initialSoc","chargeTrigger"].includes(input.name)?config[input.name]*100:config[input.name];$("settingsDialog").showModal();};
  $("cancelSettings").onclick=()=>$("settingsDialog").close();
  $("settingsForm").onsubmit=e=>{e.preventDefault();try{const values=Object.fromEntries([...new FormData(e.target)].map(([key,v])=>[key,Number(v)/(["initialSoc","chargeTrigger"].includes(key)?100:1)]));const candidate={...config,...values};new M.Simulation({points:[{x:0,y:0},{x:1,y:0}]},candidate);config=candidate;reset();$("settingsDialog").close();}catch(error){toast(error.message);}};
  $("download").onclick=()=>{
    if(!sim)return;sim.sample();const data={...sim.export(),project:{id:source.id,name:source.name,testPaths:source.testPaths},vehicle:clone(truck())};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"})),link=document.createElement("a");link.href=url;link.download="truck-test.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  function canvas(id){const el=$(id),r=el.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);if(el.width!==Math.round(r.width*d)||el.height!==Math.round(r.height*d)){el.width=Math.max(1,Math.round(r.width*d));el.height=Math.max(1,Math.round(r.height*d));}const ctx=el.getContext("2d");ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,r.width,r.height);return {ctx,w:r.width,h:r.height};}
  function draw(){
    if(sim?.isMuJoCo){sim.paint();return;}
    const {ctx,w,h}=canvas("map");if(!source||w<1||h<1)return;
    const points=[...source.boundary,...source.zones.flatMap(z=>z.points)],minX=Math.min(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y));
    const width=Math.max(1,Math.max(...points.map(p=>p.x))-minX),height=Math.max(1,Math.max(...points.map(p=>p.y))-minY),scale=Math.min((w-30)/width,(h-30)/height),ox=(w-width*scale)/2-minX*scale,oy=(h-height*scale)/2-minY*scale;
    mapTransform={scale,ox,oy};
    ctx.translate(ox,oy);ctx.scale(scale,scale);
    const path=(points,color,closed=false,fill=null,lineWidth=2)=>{ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));if(closed)ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}ctx.strokeStyle=color;ctx.lineWidth=lineWidth/scale;ctx.stroke();};
    ctx.save();ctx.beginPath();source.boundary.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.clip();
    const depth=source.depth,maximum=Math.max(0,...depth.cells.filter(v=>v!==null)),cw=1000/depth.cols,ch=700/depth.rows;
    if($("showDepth").checked)depth.cells.forEach((v,i)=>{
      const x=i%depth.cols*cw,y=Math.floor(i/depth.cols)*ch;
      ctx.fillStyle=v===null?"#b91c1cd9":`hsla(${215-Math.min(1,v/Math.max(maximum,.001))*170},65%,43%,.8)`;ctx.fillRect(x,y,cw+.1,ch+.1);
      ctx.strokeStyle="#0f172a44";ctx.lineWidth=.5/scale;ctx.strokeRect(x,y,cw,ch);
      if($("showDepthValues").checked&&Math.min(cw,ch)*scale>=18){ctx.font=`${Math.min(11,Math.min(cw,ch)*scale*.4)/scale}px Segoe UI`;ctx.textAlign="center";ctx.fillStyle="white";ctx.fillText(v===null?"×":fmt(v,1),x+cw/2,y+ch/2+3/scale);}
    });
    if(hoveredCell){ctx.strokeStyle="white";ctx.lineWidth=2/scale;ctx.strokeRect(hoveredCell.col*cw,hoveredCell.row*ch,cw,ch);}ctx.restore();
    $("depthRange").textContent="0 — "+fmt(maximum,1)+" усл. ед. · красное: препятствие";
    $("depthReadout").textContent=hoveredCell?hoveredCell.value===null?"Препятствие · проезд закрыт":"Глубина: "+fmt(hoveredCell.value,2)+" усл. ед.":"Глубина: наведите или нажмите на карту";
    path(source.boundary,"#94a3b8",true);source.zones.forEach(z=>{path(z.points,colors[z.kind],true,colors[z.kind]+"17");const p=z.points.reduce((a,p)=>({x:a.x+p.x/z.points.length,y:a.y+p.y/z.points.length}),{x:0,y:0});ctx.fillStyle=colors[z.kind];ctx.font=`${11/scale}px Segoe UI`;ctx.textAlign="center";ctx.fillText(z.name,p.x,p.y-12/scale);});
    for(const p of [...source.boundary,...source.zones.flatMap(z=>z.points)])if(Number.isInteger(p.markerId)){ctx.fillStyle="#111827";ctx.fillRect(p.x-9/scale,p.y-9/scale,18/scale,18/scale);ctx.strokeStyle="#e2e8f0";ctx.lineWidth=1/scale;ctx.strokeRect(p.x-9/scale,p.y-9/scale,18/scale,18/scale);ctx.fillStyle="white";ctx.font=`${9/scale}px Segoe UI`;ctx.textAlign="center";ctx.fillText(p.markerId,p.x,p.y+3/scale);}
    for(const r of source.routes.filter(r=>r.equipmentId===truck()?.id))path(r.points,r===route()?"#38bdf8":"#526079",false,null,r===route()?3:1);
    if(sim&&sim.pathRole!=="work"){const active=sim.points.map(p=>({x:p.x/config.metresPerUnit,y:p.y/config.metresPerUnit}));path(active,"#0f172a",false,null,6);path(active,sim.pathRole==="to-charge"?"#fbbf24":"#e879f9",false,null,3);}
    for(const station of navigation?.stations||[]){
      path(station.footprint,"#bbf7d0",true,"#14532d",2);
      const q=sim?.chargingSite?.id===station.id&&sim.station?sim.station.q:[.01,.13,0,.75],ux=Math.cos(station.heading),uy=Math.sin(station.heading),base={x:station.centre.x+ux*station.lengthM/config.metresPerUnit/2,y:station.centre.y+uy*station.lengthM/config.metresPerUnit/2},tip={x:base.x+ux*q[0]/config.metresPerUnit,y:base.y+uy*q[0]/config.metresPerUnit};
      path([base,tip],"#e2e8f0",false,null,3);
      ctx.save();ctx.translate(tip.x,tip.y);ctx.rotate(station.heading+q[2]);const gap=(.005+.015*q[3])/config.metresPerUnit;path([{x:0,y:-gap},{x:3/scale,y:-gap}],"#7dd3fc");path([{x:0,y:gap},{x:3/scale,y:gap}],"#7dd3fc");ctx.restore();
      ctx.beginPath();ctx.arc(station.dock.x,station.dock.y,3/scale,0,2*Math.PI);ctx.fillStyle=sim?.station?.current>0&&sim.chargingSite?.id===station.id?"#4ade80":"#bbf7d0";ctx.fill();
      ctx.font=`${10/scale}px Segoe UI`;ctx.textAlign="center";ctx.fillStyle="#dcfce7";ctx.fillText("Станция "+Math.round(station.lengthM*1000)+"×"+Math.round(station.widthM*1000)+" мм*",station.centre.x,station.centre.y-15/scale);
    }
    if(sim){
      const q={x:sim.x/config.metresPerUnit,y:sim.y/config.metresPerUnit};ctx.save();ctx.translate(q.x,q.y);ctx.rotate(sim.psi);const unit=1/scale;
      ctx.fillStyle="#0b1221";ctx.fillRect(-17*unit,-14*unit,34*unit,9*unit);ctx.fillRect(-17*unit,5*unit,34*unit,9*unit);ctx.strokeStyle="#64748b";ctx.lineWidth=unit;ctx.strokeRect(-17*unit,-14*unit,34*unit,28*unit);
      ctx.fillStyle="#fbbf24";ctx.fillRect(-13*unit,-8*unit,21*unit,16*unit);ctx.fillStyle=sim.payload>0?"#a16207":"#475569";ctx.fillRect(-10*unit,-5*unit,13*unit,10*unit);ctx.fillStyle="#38bdf8";ctx.fillRect(9*unit,-7*unit,7*unit,14*unit);ctx.restore();
      ctx.fillStyle="#fef3c7";ctx.font=`${12/scale}px Segoe UI`;ctx.textAlign="center";ctx.fillText(truck()?.name||"Самосвал",q.x,q.y-22/scale);
    }
    const side=canvas("bodyView"),s=side.ctx;const k=Math.min(side.w/200,side.h/110);s.translate((side.w-200*k)/2,(side.h-110*k)/2);s.scale(k,k);s.fillStyle="#0b1221";s.fillRect(25,78,150,18);s.fillStyle="#fbbf24";s.fillRect(25,66,150,12);s.fillStyle="#38bdf8";s.fillRect(145,40,30,26);s.save();s.translate(35,65);s.rotate(-(sim?.theta||0));s.fillStyle="#fbbf24";s.fillRect(0,-29,103,29);s.fillStyle=sim?.payload>0?"#a16207":"#334155";s.fillRect(5,-25,93,19);s.restore();
  }
  function render(){
    const active=Boolean(sim?.active),locked=active||loading||sim?.initializing;
    for(const id of ["projectSelect","loadProject","truckSelect","routeSelect","generate"])$(id).disabled=locked;
    $("start").disabled=loading||!sim||sim.initializing||sim.stage!=="idle";$("pause").disabled=!active;$("stop").disabled=!active||sim.stage==="stopping";$("download").disabled=!sim;$("pause").textContent=paused?"Продолжить":"Пауза";
    $("reset").disabled=loading;$("settings").disabled=loading;
    $("stage").textContent=(sim?.initializing?"Подготовка 3D сцены":sim?M.labels[sim.stage]:"Выберите траекторию")+(paused&&active?" · пауза":"");
    const t=sim?.time||0;$("clock").textContent=Math.floor(t/60).toString().padStart(2,"0")+":"+Math.floor(t%60).toString().padStart(2,"0")+" · ×"+(paused?0:$("speed").value)+" · рейсов "+(sim?.deliveries||0);
    $("vehicleName").textContent=truck()?.name||"Нет самосвала";
    for(const [id,v,u,d]of [["velocity",sim?.v||0," м/с",2],["distance",sim?.distance||0," м",2],["soc",(sim?.soc??config.initialSoc)*100," %",1],["payload",sim?.payload||0," кг",2],["tilt",(sim?.theta||0)*180/Math.PI,"°",0],["current",sim?.current||0," А",2],["leftSpeed",sim?.wL||0," рад/с",2],["rightSpeed",sim?.wR||0," рад/с",2]])$(id).textContent=fmt(v,d)+u;
    $("batteryFill").style.width=(sim?.soc??config.initialSoc)*100+"%";
    $("stationStatus").textContent=(sim?.station?"Станция: "+ChargingModel.labels[sim.station.stage]:"Автозарядка при "+fmt(config.chargeTrigger*100,0)+" %")+" · "+(navigation?.stations.length||0)+" станц.";
    $("empty").hidden=Boolean(sim);$("instruction").textContent=!sim?"Выберите самосвал и его траекторию или постройте тестовые пути.":sim.error?"Расчёт остановлен. Причина показана во всплывающем уведомлении.":sim.stage==="station"?"Станция: "+ChargingModel.labels[sim.station.stage]+". После заряда: "+(sim.payload>1e-6?"на склад с грузом.":"на добычу без груза."):sim.pathRole==="to-charge"?"Динамический путь на зарядку: учтены глубины, перепады и препятствия.":sim.pathRole==="to-work"?"После зарядки: "+(sim.workGoal.kind==="warehouse"?"на склад с грузом.":"на добычу без груза."):sim.stage==="idle"?"Непрерывный цикл. Погрузка и разгрузка — по 4 с при ×1. Нажмите «Запустить».":"Непрерывная работа. Погрузка и разгрузка — по 4 модельные секунды. Зарядка включается автоматически.";
    $("sourceLabel").textContent=source?.testPaths?"Тестовые пути":"Сохранённые пути";
    if(sim?.error&&notice!==sim.error){notice=sim.error;toast(sim.error);}draw();
  }
  document.addEventListener("visibilitychange",()=>{if(document.hidden)pause();});window.addEventListener("resize",render);
  $("showDepth").onchange=draw;$("showDepthValues").onchange=draw;
  function inspectDepth(event){
    if(sim?.isMuJoCo)return;
    if(!source||!mapTransform)return;const r=$("map").getBoundingClientRect(),x=(event.clientX-r.left-mapTransform.ox)/mapTransform.scale,y=(event.clientY-r.top-mapTransform.oy)/mapTransform.scale;
    if(x<0||x>=1000||y<0||y>=700||!G.inside({x,y},source.boundary)){hoveredCell=null;draw();return;}
    const col=Math.floor(x/1000*source.depth.cols),row=Math.floor(y/700*source.depth.rows);hoveredCell={col,row,value:source.depth.cells[row*source.depth.cols+col]};draw();
  }
  $("map").addEventListener("pointermove",inspectDepth);$("map").addEventListener("pointerdown",inspectDepth);$("map").addEventListener("pointerleave",()=>{hoveredCell=null;draw();});
  function frame(now){
    const elapsed=last?Math.min(.1,(now-last)/1000):0;last=now;
    if(sim?.active&&!paused&&!document.hidden){
      // A single clock advances the truck and station, including charging.
      sim.advance(elapsed*Number($("speed").value));render();
    }
    requestAnimationFrame(frame);
  }
  try{useSource(demo());requestAnimationFrame(frame);}catch(error){toast(error.message);return;}
  if(AppCloud.configured&&AppCloud.session())try{
    const [projects,polygons]=await Promise.all([AppCloud.projects(),AppCloud.polygons()]);
    const options=projects.map(p=>{const polygon=polygons.find(item=>item.id===p.polygon_id);return polygon?new Option(polygon.name,p.polygon_id):null;}).filter(Boolean);
    $("projectSelect").append(...options);
  }catch(error){toast("Не удалось загрузить ваши проекты: "+error.message);}
})();
