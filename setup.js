(async function () {
  "use strict";
  const $=id=>document.getElementById(id), G=SetupGeometry;
  const stages=["polygon","garage","zones","routes"], kinds={warehouse:"Склад",charging:"Зарядная станция",mining:"Зона добычи",transport:"Зона транспортировки"};
  const titles={polygon:"Создайте или выберите полигон",garage:"Создайте технику в своём гараже",zones:"Обозначьте рабочие зоны",routes:"Создайте допустимые траектории"};
  const descriptions={polygon:"Нарисуйте границу вручную: каждая вершина станет рукомаркером. Или выберите общий полигон другого пользователя.",garage:"Добавьте свою технику и скачайте её ArUco. Чтобы продолжить, нужна хотя бы одна единица техники.",zones:"Создайте склад, зарядную станцию, зону добычи и зону транспортировки внутри выбранного полигона.",routes:"Рисуйте пути для своей техники. Перемещайте точки, добавляйте точки на отрезках и редактируйте псевдокарту глубины."};
  let profile,polygons=[],equipment=[],ws,step="polygon",selectedId=null,draft=null,selectedVertex=-1,dirty=false,busy=false;
  let stream,drag=null,painting=false,history=[];
  document.querySelector("main").inert=true;
  const clone=value=>structuredClone(value), uid=()=>crypto.randomUUID();
  function notice(text,error=false){$("message").textContent=text;$("message").classList.toggle("error",error);}
  function changed(){dirty=true;$("saveState").textContent="Есть несохранённые изменения";}
  function snapshot(){history.push({draft:clone(draft),ws:clone(ws),selectedId,selectedVertex});if(history.length>80)history.shift();}
  function undo(){const previous=history.pop();if(!previous)return;({draft,ws,selectedId,selectedVertex}=previous);changed();render();}
  function currentPolygon(){return polygons.find(p=>p.id===(step==="polygon"?selectedId:profile.polygon_id));}
  function boundary(){return currentPolygon()?.geometry.points||[];}
  function ownEquipment(){return equipment.filter(item=>item.polygon_id===profile.polygon_id);}
  function permitted(target){return stages.indexOf(target)<= (profile.registration_status==="ready"?3:stages.indexOf(profile.registration_status));}
  function newPoint(p){return {id:uid(),x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10};}
  function editable(){return draft && !(step==="polygon"&&selectedId);}
  function allMarkers(){return [...(currentPolygon()?.geometry.points||[]),...(ws?.zones||[]).flatMap(z=>z.points),...ownEquipment().map(e=>({markerId:e.marker_id}))].filter(p=>Number.isInteger(p.markerId));}
  function activate(target){
    if(!permitted(target))return;
    if(dirty&&target!==step){notice("Сначала сохраните фигуру в проект и изменения на сервере.",true);return;}
    step=target;draft=null;selectedVertex=-1;history=[];
    if(step==="garage"){releaseCamera();$("background").value="grid";}
    if(step==="polygon"){
      selectedId=profile.polygon_id;
      const p=currentPolygon();draft={points:clone(p?.geometry.points||[]),closed:Boolean(p)};
      $("polygonName").value=p?.name||"";
    }
    $("paintMode").checked=false;
    window.history.replaceState(null,"","setup.html?step="+step);
    notice("");render();
  }
  // Do not use innerHTML for user-supplied names.
  function button(text,action,classes=""){const el=document.createElement("button");el.type="button";el.textContent=text;el.className=classes;el.onclick=()=>run(action);return el;}
  function paragraph(text,classes=""){const el=document.createElement("p");el.textContent=text;el.className=classes;return el;}
  async function run(action){
    if(busy)return;
    busy=true;document.querySelectorAll("footer button,#equipmentForm button").forEach(b=>b.disabled=true);
    document.querySelector("main").inert=true;
    try{await action();}catch(error){notice(error.message,true);}finally{busy=false;document.querySelector("main").inert=false;document.querySelectorAll("footer button,#equipmentForm button").forEach(b=>b.disabled=false);if(profile)render();}
  }
  function renderSaveState(){ $("saveState").textContent=dirty?"Есть несохранённые изменения":"Изменения сохранены";$("undo").disabled=!history.length; }
  function render(){
    $("title").textContent=titles[step];$("description").textContent=descriptions[step];
    $("registrationStatus").textContent="Статус регистрации: "+AppCloud.labels[profile.registration_status];
    $("steps").replaceChildren(...stages.map((s,i)=>{const el=button((i+1)+". "+AppCloud.labels[s],()=>activate(s),s===step?"current":"");el.disabled=!permitted(s);return el;}));
    $("polygonTools").hidden=step!=="polygon";$("garage").hidden=step!=="garage";$("editor").hidden=step==="garage";
    $("zoneKindLabel").hidden=step!=="zones";$("newShape").hidden=!["zones","routes"].includes(step);
    $("newShape").textContent=step==="zones"?"Новая зона":"Новая траектория";
    $("finishShape").hidden=step!=="polygon";$("finishShape").disabled=Boolean(selectedId)||!draft||draft.points.length<3;
    $("clearShape").disabled=!editable();$("deleteVertex").disabled=!editable()||selectedVertex<0;
    $("depthPanel").hidden=step!=="routes";$("shapeProperties").hidden=!draft||step==="polygon";
    $("routeProperties").hidden=step!=="routes";$("listTitle").textContent=step==="polygon"?"Вершины":step==="zones"?"Зоны":"Траектории";
    $("next").textContent=step==="routes"?"Завершить настройку ✓":"Далее →";$("back").disabled=step==="polygon";
    $("save").hidden=step==="garage";$("copyPolygon").disabled=!selectedId;
    $("polygonName").disabled=Boolean(selectedId);
    $("polygonSelect").replaceChildren(new Option("Новый полигон",""),...polygons.map(p=>new Option(p.name,p.id)));
    $("polygonSelect").value=selectedId||"";
    if(step==="garage")renderGarage();
    if(draft&&step!=="polygon"){
      $("shapeName").value=draft.name;$("routeEquipment").replaceChildren(...ownEquipment().map(e=>new Option(e.name,e.id)));
      $("routeEquipment").value=draft.equipmentId||"";$("maxDepth").value=draft.maxDepth??5;$("maxSlope").value=draft.maxSlope??2;
    }
    renderLists();draw();renderSaveState();
  }
  function renderGarage(){
    $("equipmentList").replaceChildren(...ownEquipment().map(item=>{
      const card=document.createElement("article");card.className="equipment-card";
      const title=document.createElement("h2");title.textContent=item.name;
      const image=new Image();image.alt="ArUco ID "+item.marker_id;image.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(ArucoMarker.toSVG(item.marker_id,300));
      card.append(title,paragraph(item.type+" · ArUco ID "+item.marker_id),image,
        button("Скачать SVG",()=>SetupExport.download("equipment-"+item.marker_id+".svg",ArucoMarker.toSVG(item.marker_id,800),"image/svg+xml")),
        button("Удалить",async()=>{await AppCloud.rpc("delete_equipment",{p_id:item.id});equipment=await AppCloud.equipment();profile=await AppCloud.me();render();},"danger"));
      return card;
    }));
    if(!ownEquipment().length)$("equipmentList").append(paragraph("Гараж пока пуст."));
  }
  function renderLists(){
    const list=$("shapeList");list.replaceChildren();
    const collection=step==="zones"?ws.zones:step==="routes"?ws.routes:[];
    collection.forEach((item,index)=>{
      const row=document.createElement("div");row.className="item";
      const text=document.createElement("span");text.className="grow";text.textContent=(kinds[item.kind]?kinds[item.kind]+": ":"")+item.name;
      row.append(text,button("Изменить",()=>{
        if(draft)throw Error("Сначала сохраните текущую фигуру в проект.");
        snapshot();draft={...clone(item),index,closed:true};selectedVertex=-1;render();
      }),button("Удалить",()=>{snapshot();collection.splice(index,1);if(draft?.index===index)draft=null;else if(draft?.index>index)draft.index--;changed();render();},"danger"));
      list.append(row);
    });
    $("vertexList").replaceChildren();
    (draft?.points||[]).forEach((p,i)=>{
      const row=button((i+1)+" / "+(Number.isInteger(p.markerId)?"ID "+p.markerId:"новая")+" · "+Math.round(p.x)+", "+Math.round(p.y),()=>{selectedVertex=i;render();});
      row.style.display="block";$("vertexList").append(row);
    });
    $("validation").replaceChildren();
    if(step==="routes")for(const route of ws.routes){const errors=G.routeErrors(route,boundary(),ws.depth);$("validation").append(paragraph(route.name+": "+(errors.length?errors.join(" "):"Допустима"),errors.length?"error":""));}
    if(step==="zones"){
      const missing=Object.keys(kinds).filter(k=>!ws.zones.some(z=>z.kind===k));
      $("validation").append(paragraph(missing.length?"Ещё нужны: "+missing.map(k=>kinds[k]).join(", "):"Все четыре типа зон созданы."));
    }
  }
  function svg(tag,attributes){const el=document.createElementNS("http://www.w3.org/2000/svg",tag);for(const [key,value]of Object.entries(attributes))el.setAttribute(key,value);return el;}
  function drawShape(points,{closed=true,color="#38bdf8",active=false,fill="none",marker=true}={}){
    if(!points.length)return;
    $("map").append(svg(closed?"polygon":"polyline",{points:points.map(p=>p.x+","+p.y).join(" "),fill,stroke:color,"stroke-width":3,"pointer-events":"none"}));
    if(active)for(let i=0;i<points.length-(closed?0:1);i++){
      const a=points[i],b=points[(i+1)%points.length];
      $("map").append(svg("line",{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:"transparent","stroke-width":22,"data-edge":i,class:"edge"}));
    }
    points.forEach((p,i)=>{
      const group=svg("g",active?{"data-vertex":i,class:"vertex"}:{});
      const knownMarker=marker&&Number.isInteger(p.markerId);
      if(knownMarker)group.append(svg("image",{x:p.x-16,y:p.y-16,width:32,height:32,href:"data:image/svg+xml,"+encodeURIComponent(ArucoMarker.toSVG(p.markerId,32)),"pointer-events":"none"}));
      group.append(svg("circle",{cx:p.x,cy:p.y,r:knownMarker?20:active&&selectedVertex===i?12:8,fill:knownMarker?"transparent":marker?color:"#fbbf24",stroke:knownMarker?color:"#0f172a","stroke-width":active&&selectedVertex===i?4:2}));
      const label=svg("text",{x:p.x+14,y:p.y-12});label.textContent=(i+1)+(Number.isInteger(p.markerId)?" / ID "+p.markerId:"");group.append(label);$("map").append(group);
    });
  }
  function draw(){
    const map=$("map");map.replaceChildren();
    if($("background").value==="grid"){
      const defs=svg("defs",{}),pattern=svg("pattern",{id:"grid",width:50,height:50,patternUnits:"userSpaceOnUse"});
      pattern.append(svg("path",{d:"M 50 0 L 0 0 0 50",fill:"none",stroke:"#283d57","stroke-width":1}));defs.append(pattern);map.append(defs,svg("rect",{width:1000,height:700,fill:"url(#grid)"}));
    }
    if(step==="routes"&&$("showDepth").checked){
      const depth=ws.depth;
      depth.cells.forEach((value,i)=>{
        const x=i%depth.cols*1000/depth.cols,y=Math.floor(i/depth.cols)*700/depth.rows;
        map.append(svg("rect",{x,y,width:1000/depth.cols,height:700/depth.rows,fill:value===null?"#ef4444":"hsl("+(210-Math.min(1,value/10)*170)+" 70% 45%)","fill-opacity":value===null?.65:.18+Math.min(value/20,.4),stroke:"#64748b","stroke-opacity":.2,"pointer-events":"none"}));
      });
    }
    if(step!=="polygon")drawShape(boundary(),{color:"#94a3b8",fill:"#38bdf809"});
    if(step!=="polygon")ws.zones.forEach((zone,i)=>{if(step==="zones"&&draft?.index===i)return;drawShape(zone.points,{color:({warehouse:"#c4b5fd",charging:"#4ade80",mining:"#fb923c",transport:"#60a5fa"})[zone.kind],fill:"#38bdf80a"});});
    if(step==="routes")ws.routes.forEach((route,i)=>{if(draft?.index===i)return;drawShape(route.points,{closed:false,color:G.routeErrors(route,boundary(),ws.depth).length?"#fb7185":"#4ade80",marker:false});});
    if(draft)drawShape(draft.points,{closed:step!=="routes"&&draft.closed,active:Boolean(editable()),marker:step!=="routes",fill:step!=="routes"&&draft.closed?"#38bdf81a":"none"});
    $("deleteVertex").disabled=!editable()||selectedVertex<0;$("finishShape").disabled=!editable()||draft.points.length<3;
  }
  function coordinates(event){const box=$("map").getBoundingClientRect();return{x:Math.max(0,Math.min(1000,(event.clientX-box.left)*1000/box.width)),y:Math.max(0,Math.min(700,(event.clientY-box.top)*700/box.height))};}
  function paint(p){const depth=ws.depth;const value=$("paintBlocked").checked?null:Number($("paintValue").value);if(value!==null&&(!Number.isFinite(value)||value<0||value>1000))throw Error("Глубина должна быть от 0 до 1000.");const col=Math.min(depth.cols-1,Math.floor(p.x/1000*depth.cols)),row=Math.min(depth.rows-1,Math.floor(p.y/700*depth.rows));depth.cells[row*depth.cols+col]=value;changed();draw();renderLists();}
  $("map").addEventListener("pointerdown",event=>{
    if(busy||event.button!==0)return;
    const p=coordinates(event);
    if(step==="routes"&&$("paintMode").checked){snapshot();painting=true;$("map").setPointerCapture(event.pointerId);try{paint(p);}catch(error){notice(error.message,true);}return;}
    if(!editable()){notice("Выберите «Новая зона/траектория» или «Изменить». Для общего полигона сначала создайте копию.");return;}
    const vertex=event.target.closest("[data-vertex]"),edge=event.target.closest("[data-edge]");
    snapshot();
    if(vertex){selectedVertex=Number(vertex.dataset.vertex);drag=selectedVertex;$("map").setPointerCapture(event.pointerId);}
    else if(edge){
      const i=Number(edge.dataset.edge),a=draft.points[i],b=draft.points[(i+1)%draft.points.length];
      draft.points.splice(i+1,0,newPoint(G.nearSegment(p,a,b).point));selectedVertex=i+1;changed();
    }else if(!draft.closed){
      if(draft.points.length>=200){history.pop();notice("Максимум 200 точек.",true);return;}
      if(draft.points.some(q=>Math.hypot(q.x-p.x,q.y-p.y)<2)){history.pop();return;}
      draft.points.push(newPoint(p));selectedVertex=draft.points.length-1;changed();
    }else{history.pop();selectedVertex=-1;}
    draw();renderLists();
  });
  $("map").addEventListener("pointermove",event=>{
    if(painting){try{paint(coordinates(event));}catch(error){notice(error.message,true);}return;}
    if(drag===null||!editable())return;
    Object.assign(draft.points[drag],coordinates(event));changed();draw();
  });
  function endPointer(){drag=null;painting=false;renderLists();renderSaveState();}
  $("map").addEventListener("pointerup",endPointer);$("map").addEventListener("pointercancel",endPointer);
  function deleteVertex(){if(!editable()||selectedVertex<0)return;snapshot();draft.points.splice(selectedVertex,1);selectedVertex=-1;if(draft.points.length<3)draft.closed=false;changed();render();}
  $("deleteVertex").onclick=deleteVertex;$("undo").onclick=undo;
  document.addEventListener("keydown",event=>{if(event.target.matches("input,select,textarea"))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="z"){event.preventDefault();undo();}if(event.key==="Delete")deleteVertex();});
  function releaseCamera(){stream?.getTracks().forEach(t=>t.stop());stream=null;$("camera").srcObject=null;$("camera").hidden=true;$("frozen").hidden=true;$("freezeCamera").hidden=true;$("resumeCamera").hidden=true;}
  $("background").onchange=()=>run(async()=>{
    releaseCamera();
    if($("background").value==="camera"){
      try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"},audio:false});$("camera").srcObject=stream;$("camera").hidden=false;await $("camera").play();$("freezeCamera").hidden=false;}
      catch(error){$("background").value="grid";draw();throw Error("Не удалось включить камеру: "+error.message);}
    }
    draw();
  });
  $("freezeCamera").onclick=()=>{if(!stream)return;$("frozen").getContext("2d").drawImage($("camera"),0,0,1000,700);$("frozen").hidden=false;$("camera").hidden=true;$("resumeCamera").hidden=false;$("freezeCamera").hidden=true;};
  $("resumeCamera").onclick=()=>{$("frozen").hidden=true;$("camera").hidden=false;$("freezeCamera").hidden=false;$("resumeCamera").hidden=true;};
  $("newPolygon").onclick=()=>{snapshot();selectedId=null;draft={points:[],closed:false};$("polygonName").value="";changed();render();};
  $("copyPolygon").onclick=()=>{if(!currentPolygon())return;snapshot();const p=currentPolygon();draft={points:p.geometry.points.map(p=>newPoint(p)),closed:true};selectedId=null;$("polygonName").value=p.name+" — копия";changed();render();};
  $("polygonSelect").onchange=()=>{snapshot();selectedId=$("polygonSelect").value||null;const p=currentPolygon();draft={points:clone(p?.geometry.points||[]),closed:Boolean(p)};$("polygonName").value=p?.name||"";selectedVertex=-1;render();};
  $("finishShape").onclick=()=>{if(!G.validPoints(draft.points))return notice("Граница должна иметь хотя бы три вершины и не пересекаться.",true);snapshot();draft.closed=true;changed();draw();};
  $("clearShape").onclick=()=>{if(!editable())return;snapshot();draft.points=[];draft.closed=false;selectedVertex=-1;changed();render();};
  $("newShape").onclick=()=>{if(draft)return notice("Сначала сохраните текущую фигуру в проект.",true);snapshot();draft={id:uid(),name:step==="zones"?kinds[$("zoneKind").value]:"Траектория "+(ws.routes.length+1),kind:$("zoneKind").value,points:[],closed:false,equipmentId:ownEquipment()[0]?.id,maxDepth:5,maxSlope:2};selectedVertex=-1;render();};
  function applyDraft(){
    if(!draft||step==="polygon")return;
    const closed=step==="zones";
    if(!G.validPoints(draft.points,closed))throw Error(closed?"Нужно не менее трёх вершин без самопересечений.":"Нужно не менее двух разных точек без самопересечений.");
    if(closed&&!G.inPolygon(draft.points,boundary()))throw Error("Зона должна целиком находиться внутри полигона.");
    const name=$("shapeName").value.trim();if(!name)throw Error("Введите название фигуры.");
    snapshot();
    const item={id:draft.id,name,points:clone(draft.points)};
    if(closed)item.kind=draft.kind;
    else Object.assign(item,{equipmentId:$("routeEquipment").value,maxDepth:Number($("maxDepth").value),maxSlope:Number($("maxSlope").value)});
    const collection=closed?ws.zones:ws.routes;
    if(Number.isInteger(draft.index))collection[draft.index]=item;else collection.push(item);
    draft=null;selectedVertex=-1;changed();render();
  }
  $("applyShape").onclick=()=>run(applyDraft);
  for(const id of ["shapeName","maxDepth","maxSlope","routeEquipment"])$(id).addEventListener("input",()=>{if(!draft)return;draft.name=$("shapeName").value;draft.maxDepth=Number($("maxDepth").value);draft.maxSlope=Number($("maxSlope").value);draft.equipmentId=$("routeEquipment").value;changed();});
  $("equipmentForm").onsubmit=event=>{event.preventDefault();run(async()=>{await AppCloud.rpc("create_equipment",{p_name:$("equipmentName").value,p_type:$("equipmentType").value});$("equipmentName").value="";equipment=await AppCloud.equipment();render();notice("Техника сохранена на сервере.");});};
  async function save(){
    if(step==="polygon"){
      if(selectedId)return;
      if(!draft.closed||!G.validPoints(draft.points))throw Error("Замкните корректную границу полигона.");
      const result=await AppCloud.rpc("create_polygon",{p_name:$("polygonName").value,p_points:draft.points});
      polygons.unshift(result);selectedId=result.id;draft={points:clone(result.geometry.points),closed:true};
    }else{
      if(draft)applyDraft();
      ws=await AppCloud.saveWorkspace(ws);profile=await AppCloud.me();
    }
    dirty=false;history=[];notice("Сохранено на сервере.");render();
  }
  $("save").onclick=()=>run(save);
  $("next").onclick=()=>run(async()=>{
    if(step==="polygon"){
      if(!selectedId)await save();
      profile=await AppCloud.selectPolygon(selectedId);ws=await AppCloud.workspace();dirty=false;draft=null;activate("garage");return;
    }
    if(step==="garage"){
      if(!ownEquipment().length)throw Error("Добавьте хотя бы одну единицу техники.");
      if(profile.registration_status==="garage")profile=await AppCloud.advance();
      draft=null;activate("zones");return;
    }
    await save();
    if(step==="zones"){
      if(Object.keys(kinds).some(k=>!ws.zones.some(z=>z.kind===k)))throw Error("Создайте все четыре типа зон.");
      if(profile.registration_status==="zones")profile=await AppCloud.advance();
      activate("routes");return;
    }
    if(!ws.routes.length)throw Error("Создайте хотя бы одну траекторию.");
    if(ws.routes.some(route=>G.routeErrors(route,boundary(),ws.depth).length))throw Error("Исправьте недопустимые траектории.");
    profile=await AppCloud.advance();dirty=false;releaseCamera();location.href="welcome.html";
  });
  $("back").onclick=()=>activate(stages[Math.max(0,stages.indexOf(step)-1)]);
  $("showDepth").onchange=draw;
  $("resizeDepth").onclick=()=>run(()=>{const cols=Number($("depthCols").value),rows=Number($("depthRows").value);const map=G.validateDepth({version:1,width:1000,height:700,cols,rows,cells:Array(Math.max(0,Math.min(10000,cols*rows))).fill(0)});snapshot();ws.depth=map;changed();draw();renderLists();});
  $("exportDepth").onclick=()=>SetupExport.download("pseudo-depth.json",ws.depth);
  $("importDepth").onchange=()=>run(async()=>{const file=$("importDepth").files[0];if(!file)return;if(file.size>2000000)throw Error("Файл карты не должен превышать 2 МБ.");const depth=G.validateDepth(JSON.parse(await file.text()));snapshot();ws.depth=depth;$("depthCols").value=depth.cols;$("depthRows").value=depth.rows;changed();draw();renderLists();$("importDepth").value="";});
  $("exportMarkers").onclick=()=>run(()=>SetupExport.markerPDF(allMarkers()));
  $("exportWorkspace").onclick=()=>SetupExport.download("roi-workspace.json",{version:1,polygon:currentPolygon(),equipment:ownEquipment(),zones:ws?.zones||[],routes:ws?.routes||[],depth:ws?.depth});
  $("logout").onclick=()=>run(async()=>{releaseCamera();try{await AppCloud.logout();}finally{location.href="login.html";}});
  window.addEventListener("pagehide",releaseCamera);window.addEventListener("beforeunload",event=>{if(dirty){event.preventDefault();event.returnValue="";}});
  try{
    if(!AppCloud.configured)throw Error("Для настройки аккаунтов подключите Supabase. Параметры указываются в cloud-config.js; инструкция — supabase/README.md.");
    if(!AppCloud.session()){location.replace("login.html");return;}
    profile=await AppCloud.me();[polygons,equipment,ws]=await Promise.all([AppCloud.polygons(),AppCloud.equipment(),AppCloud.workspace()]);
    ws=ws||{zones:[],routes:[],depth:G.emptyDepth(),revision:0};
    $("account").textContent=profile.name;$("depthCols").value=ws.depth.cols;$("depthRows").value=ws.depth.rows;
    const target=new URLSearchParams(location.search).get("step")||(profile.registration_status==="ready"?"routes":profile.registration_status);
    activate(permitted(target)&&stages.includes(target)?target:profile.registration_status==="ready"?"routes":profile.registration_status);
  }catch(error){notice(error.message,true);$("title").textContent="Не удалось загрузить рабочее пространство";document.querySelectorAll("main button,main input,main select").forEach(el=>el.disabled=true);}
  finally{document.querySelector("main").inert=false;}
})();
