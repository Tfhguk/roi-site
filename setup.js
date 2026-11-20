(async function () {
  "use strict";
  const $=id=>document.getElementById(id), G=SetupGeometry;
  const stages=["polygon","garage","zones","routes"], kinds={warehouse:"Склад",charging:"Зарядная станция",mining:"Зона добычи",transport:"Транспортная зона"};
  const titles={polygon:"Создайте или выберите полигон",garage:"Создайте технику в своём гараже",zones:"Обозначьте рабочие зоны",routes:"Создайте допустимые траектории"};
  const descriptions={polygon:"1. Выберите общий полигон или нажмите «Новый полигон». 2. Задайте название и границу точками. 3. Замкните границу и нажмите «Далее».",garage:"1. Добавьте технику: название, тип и свободный ID. 2. Скачайте и распечатайте её метку. 3. Добавив нужные машины, нажмите «Далее».",zones:"1. Создайте транспортную зону — всю область движения. 2. Внутри неё создайте склад, зарядку и добычу. 3. Сохраните зоны на сервере и вернитесь на главную.",routes:"1. Постройте пути по карте глубины. 2. Выберите карточку техники и при необходимости измените точки её путей. 3. Сохраните и завершите настройку."};
  let profile,polygons=[],equipment=[],ws,step="polygon",selectedId=null,draft=null,selectedVertex=-1,dirty=false,busy=false;
  let stream,drag=null,painting=false,history=[];
  let noticeTimer;
  let selectedEquipmentId=null,hoveredEquipmentId=null;
  let reservations=[],garagePage=0,garageCreating=false,propertiesPane="shapes";
  let garageFocusId=null;
  const pages={shapes:0,vertices:0};
  let tutorialStage=null,tutorialSaving=false,tutorialReturnFocus=null;
  const tutorials={
    polygon:{title:"Выберите площадку для работы",intro:"Полигон — внешняя граница всей площадки. Каждая его вершина получает свою метку.",steps:["Выберите готовый полигон в списке или нажмите «Новый полигон» и задайте название.","Кликами обведите границу. Точки можно двигать; нажатие на ребро добавляет вершину. Для правки готового полигона создайте копию.","Нажмите «Замкнуть границу», затем «Далее». Сохранённый полигон будет доступен другим пользователям."]},
    garage:{title:"Добавьте свою технику",intro:"В гараже хранятся только ваши машины. ID связывает машину с напечатанной меткой.",steps:["Нажмите «Добавить технику». Укажите название и тип машины.","Выберите свободный ID от 0 до 49 или оставьте поле пустым. Номера границ, зон и другой техники этого полигона уже заняты.","Добавьте машину, скачайте её метку и закрепите на машине. ID можно изменить в карточке; после смены распечатайте новую метку. Затем нажмите «Далее»."]},
    zones:{title:"Отметьте места работы техники",intro:"Все рабочие зоны должны находиться внутри транспортной зоны — области, где разрешено движение.",steps:["Выберите тип «Транспортная зона», нажмите «Новая зона» и обведите всю доступную для движения площадку.","Задайте имя и нажмите «Сохранить фигуру в проект». Таким же способом создайте внутри неё склад, зарядную станцию и зону добычи.","Двигайте точки или добавляйте их нажатием на ребро. Список зон доступен в «Зоны и точки». Сохраните на сервере и перейдите на главную."]},
    routes:{title:"Постройте и проверьте пути",intro:"Траектории учитывают транспортную область, глубины, перепады и отступы от меток.",steps:["Выберите ограничения и нажмите «Построить автоматически». Для теста можно сгенерировать карту глубины.","Наведите курсор на карточку машины или нажмите её, чтобы увидеть точки её путей. Кнопка «Изменить» позволяет передвигать точки.","Исправьте недопустимые участки, сохраните изменения и нажмите «Завершить настройку»."]}
  };
  document.querySelector("main").inert=true;
  const clone=value=>structuredClone(value), uid=()=>crypto.randomUUID();
  function notice(text,error=false){
    clearTimeout(noticeTimer);$("message").hidden=!text;if(!text)return;
    $("messageText").textContent=text;$("message").classList.toggle("error",error);
    $("message").setAttribute("role",error?"alert":"status");
    $("notificationTitle").textContent=error?"Ошибка":"Сообщение";$("notificationIcon").textContent=error?"!":"✓";
    if(!error)noticeTimer=setTimeout(()=>{$("message").hidden=true;},6000);
  }
  $("dismissNotification").onclick=()=>notice("");
  function fitStage(){
    if($("editorWindow").hidden)return;
    const box=$("canvasFit"),stage=box.querySelector(".stage");
    const width=Math.max(1,Math.min(box.clientWidth-2,(box.clientHeight-2)*10/7));
    stage.style.width=width+"px";stage.style.height=width*7/10+"px";
  }
  function setBackgroundInert(value){for(const selector of [".heading","#polygonTools","#garage","#drawingLauncher"])document.querySelector(selector).inert=value;}
  function openEditor(){
    if(step==="garage"||!profile)return;
    const wasHidden=$("editorWindow").hidden;
    $("editorWindow").hidden=false;$("editorBackdrop").hidden=false;document.body.classList.add("editor-open");
    $("editorWindow").append($("actions"));setBackgroundInert(true);window.scrollTo(0,0);
    fitStage();requestAnimationFrame(fitStage);
    if(wasHidden)$("closeEditor").focus({preventScroll:true});
  }
  function closeEditor(focus=true){
    $("editorWindow").hidden=true;$("editorBackdrop").hidden=true;document.body.classList.remove("editor-open");
    $("pageActions").append($("actions"));setBackgroundInert(false);
    $("editorWindow").classList.remove("properties-open");$("toggleProperties").setAttribute("aria-expanded","false");
    releaseCamera();$("background").value="grid";drag=null;painting=false;
    if(focus&&!$("drawingLauncher").hidden)$("openEditor").focus({preventScroll:true});
  }
  $("openEditor").onclick=openEditor;$("closeEditor").onclick=()=>closeEditor();$("editorBackdrop").onclick=()=>closeEditor();
  $("toggleProperties").onclick=()=>{const open=$("editorWindow").classList.toggle("properties-open");$("toggleProperties").setAttribute("aria-expanded",String(open));};
  $("closeProperties").onclick=()=>{$("editorWindow").classList.remove("properties-open");$("toggleProperties").setAttribute("aria-expanded","false");};
  $("propertiesTabs").onclick=event=>{const pane=event.target.dataset.pane;if(pane){propertiesPane=pane;updatePropertiesPanes();}};
  const layoutObserver=new ResizeObserver(()=>{
    const header=document.querySelector("header");
    document.documentElement.style.setProperty("--header-height",header.getBoundingClientRect().height+"px");
    document.documentElement.style.setProperty("--chrome-height",(header.getBoundingClientRect().height+$("steps").getBoundingClientRect().height)+"px");
    fitStage();
  });
  layoutObserver.observe(document.querySelector("header"));layoutObserver.observe($("steps"));
  new ResizeObserver(fitStage).observe($("canvasFit"));
  new ResizeObserver(()=>document.documentElement.style.setProperty("--actions-height",$("actions").getBoundingClientRect().height+"px")).observe($("actions"));
  document.addEventListener("keydown",event=>{
    if($("stageTutorial").open)return;
    if($("editorWindow").hidden)return;
    if(event.key==="Escape"){event.preventDefault();closeEditor();return;}
    if(event.key!=="Tab")return;
    const controls=[...document.querySelectorAll("header a,header button,#steps button,#editorWindow button,#editorWindow input,#editorWindow select,#editorWindow summary,#map,#notificationCenter button")].filter(el=>!el.disabled&&el.getClientRects().length);
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  });
  function changed(){dirty=true;$("saveState").textContent="Есть несохранённые изменения";}
  function snapshot(){history.push({draft:clone(draft),ws:clone(ws),selectedId,selectedVertex});if(history.length>80)history.shift();}
  function undo(){const previous=history.pop();if(!previous)return;({draft,ws,selectedId,selectedVertex}=previous);changed();render();}
  function currentPolygon(){return polygons.find(p=>p.id===(step==="polygon"?selectedId:profile.polygon_id));}
  function boundary(){return currentPolygon()?.geometry.points||[];}
  function drivingAreas(){return (ws?.zones||[]).filter(z=>z.kind==="transport").map(z=>z.points);}
  function routeNumber(route,index=ws.routes.indexOf(route)){return route.number||index+1;}
  function nextRouteNumber(routes=ws.routes){return Math.max(0,...routes.map((r,i)=>routeNumber(r,i)))+1;}
  function checkRoute(route){return [...G.routeErrors({boundaryClearance:5,markerClearance:40,...route},boundary(),ws.depth,drivingAreas(),G.safetyContext(boundary(),drivingAreas(),G.routingMarkers(boundary(),ws.zones))),...G.vehicleRouteErrors(route,ws.zones,ownEquipment().find(e=>e.id===route.equipmentId))];}
  const routeColors=["#4ade80","#38bdf8","#fbbf24","#c4b5fd","#fb923c","#f472b6"];
  function routeColor(route){return routeColors[Math.max(0,ownEquipment().findIndex(e=>e.id===route.equipmentId))%routeColors.length];}
  function ownEquipment(){return equipment.filter(item=>item.polygon_id===profile.polygon_id);}
  function permitted(target){return (target!=="routes"||AppCloud.routesEnabled)&&stages.indexOf(target)<= (profile.registration_status==="ready"?3:stages.indexOf(profile.registration_status));}
  function newPoint(p){return {id:uid(),x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10};}
  function editable(){return draft && !(step==="polygon"&&selectedId);}
  function allMarkers(){return [...(currentPolygon()?.geometry.points||[]),...(ws?.zones||[]).flatMap(z=>z.points),...ownEquipment().map(e=>({markerId:e.marker_id}))].filter(p=>Number.isInteger(p.markerId));}
  function tutorialPicture(stage){
    const start='<svg viewBox="0 0 480 260" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="tutorialGrid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#334155"/></pattern></defs><rect width="480" height="260" rx="14" fill="#101e31"/><rect width="480" height="260" fill="url(#tutorialGrid)"/>';
    const outline='<path class="tutorial-outline" d="M65 205L90 55L390 45L420 205Z" fill="#38bdf814" stroke="#38bdf8" stroke-width="4"/>';
    const points=[[65,205],[90,55],[390,45],[420,205]].map(([x,y],i)=>'<circle class="tutorial-dot dot-'+i+'" cx="'+x+'" cy="'+y+'" r="7" fill="#38bdf8" stroke="#e2e8f0" stroke-width="2"/>').join('');
    let drawing;
    if(stage==='polygon')drawing=outline+points+'<circle class="tutorial-cursor" r="12" fill="#fff" fill-opacity=".7"/><text x="120" y="240">Обведите границу точками</text>';
    else if(stage==='garage')drawing='<g class="tutorial-machine"><rect x="50" y="55" width="380" height="150" rx="12" fill="#1e293b" stroke="#64748b"/><path d="M80 120h65v-30h35l25 40v30H80Z" fill="#38bdf8"/><circle cx="105" cy="166" r="14" fill="#0f172a" stroke="#cbd5e1"/><circle cx="180" cy="166" r="14" fill="#0f172a" stroke="#cbd5e1"/><text x="235" y="95">Самосвал</text><rect class="tutorial-id" x="235" y="112" width="160" height="42" rx="7" fill="#164e63" stroke="#38bdf8"/><text x="255" y="140">ID 5 — свободен</text><text x="235" y="184">Добавить технику</text></g>';
    else if(stage==='zones')drawing=outline+'<g class="tutorial-zone z-1"><rect x="105" y="85" width="95" height="75" rx="4" fill="#c4b5fd66" stroke="#c4b5fd"/><text x="119" y="127">Склад</text></g><g class="tutorial-zone z-2"><rect x="220" y="85" width="75" height="75" rx="4" fill="#4ade8066" stroke="#4ade80"/><text x="225" y="127">Зарядка</text></g><g class="tutorial-zone z-3"><rect x="315" y="85" width="75" height="75" rx="4" fill="#fb923c66" stroke="#fb923c"/><text x="320" y="127">Добыча</text></g><text x="110" y="240">Внутри области движения</text>';
    else drawing=outline+'<rect x="105" y="90" width="65" height="70" fill="#c4b5fd55"/><rect x="330" y="90" width="65" height="70" fill="#fb923c55"/><path class="tutorial-outline" d="M138 125L210 175L285 175L362 125" fill="none" stroke="#4ade80" stroke-width="5"/><circle class="tutorial-traveller" r="9" fill="#fbbf24"/><text x="125" y="240">Путь можно редактировать</text>';
    return start+drawing+'</svg>';
  }
  function showTutorial(manual=false){
    if(!profile||!tutorials[step]||step==="routes"&&!AppCloud.routesEnabled)return;
    if(!manual&&(profile.registration_status==="ready"||(profile.tutorial_seen||[]).includes(step)))return;
    if($("stageTutorial").open)return;
    tutorialStage=step;tutorialReturnFocus=document.activeElement;
    $("tutorialError").hidden=true;
    const data=tutorials[step];$("tutorialTitle").textContent=data.title;$("tutorialIntro").textContent=data.intro;
    $("tutorialStage").textContent="Этап "+(stages.indexOf(step)+1)+" · "+({polygon:"Полигон",garage:"Гараж",zones:"Зоны",routes:"Траектории"})[step];
    $("tutorialSteps").replaceChildren(...data.steps.map(text=>{const item=document.createElement("li");item.textContent=text;return item;}));
    $("tutorialAnimation").innerHTML=tutorialPicture(step);
    $("stageTutorial").showModal();
  }
  async function finishTutorial(){
    if(tutorialSaving)return;tutorialSaving=true;
    for(const id of ["tutorialContinue","tutorialClose"])$(id).disabled=true;
    try{
      if(!(profile.tutorial_seen||[]).includes(tutorialStage))profile=await AppCloud.rpc("mark_stage_tutorial",{p_stage:tutorialStage});
      $("stageTutorial").close();if(tutorialReturnFocus?.isConnected)tutorialReturnFocus.focus({preventScroll:true});
    }catch(error){$("tutorialError").textContent=error.message;$("tutorialError").hidden=false;}
    finally{tutorialSaving=false;for(const id of ["tutorialContinue","tutorialClose"])$(id).disabled=false;}
  }
  $("openTutorial").onclick=()=>showTutorial(true);
  $("tutorialContinue").onclick=finishTutorial;$("tutorialClose").onclick=finishTutorial;
  $("stageTutorial").addEventListener("cancel",event=>{event.preventDefault();finishTutorial();});
  function activate(target){
    if(!permitted(target))return;
    if(dirty&&target!==step){notice("Сначала сохраните фигуру в проект и изменения на сервере.",true);return;}
    step=target;draft=null;selectedVertex=-1;history=[];
    pages.shapes=0;pages.vertices=0;propertiesPane=step==="polygon"?"vertices":"shapes";
    if(step==="garage")garageCreating=!ownEquipment().length;
    closeEditor(false);
    if(step==="polygon"){
      selectedId=profile.polygon_id;
      const p=currentPolygon();draft={points:clone(p?.geometry.points||[]),closed:Boolean(p)};
      $("polygonName").value=p?.name||"";
    }
    $("paintMode").checked=false;
    window.history.replaceState(null,"","setup.html?step="+step);
    notice("");render();
    if(step!=="garage"&&(step!=="polygon"||selectedId))openEditor();
    if(step==="routes"&&!ws.routes.length){try{createAutoRoutes(ws.depth.cells.every(v=>v===0));}catch(error){notice(error.message,true);}}
    showTutorial();
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
    if(selectedEquipmentId&&!ownEquipment().some(vehicle=>vehicle.id===selectedEquipmentId))selectedEquipmentId=null;
    hoveredEquipmentId=null;
    $("title").textContent=titles[step];$("description").textContent=descriptions[step];
    document.body.dataset.step=step;
    $("editorWindow").classList.toggle("drawing-layout",step==="polygon"||step==="zones");
    (step==="polygon"||step==="zones"?$("editorWindow"):$("editorPropertiesSlot")).append($("editorProperties"));
    (step==="zones"?$("zonePropertiesDock"):$("shapePropertiesSlot")).append($("shapeProperties"));
    $("registrationStatus").textContent="Статус регистрации: "+AppCloud.labels[profile.registration_status];
    const shortLabels={polygon:"Полигон",garage:"Гараж",zones:"Зоны",routes:"Траектории"};
    $("steps").replaceChildren(...stages.map((s,i)=>{const el=button((i+1)+". "+shortLabels[s],()=>{if(step===s)openEditor();else activate(s);},s===step?"current":"");el.disabled=!permitted(s);el.setAttribute("aria-current",s===step?"step":"false");return el;}));
    $("polygonTools").hidden=step!=="polygon";$("garage").hidden=step!=="garage";$("editor").hidden=step==="garage";
    $("drawingLauncher").hidden=step==="garage";$("openEditor").textContent=shortLabels[step];$("editorTitle").textContent=shortLabels[step];
    $("polygonNameLabel").hidden=step!=="polygon";
    $("drawingSummary").textContent=step==="polygon"?(selectedId?currentPolygon()?.name:"Новый полигон")+" · вершин: "+(draft?.points.length||0):step==="zones"?"Зон: "+ws.zones.length:"Траекторий: "+ws.routes.length;
    $("zoneKindLabel").hidden=step!=="zones";$("newShape").hidden=!["zones","routes"].includes(step);
    const hasTransport=ws.zones.some(zone=>zone.kind==="transport");
    $("zoneKind").querySelector('option[value="transport"]').disabled=hasTransport;
    if(hasTransport&&$("zoneKind").value==="transport"&&!draft)$("zoneKind").value="warehouse";
    $("newShape").textContent=step==="zones"?"Новая зона":"Новая траектория";
    $("finishShape").hidden=step!=="polygon";$("finishShape").disabled=Boolean(selectedId)||!draft||draft.points.length<3;
    $("clearShape").disabled=!editable();$("deleteVertex").disabled=!editable()||selectedVertex<0;
    $("depthPanel").hidden=step!=="routes";$("shapeProperties").hidden=!draft||step==="polygon";
    $("editorWindow").classList.toggle("routes-layout",step==="routes");
    $("toggleProperties").textContent=step==="routes"?"Траектории и свойства":step==="zones"?"Зоны и точки":"Точки";
    $("autoRoutes").hidden=step!=="routes";
    const plannedEquipment=$("plannerEquipment").value;
    $("plannerEquipment").replaceChildren(new Option("Вся моя техника",""),...ownEquipment().map(e=>new Option(e.name,e.id)));
    if(ownEquipment().some(e=>e.id===plannedEquipment))$("plannerEquipment").value=plannedEquipment;
    $("depthSource").textContent=ws.depth.source==="synthetic"?"Тестовая карта · seed "+ws.depth.seed:"Карта проекта";
    $("routeProperties").hidden=step!=="routes";$("listTitle").textContent=step==="polygon"?"Вершины":step==="zones"?"Зоны":"Траектории";
    $("routeClearances").hidden=step!=="routes";$("routeLegend").hidden=step!=="routes";
    $("next").textContent=step==="routes"?"Завершить настройку ✓":step==="zones"&&!AppCloud.routesEnabled?"На главную →":"Далее →";$("back").disabled=step==="polygon";
    $("save").hidden=step==="garage";$("copyPolygon").disabled=!selectedId;
    const ownsPolygon=currentPolygon()?.owner_id===profile.id;
    $("polygonName").disabled=Boolean(selectedId)&&!ownsPolygon;
    $("renamePolygon").hidden=step!=="polygon"||!selectedId||!ownsPolygon;
    $("polygonSelect").replaceChildren(new Option("Новый полигон",""),...polygons.map(p=>new Option(p.name,p.id)));
    $("polygonSelect").value=selectedId||"";
    if(step==="garage")renderGarage();
    if(draft&&step!=="polygon"){
      $("shapeName").value=draft.name;$("routeEquipment").replaceChildren(...ownEquipment().map(e=>new Option(e.name,e.id)));
      $("routeEquipment").value=draft.equipmentId||"";$("maxDepth").value=draft.maxDepth??5;$("maxSlope").value=draft.maxSlope??2;
      $("boundaryClearance").value=draft.boundaryClearance??5;$("markerClearance").value=draft.markerClearance??40;
    }
    renderLists();renderRouteLegend();draw();renderSaveState();fitStage();
  }
  function pageItems(container,pager,elements,key,size){
    const count=Math.max(1,Math.ceil(elements.length/size));
    const page=Math.min(key==="garage"?garagePage:pages[key],count-1);
    if(key==="garage")garagePage=page;else pages[key]=page;
    container.replaceChildren(...elements.slice(page*size,(page+1)*size));pager.replaceChildren();
    pager.hidden=count<=1;
    if(count>1){
      const change=delta=>{if(key==="garage"){garagePage=page+delta;renderGarage();}else{pages[key]=page+delta;renderLists();}};
      const previous=button("←",()=>change(-1)),next=button("→",()=>change(1));previous.disabled=page===0;next.disabled=page===count-1;
      previous.setAttribute("aria-label","Предыдущая страница");next.setAttribute("aria-label","Следующая страница");
      const label=document.createElement("span");label.textContent=(page+1)+" / "+count;pager.append(previous,label,next);
    }
  }
  function updatePropertiesPanes(){
    const legacy=step==="routes";
    $("propertiesTabs").hidden=legacy;
    for(const [id,pane]of [["shapeList","shapes"],["shapePager","shapes"],["vertexList","vertices"],["vertexPager","vertices"]]){
      const element=$(id);element.hidden=!legacy&&(propertiesPane!==pane||(pane==="shapes"&&step==="polygon"));
      if(id.endsWith("Pager")&&element.childElementCount===0)element.hidden=true;
    }
    document.querySelector('[data-pane="shapes"]').hidden=step==="polygon";
    document.querySelector('[data-pane="properties"]').hidden=step!=="routes";
    for(const tab of $("propertiesTabs").querySelectorAll("button"))tab.setAttribute("aria-pressed",String(tab.dataset.pane===propertiesPane));
    $("validation").hidden=!legacy;
  }
  async function refreshEquipment(){
    [equipment,reservations]=await Promise.all([AppCloud.equipment(),AppCloud.markerReservations(profile.polygon_id)]);
  }
  function markerValue(input,current=null){
    input.removeAttribute("aria-invalid");
    if(input.value.trim()==="")return null;
    const value=Number(input.value);
    if(!Number.isInteger(value)||value<0||value>49){input.setAttribute("aria-invalid","true");throw Error("Укажите целый ID от 0 до 49.");}
    if(value!==current&&reservations.some(row=>row.marker_id===value)){input.setAttribute("aria-invalid","true");throw Error("ID "+value+" уже занят в этом полигоне. Выберите другой ID.");}
    return value;
  }
  $("openEquipmentForm").onclick=()=>{garageCreating=true;renderGarage();$("equipmentName").focus();};
  $("cancelEquipmentForm").onclick=()=>{garageCreating=false;renderGarage();};
  function renderGarage(){
    $("equipmentCreate").hidden=!garageCreating;$("equipmentList").hidden=garageCreating;$("openEquipmentForm").hidden=garageCreating;
    const list=$("equipmentList"),short=innerHeight<=500;
    const columns=Math.max(1,Math.floor(((list.clientWidth||$("garage").clientWidth)+10)/(short?360:340)));
    const rows=Math.max(1,Math.floor((Math.max(0,list.clientHeight-36)+10)/((short?100:180)+10)));
    const pageSize=columns*rows;
    list.style.setProperty("--garage-columns",columns);
    if(garageFocusId){garagePage=Math.max(0,Math.floor(ownEquipment().findIndex(item=>item.id===garageFocusId)/pageSize));garageFocusId=null;}
    const cards=ownEquipment().map(item=>{
      const card=document.createElement("article");card.className="equipment-card";
      card.dataset.type=item.type==="excavator"?"bulldozer":item.type==="robot"?"charging_station":item.type;
      const title=document.createElement("h2");title.textContent=item.name;
      const image=new Image();image.alt="ID "+item.marker_id;image.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(ArucoMarker.toSVG(item.marker_id,300));
      const role=G.equipmentRole(item.type);
      const idForm=document.createElement("form");idForm.className="equipment-id-form controls";idForm.noValidate=true;
      const label=document.createElement("label");label.textContent="ID";
      const input=document.createElement("input");input.type="number";input.min="0";input.max="49";input.step="1";input.value=item.marker_id;input.setAttribute("aria-label","ID техники "+item.name);label.append(input);
      const apply=document.createElement("button");apply.type="submit";apply.textContent="Изменить ID";idForm.append(label,apply);
      idForm.onsubmit=event=>{event.preventDefault();run(async()=>{
        await refreshEquipment();const id=markerValue(input,item.marker_id);if(id===null)throw Error("Укажите ID от 0 до 49.");
        await AppCloud.rpc("set_equipment_marker",{p_id:item.id,p_marker_id:id});await refreshEquipment();render();notice("ID сохранён. Скачайте и распечатайте новую метку для этой машины.");
      });};
      const info=document.createElement("div");info.className="equipment-info";info.append(title,paragraph(role.label,"muted"),idForm);
      const actions=document.createElement("div");actions.className="equipment-actions";actions.append(
        button("Скачать SVG",()=>SetupExport.download("equipment-"+item.marker_id+".svg",ArucoMarker.toSVG(item.marker_id,800),"image/svg+xml")),
        button("Удалить",async()=>{await AppCloud.rpc("delete_equipment",{p_id:item.id});await refreshEquipment();profile=await AppCloud.me();render();},"danger"));
      card.append(image,info,actions);
      return card;
    });
    pageItems(list,$("garagePager"),cards,"garage",pageSize);$("garagePager").hidden=garageCreating||cards.length<=pageSize;
    if(!ownEquipment().length)$("equipmentList").append(paragraph("Гараж пока пуст."));
  }
  function renderLists(){
    const list=$("shapeList");list.replaceChildren();
    const collection=step==="zones"?ws.zones:step==="routes"?ws.routes:[];
    if(step==="routes")list.append(...ownEquipment().map(vehicle=>equipmentRouteCard(vehicle)));
    else collection.forEach((item,index)=>{
      const row=document.createElement("div");row.className="item";
      const text=document.createElement("span");text.className="grow";text.textContent=(kinds[item.kind]?kinds[item.kind]+": ":"")+item.name;
      row.append(text,button("Изменить",()=>{
        if(draft)throw Error("Сначала сохраните текущую фигуру в проект.");
        snapshot();draft={...clone(item),index,closed:true};selectedVertex=-1;render();$("editorWindow").classList.add("properties-open");$("toggleProperties").setAttribute("aria-expanded","true");
      }),button("Удалить",()=>{snapshot();collection.splice(index,1);if(draft?.index===index)draft=null;else if(draft?.index>index)draft.index--;changed();render();},"danger"));
      list.append(row);
    });
    $("vertexList").replaceChildren();
    (draft?.points||[]).forEach((p,i)=>{
      const row=button((i+1)+" / "+(Number.isInteger(p.markerId)?"ID "+p.markerId:"новая")+" · "+Math.round(p.x)+", "+Math.round(p.y),()=>{selectedVertex=i;render();});
      row.style.display="block";$("vertexList").append(row);
    });
    $("validation").replaceChildren();
    if(step==="routes")for(const route of ws.routes){const errors=checkRoute(route);$("validation").append(paragraph(route.name+": "+(errors.length?errors.join(" "):"Допустима"),errors.length?"error":""));}
    if(step==="zones"){
      const missing=Object.keys(kinds).filter(k=>!ws.zones.some(z=>z.kind===k));
      $("validation").append(paragraph(missing.length?"Ещё нужны: "+missing.map(k=>kinds[k]).join(", "):"Все четыре типа зон созданы."));
      for(const error of G.zoneErrors(ws.zones,boundary()))$("validation").append(paragraph(error,"error"));
    }
    if(step!=="routes"){
      const available=Math.max(50,$("editorWindow").clientHeight-150);
      pageItems(list,$("shapePager"),Array.from(list.children),"shapes",Math.max(1,Math.min(4,Math.floor(available/90))));
      pageItems($("vertexList"),$("vertexPager"),Array.from($("vertexList").children),"vertices",Math.max(1,Math.min(6,Math.floor(available/43))));
    }
    updatePropertiesPanes();
    $("zoneChecklist").hidden=step!=="zones";
    $("zoneChecklist").textContent=Object.entries(kinds).map(([kind,name])=>(ws.zones.some(zone=>zone.kind===kind)?"✓ ":"○ ")+name).join(" · ");
    const tips={transport:"Обведите всю площадку, где разрешено движение техники.",warehouse:"Обведите склад внутри транспортной зоны.",charging:"Обведите место зарядки внутри транспортной зоны.",mining:"Обведите зону добычи внутри транспортной зоны."};
    $("editorHint").textContent=step==="zones"?(draft?tips[draft.kind]+" Клик — точка; перетаскивание — сдвиг; клик на ребре — новая точка. Затем «Сохранить фигуру».":"Выберите тип зоны сверху и нажмите «Новая зона». Список созданных зон — в кнопке «Зоны и точки»."):step==="polygon"?"Клик — вершина; перетаскивание — сдвиг; клик на ребре — новая вершина. После обвода нажмите «Замкнуть границу» и «Далее».":"Выберите технику, затем «Изменить». Перетаскивайте точки пути; нажимайте на ребро, чтобы добавить точку.";
  }
  function activeEquipment(){return hoveredEquipmentId||selectedEquipmentId;}
  function updateEquipmentPreview(){
    const active=activeEquipment();
    document.querySelectorAll(".equipment-route-card").forEach(card=>{
      card.classList.toggle("route-focused",card.dataset.equipmentId===active);
      card.querySelector(".equipment-route-select").setAttribute("aria-pressed",String(card.dataset.equipmentId===selectedEquipmentId));
    });
    draw();
  }
  function editRoute(id){
    if(draft)throw Error("Сначала сохраните текущую фигуру в проект.");
    const index=ws.routes.findIndex(route=>route.id===id);if(index<0)return;
    snapshot();draft={...clone(ws.routes[index]),index,closed:true};selectedEquipmentId=draft.equipmentId;selectedVertex=-1;
    render();$("editorWindow").classList.add("properties-open");$("toggleProperties").setAttribute("aria-expanded","true");
  }
  function deleteRoute(id){
    const index=ws.routes.findIndex(route=>route.id===id);if(index<0)return;
    snapshot();ws.routes.splice(index,1);
    if(draft?.index===index)draft=null;else if(draft?.index>index)draft.index--;
    changed();render();
  }
  function equipmentRouteCard(vehicle){
    const card=document.createElement("article");card.className="equipment-route-card";card.dataset.equipmentId=vehicle.id;
    card.style.setProperty("--route-color",routeColor({equipmentId:vehicle.id}));
    const select=document.createElement("button");select.type="button";select.className="equipment-route-select";
    select.setAttribute("aria-pressed",String(vehicle.id===selectedEquipmentId));
    const marker=new Image();marker.alt="ArUco ID "+vehicle.marker_id;marker.src="data:image/svg+xml,"+encodeURIComponent(ArucoMarker.toSVG(vehicle.marker_id,40));
    const title=document.createElement("span");title.className="grow";
    const name=document.createElement("strong");name.textContent=vehicle.name;
    const role=document.createElement("small");role.textContent=G.equipmentRole(vehicle.type).label+" · ArUco ID "+vehicle.marker_id;
    title.append(name,role);select.append(marker,title);card.append(select);
    const choose=()=>{selectedEquipmentId=selectedEquipmentId===vehicle.id?null:vehicle.id;updateEquipmentPreview();};
    select.onclick=choose;card.onclick=event=>{if(!event.target.closest("button"))choose();};
    card.onpointerenter=event=>{if(event.pointerType==="touch")return;hoveredEquipmentId=vehicle.id;updateEquipmentPreview();};
    card.onpointerleave=()=>{if(hoveredEquipmentId===vehicle.id)hoveredEquipmentId=null;updateEquipmentPreview();};
    card.onfocusin=()=>{hoveredEquipmentId=vehicle.id;updateEquipmentPreview();};
    card.onfocusout=event=>{if(!card.contains(event.relatedTarget)){if(hoveredEquipmentId===vehicle.id)hoveredEquipmentId=null;updateEquipmentPreview();}};
    const routes=ws.routes.filter(route=>route.equipmentId===vehicle.id);
    for(const route of routes){
      const row=document.createElement("div");row.className="item route-list-item";row.dataset.routeId=route.id;
      const text=document.createElement("span");text.className="grow";text.textContent=route.name;
      row.append(text,button("Изменить",()=>editRoute(route.id)),button("Удалить",()=>deleteRoute(route.id),"danger"));card.append(row);
    }
    if(!routes.length)card.append(paragraph("Нет траекторий","muted"));
    card.classList.toggle("route-focused",vehicle.id===activeEquipment());return card;
  }
  function renderRouteLegend(){
    $("routeLegendItems").replaceChildren(...ownEquipment().map(vehicle=>equipmentRouteCard(vehicle)));
  }
  function svg(tag,attributes){const el=document.createElementNS("http://www.w3.org/2000/svg",tag);for(const [key,value]of Object.entries(attributes))el.setAttribute(key,value);return el;}
  function drawShape(points,{closed=true,color="#38bdf8",active=false,fill="none",marker=true,showVertices=true,showVertexLabels=true,strokeWidth=3,opacity=1,routeId}={}){
    if(!points.length)return;
    $("map").append(svg(closed?"polygon":"polyline",{points:points.map(p=>p.x+","+p.y).join(" "),fill,stroke:color,"stroke-width":strokeWidth,opacity,...(routeId?{"data-route-id":routeId}:{}),"pointer-events":"none"}));
    if(active)for(let i=0;i<points.length-(closed?0:1);i++){
      const a=points[i],b=points[(i+1)%points.length];
      $("map").append(svg("line",{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:"transparent","stroke-width":22,"data-edge":i,class:"edge"}));
    }
    if(showVertices)points.forEach((p,i)=>{
      const group=svg("g",active?{"data-vertex":i,class:"vertex"}:{});
      const knownMarker=marker&&Number.isInteger(p.markerId);
      if(knownMarker)group.append(svg("image",{x:p.x-16,y:p.y-16,width:32,height:32,href:"data:image/svg+xml,"+encodeURIComponent(ArucoMarker.toSVG(p.markerId,32)),"pointer-events":"none"}));
      group.append(svg("circle",{cx:p.x,cy:p.y,r:knownMarker?20:active&&selectedVertex===i?12:8,fill:knownMarker?"transparent":marker?color:"#fbbf24",stroke:knownMarker?color:"#0f172a","stroke-width":active&&selectedVertex===i?4:2}));
      if(showVertexLabels){const label=svg("text",{x:p.x+14,y:p.y-12});label.textContent=(i+1)+(Number.isInteger(p.markerId)?" / ID "+p.markerId:"");group.append(label);}$("map").append(group);
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
    if(step!=="polygon")ws.zones.map((zone,i)=>({zone,i})).sort((a,b)=>(a.zone.kind!=="transport")-(b.zone.kind!=="transport")).forEach(({zone,i})=>{if(step==="zones"&&draft?.index===i)return;drawShape(zone.points,{color:({warehouse:"#c4b5fd",charging:"#4ade80",mining:"#fb923c",transport:"#60a5fa"})[zone.kind],fill:zone.kind==="transport"?"#38bdf81a":"#38bdf80a"});});
    if(step==="routes")ws.routes.forEach((route,i)=>{
      if(draft?.index===i)return;
      const focused=activeEquipment()===route.equipmentId;
      drawShape(route.points,{closed:false,color:checkRoute(route).length?"#fb7185":routeColor(route),marker:false,showVertices:false,routeId:route.id,strokeWidth:focused?6:3,opacity:activeEquipment()&&!focused?0.25:1});
      if(focused){const group=svg("g",{class:"route-points","data-route-id":route.id,"pointer-events":"none"});for(const point of route.points)group.append(svg("circle",{cx:point.x,cy:point.y,r:7,fill:routeColor(route),stroke:"#0f172a","stroke-width":2}));map.append(group);}
    });
    if(draft)drawShape(draft.points,{closed:step!=="routes"&&draft.closed,active:Boolean(editable()),marker:step!=="routes",showVertexLabels:step!=="routes",fill:step!=="routes"&&draft.closed?"#38bdf81a":"none"});
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
  $("newPolygon").onclick=()=>{snapshot();selectedId=null;draft={points:[],closed:false};$("polygonName").value="";$("polygonName").removeAttribute("aria-invalid");changed();render();openEditor();};
  $("copyPolygon").onclick=()=>{if(!currentPolygon())return;snapshot();const p=currentPolygon();draft={points:p.geometry.points.map(p=>newPoint(p)),closed:true};selectedId=null;$("polygonName").value=Array.from(p.name+" — копия").slice(0,100).join("");changed();render();openEditor();};
  $("polygonSelect").onchange=()=>{snapshot();selectedId=$("polygonSelect").value||null;const p=currentPolygon();draft={points:clone(p?.geometry.points||[]),closed:Boolean(p)};$("polygonName").value=p?.name||"";$("polygonName").removeAttribute("aria-invalid");selectedVertex=-1;render();openEditor();};
  $("polygonName").addEventListener("input",()=>{$("polygonName").removeAttribute("aria-invalid");if(!selectedId||currentPolygon()?.owner_id===profile.id)changed();});
  function closePolygonShape(){
    if(!editable())return;
    if(!G.validPoints(draft.points))throw Error("Граница должна иметь хотя бы три вершины и не пересекаться.");
    snapshot();draft.closed=true;changed();draw();
  }
  $("finishShape").onclick=()=>run(closePolygonShape);
  const contextMenu=$("mapContextMenu");
  function hideMapMenu(){contextMenu.hidden=true;}
  $("map").addEventListener("contextmenu",event=>{
    event.preventDefault();if(busy||!editable())return;
    const action=$("contextFinishShape");action.textContent=step==="polygon"?"Замкнуть фигуру":step==="zones"?"Замкнуть и завершить фигуру":"Завершить траекторию";
    action.disabled=draft.points.length<(step==="routes"?2:3);
    contextMenu.hidden=false;
    const box=contextMenu.getBoundingClientRect();
    contextMenu.style.left=Math.max(5,Math.min(event.clientX,innerWidth-box.width-5))+"px";
    contextMenu.style.top=Math.max(5,Math.min(event.clientY,innerHeight-box.height-5))+"px";
    action.focus({preventScroll:true});
  });
  $("contextFinishShape").onclick=()=>{hideMapMenu();run(()=>{if(step==="polygon")closePolygonShape();else applyDraft();$("map").focus({preventScroll:true});});};
  document.addEventListener("pointerdown",event=>{if(!contextMenu.contains(event.target))hideMapMenu();});
  document.addEventListener("keydown",event=>{if(!contextMenu.hidden&&event.key==="Escape"){event.preventDefault();event.stopImmediatePropagation();hideMapMenu();$("map").focus({preventScroll:true});}},true);
  window.addEventListener("resize",hideMapMenu);
  $("clearShape").onclick=()=>{if(!editable())return;snapshot();draft.points=[];draft.closed=false;selectedVertex=-1;changed();render();};
  $("newShape").onclick=()=>{if(draft)return notice("Сначала сохраните текущую фигуру в проект.",true);if(step==="zones"&&$("zoneKind").value==="transport"&&ws.zones.some(zone=>zone.kind==="transport"))return notice("Транспортная зона уже создана. Измените её через «Зоны и точки».",true);snapshot();draft={id:uid(),name:step==="zones"?kinds[$("zoneKind").value]:"Траектория "+(ws.routes.length+1),kind:$("zoneKind").value,points:[],closed:false,equipmentId:ownEquipment()[0]?.id,maxDepth:5,maxSlope:2};selectedVertex=-1;$("editorWindow").classList.remove("properties-open");$("toggleProperties").setAttribute("aria-expanded","false");render();};
  function applyDraft(){
    if(!draft||step==="polygon")return;
    const closed=step==="zones";
    if(closed&&draft.kind==="transport"&&ws.zones.some((zone,index)=>zone.kind==="transport"&&index!==draft.index))throw Error("В проекте полигона допускается только одна транспортная зона. Измените существующую.");
    if(!G.validPoints(draft.points,closed))throw Error(closed?"Нужно не менее трёх вершин без самопересечений.":"Нужно не менее двух разных точек без самопересечений.");
    if(closed&&!G.inPolygon(draft.points,boundary()))throw Error("Зона должна целиком находиться внутри полигона.");
    if(closed&&draft.kind!=="transport"&&drivingAreas().length&&!G.inAreas(draft.points,drivingAreas(),true))throw Error("Склад, зарядная станция и добыча должны находиться внутри транспортной зоны.");
    const name=$("shapeName").value.trim();if(!name)throw Error("Введите название фигуры.");
    if(!closed&&(Number($("boundaryClearance").value)<1||Number($("markerClearance").value)<24))throw Error("Отступ от границы должен быть не меньше 1, от центра арукомаркера — не меньше 24 единиц карты.");
    snapshot();
    const item={id:draft.id,name,points:clone(draft.points)};
    if(closed)item.kind=draft.kind;
    else Object.assign(item,{equipmentId:$("routeEquipment").value,maxDepth:Number($("maxDepth").value),maxSlope:Number($("maxSlope").value),number:draft.number||nextRouteNumber(),boundaryClearance:Number($("boundaryClearance").value),markerClearance:Number($("markerClearance").value),bidirectional:draft.bidirectional!==false,purpose:"manual"});
    const collection=closed?ws.zones:ws.routes;
    if(Number.isInteger(draft.index))collection[draft.index]=item;else collection.push(item);
    draft=null;selectedVertex=-1;changed();render();
  }
  $("applyShape").onclick=()=>run(applyDraft);
  function createAutoRoutes(newMap=false){
    if(draft)throw Error("Сначала сохраните редактируемую фигуру в проект.");
    const limits={maxDepth:Number($("plannerMaxDepth").value),maxSlope:Number($("plannerMaxSlope").value),boundaryClearance:Number($("plannerBoundaryClearance").value),markerClearance:Number($("plannerMarkerClearance").value)};
    if(limits.boundaryClearance<1||limits.markerClearance<24)throw Error("Отступ от границы должен быть не меньше 1, от центра арукомаркера — не меньше 24 единиц карты.");
    const depth=newMap?G.generateDepth(boundary(),ws.zones,crypto.getRandomValues(new Uint32Array(1))[0],40,28,limits):ws.depth;
    const vehicles=ownEquipment().filter(e=>!$("plannerEquipment").value||e.id===$("plannerEquipment").value);
    const result=G.planRoutes(boundary(),ws.zones,vehicles,depth,limits);
    if(newMap&&result.unreachable.length)throw Error("Тестовая карта не обеспечивает все соединения зон. Прежние карта и пути сохранены. "+result.unreachable.join("; "));
    if(!result.routes.length)throw Error("Нет допустимого прохода между зонами при заданной глубине и перепаде. Проверьте карту и увеличьте разрешение сетки при узких проходах. "+result.unreachable.slice(0,5).join("; "));
    const routes=result.routes.map((route,i)=>({...route,number:nextRouteNumber()+i,id:uid(),points:route.points.map(p=>({...p,id:uid()}))}));
    // Changing one vehicle keeps every other vehicle's edited routes.
    const retained=$("plannerEquipment").value?ws.routes.filter(route=>route.equipmentId!==$("plannerEquipment").value):[];
    if(routes.length+retained.length>30)throw Error("Максимум 30 траекторий в проекте. Удалите ненужные пути перед построением.");
    snapshot();ws.depth=depth;ws.routes=[...retained,...routes];selectedEquipmentId=null;hoveredEquipmentId=null;selectedVertex=-1;$("paintMode").checked=false;
    $("depthCols").value=depth.cols;$("depthRows").value=depth.rows;changed();render();
    notice((newMap?"Тестовая карта создана. ":"")+"Построено траекторий: "+routes.length+". Их можно редактировать и сохранить на сервере."+
      (result.unreachable.length?"\nНет прохода: "+result.unreachable.slice(0,5).join("; ")+". Проверьте препятствия и ограничения.":""),Boolean(result.unreachable.length));
  }
  $("autoRoutes").onclick=()=>run(()=>{
    if(ws.routes.length&&!confirm("Перестроить траектории выбранной техники по текущей карте? Их ручные изменения будут заменены. Другие пути сохранятся."))return;
    createAutoRoutes();
  });
  $("generateDepth").onclick=()=>run(()=>{
    if((ws.routes.length||ws.depth.cells.some(v=>v!==0))&&!confirm("Создать новую тестовую карту и перестроить траектории выбранной техники? Текущая карта и ручные изменения этих путей будут заменены."))return;
    createAutoRoutes(true);
  });
  for(const id of ["shapeName","maxDepth","maxSlope","routeEquipment","boundaryClearance","markerClearance"])$(id).addEventListener("input",()=>{if(!draft)return;draft.name=$("shapeName").value;draft.maxDepth=Number($("maxDepth").value);draft.maxSlope=Number($("maxSlope").value);draft.equipmentId=$("routeEquipment").value;draft.boundaryClearance=Number($("boundaryClearance").value);draft.markerClearance=Number($("markerClearance").value);changed();draw();renderLists();});
  $("equipmentForm").noValidate=true;
  $("equipmentForm").onsubmit=event=>{event.preventDefault();run(async()=>{
    if(!$("equipmentName").value.trim())throw Error("Введите название техники.");
    await refreshEquipment();const id=markerValue($("equipmentMarkerId"));
    const item=await AppCloud.rpc("create_equipment_with_id",{p_name:$("equipmentName").value,p_type:$("equipmentType").value,p_marker_id:id});
    $("equipmentName").value="";$("equipmentMarkerId").value="";await refreshEquipment();garageCreating=false;garageFocusId=item.id;render();notice("Техника сохранена. Скачайте её метку и разместите на машине.");
  });};
  async function save(){
    if(step==="polygon"){
      if(selectedId&&currentPolygon()?.owner_id!==profile.id)return;
      const name=$("polygonName").value.trim();
      if(!name||Array.from(name).length>100){openEditor();$("polygonName").setAttribute("aria-invalid","true");requestAnimationFrame(()=>$("polygonName").focus());throw Error("Введите название полигона: от 1 до 100 символов.");}
      if(selectedId){
        if(name!==currentPolygon().name){const result=await AppCloud.rpc("rename_polygon",{p_id:selectedId,p_name:name});polygons=polygons.map(item=>item.id===result.id?result:item);}
        dirty=false;history=[];notice("Название сохранено.");render();return;
      }
      if(!draft.closed||!G.validPoints(draft.points))throw Error("Замкните корректную границу полигона.");
      const result=await AppCloud.rpc("create_polygon",{p_name:name,p_points:draft.points});
      polygons.unshift(result);selectedId=result.id;draft={points:clone(result.geometry.points),closed:true};
    }else{
      if(draft)applyDraft();
      ws=await AppCloud.saveWorkspace(ws);profile=await AppCloud.me();
    }
    dirty=false;history=[];notice("Сохранено на сервере.");render();
  }
  $("save").onclick=()=>run(save);
  $("renamePolygon").onclick=()=>run(save);
  $("next").onclick=()=>run(async()=>{
    if(step==="polygon"){
      await save();
      profile=await AppCloud.selectPolygon(selectedId);ws=await AppCloud.workspace();await refreshEquipment();dirty=false;draft=null;activate("garage");return;
    }
    if(step==="garage"){
      if(!ownEquipment().length)throw Error("Добавьте хотя бы одну единицу техники.");
      if(profile.registration_status==="garage")profile=await AppCloud.advance();
      draft=null;activate("zones");return;
    }
    await save();
    if(step==="zones"){
      if(Object.keys(kinds).some(k=>!ws.zones.some(z=>z.kind===k)))throw Error("Создайте все четыре типа зон.");
      const errors=G.zoneErrors(ws.zones,boundary());if(errors.length)throw Error(errors.join("\n"));
      if(profile.registration_status==="zones")profile=await AppCloud.advance();
      if(!AppCloud.routesEnabled){dirty=false;releaseCamera();location.href="welcome.html";return;}
      activate("routes");return;
    }
    if(!ws.routes.length)throw Error("Создайте хотя бы одну траекторию.");
    if(ws.routes.some(route=>checkRoute(route).length))throw Error("Исправьте недопустимые траектории.");
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
    if(profile.polygon_id)reservations=await AppCloud.markerReservations(profile.polygon_id);
    ws=ws||{zones:[],routes:[],depth:G.emptyDepth(),revision:0};
    const usedNumbers=new Set(ws.routes.filter(r=>Number.isInteger(r.number)&&r.number>0).map(r=>r.number));let number=1;
    for(const route of ws.routes)if(!route.number){while(usedNumbers.has(number))number++;route.number=number;usedNumbers.add(number);}
    $("routeLegend").open=matchMedia("(min-width: 1000px)").matches;
    $("account").textContent=profile.name;$("depthCols").value=ws.depth.cols;$("depthRows").value=ws.depth.rows;
    const fallback=["ready","routes"].includes(profile.registration_status)?(AppCloud.routesEnabled?"routes":"zones"):profile.registration_status;
    const target=new URLSearchParams(location.search).get("step")||fallback;
    activate(permitted(target)&&stages.includes(target)?target:fallback);
    if(target==="routes"&&!AppCloud.routesEnabled)notice("Раздел «Траектории» временно отключён.");
  }catch(error){notice(error.message,true);$("title").textContent="Не удалось загрузить рабочее пространство";document.querySelectorAll("main button,main input,main select").forEach(el=>el.disabled=true);}
  finally{document.querySelector("main").inert=false;}
  let resizeFrame;
  window.addEventListener("resize",()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(profile&&ws){if(step==="garage")renderGarage();renderLists();fitStage();}});});
})();
