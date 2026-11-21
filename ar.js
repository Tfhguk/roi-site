(()=>{
 'use strict';
 const A=ARApi,$=id=>document.getElementById(id),clone=x=>structuredClone(x),ns='http://www.w3.org/2000/svg';
 const stageText={mount_pending:['Нужен монтаж','Закрепите камеры и проектор. Продолжите настройку в программе AR.'],stereo_required:['Нужна стереокалибровка','Выполните стереокалибровку камер в программе AR.'],floor_required:['Нужна калибровка пола','Освободите пол и запустите калибровку нулевой плоскости.'],projector_required:['Нужна калибровка проектора','Примите 3D-калибровку проектора в программе AR.'],ready:['AR готов','Проверьте границу на предпросмотре и примените настройки.']};
 let client=null,epoch=0,pollSerial=0,timer,connectionAbort,state=null,draft=null,confirmed=null,healthy=false,previewGood=false,busy=false,pending=null,lastFrame=null,lastError='',lastServerError='',mode='edit',selected=-1,history=[],drag=null;
 const fields=$('settingsForm').elements;
 const text=(id,value)=>$(id).textContent=value;
 function toast(error){const message=error.message||String(error);$('toast').querySelector('span').textContent=(error.field?'Поле «'+error.field+'»: ':'')+message;$('toast').hidden=false;}
 $('toast').querySelector('button').onclick=()=>$('toast').hidden=true;
 function storageRead(key){try{return JSON.parse(localStorage.getItem(key));}catch{return null;}}
 function storageWrite(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}
 const draftKey=()=>client?'roi_ar_draft_v1:'+client.address:null;
 function saveDraft(){if(draft&&state?.projection)storageWrite(draftKey(),{binding:confirmed,draft:clone(draft)});}
 function fullVertices(p){const a=p.available_rect;return [[a[0]/p.width,a[1]/p.height],[a[2]/p.width,a[1]/p.height],[a[2]/p.width,a[3]/p.height],[a[0]/p.width,a[3]/p.height]];}
 function defaults(s){return {schema_version:1,height_range_m:[0,.5],above_range:'black',palette_gamma:.5,update_interval_s:1,roi:{coordinate_space:'projector_normalized',vertices:fullVertices(s.projection)}};}
 function fromSettings(value,dirty=false){draft={values:clone(value),vertices:clone(value.roi.vertices),closed:true,dirty,baseRevision:state.settings_revision};history=[];selected=-1;mode='edit';fillFields();}
 function fillFields(){if(!draft)return;fields.height_min.value=draft.values.height_range_m[0];fields.height_max.value=draft.values.height_range_m[1];fields.palette_gamma.value=draft.values.palette_gamma;fields.update_interval_s.value=draft.values.update_interval_s;}
 function readFields(){return {...draft.values,height_range_m:[Number(fields.height_min.value),Number(fields.height_max.value)],palette_gamma:Number(fields.palette_gamma.value),update_interval_s:Number(fields.update_interval_s.value),roi:{coordinate_space:'projector_normalized',vertices:clone(draft.vertices)}};}
 function canEdit(){return !!(client&&healthy&&draft&&state?.projection&&!busy&&!pending);}
 function remember(){history.push({vertices:clone(draft.vertices),closed:draft.closed});if(history.length>50)history.shift();}
 function changed(){draft.values=readFields();draft.dirty=true;saveDraft();draw();render();text('editorStatus',draft.closed?'Граница замкнута. Изменения отправляются кнопкой «Применить к проектору».':'Добавляйте вершины кликами. Правая кнопка мыши замыкает границу.');}
 function fit(){if(!state?.projection)return;const host=$('previewHost'),p=state.projection,s=Math.min(host.clientWidth/p.width,host.clientHeight/p.height);Object.assign($('projectorFrame').style,{width:p.width*s+'px',height:p.height*s+'px'});}
 new ResizeObserver(()=>{fit();draw();}).observe($('previewHost'));
 function draw(){
  if(!draft||!state?.projection)return;const p=state.projection,svg=$('editor'),a=p.available_rect;svg.setAttribute('viewBox',`0 0 ${p.width} ${p.height}`);const r=$('availableOutline');for(const [k,v]of Object.entries({x:a[0],y:a[1],width:a[2]-a[0],height:a[3]-a[1]}))r.setAttribute(k,v);
  const pts=draft.vertices;$('roiShape').setAttribute('d',pts.map((v,i)=>(i?'L':'M')+v[0]*p.width+' '+v[1]*p.height).join(' ')+(draft.closed?' Z':''));$('roiShape').setAttribute('fill',draft.closed?'#38bdf822':'none');$('handles').replaceChildren();
  const radius=5/Math.max(.05,$('projectorFrame').clientWidth/p.width);
  pts.forEach((v,i)=>{const c=document.createElementNS(ns,'circle');for(const [k,value]of Object.entries({cx:v[0]*p.width,cy:v[1]*p.height,r:radius,fill:i===selected?'#fbbf24':'#38bdf8',stroke:'#0f172a','stroke-width':1,'vector-effect':'non-scaling-stroke'}))c.setAttribute(k,value);$('handles').append(c);});
  text('geometryStatus',pts.length+' / 32 вершин · '+(draft.closed?'замкнуто':'не замкнуто'));
  for(const id of ['polygon','rectangle'])$(id).setAttribute('aria-pressed',String(mode===id));
 }
 function render(){
  const edit=canEdit(),ready=healthy&&state?.stage==='ready'&&state?.projection?.calibration_3d_accepted===true,needsBinding=draft&&state?.projection&&confirmed!==A.binding(state);
  for(const id of ['polygon','rectangle','fullField','clear'])$(id).disabled=!edit;
  $('undo').disabled=!edit||!history.length;$('deleteVertex').disabled=!edit||selected<0;$('closeShape').disabled=!edit||draft.closed||draft.vertices.length<3;
  $('settingsFields').disabled=!edit;$('reloadSettings').disabled=!edit||!state.settings;
  $('apply').disabled=!edit||!ready||!previewGood||!draft.closed||!!needsBinding;
  $('confirmBinding').hidden=!needsBinding;$('confirmBinding').disabled=!edit||!draft.closed||!previewGood;
  $('rescan').disabled=!ready||busy||!!pending;$('calibrateFloor').disabled=!healthy||busy||!!pending||!['floor_required','projector_required','ready'].includes(state?.stage);
  $('startFloor').disabled=$('calibrateFloor').disabled;
  if(!client)text('applyStatus','Нет подключения');else if(!healthy)text('applyStatus','Нет связи с AR. Последнее изображение не обновляется.');else if(pending)text('applyStatus','Настройки приняты. Ожидание подтверждённого изображения…');else if(needsBinding)text('applyStatus','Калибровка изменилась. Проверьте границу и подтвердите её привязку.');else if(!previewGood)text('applyStatus','Ожидание актуального предпросмотра проектора.');else if(!ready)text('applyStatus','Сначала завершите калибровку AR.');else text('applyStatus',draft?.dirty?'Есть изменения. Примените их к проектору.':'Настройки совпадают с AR.');
  if(state){const [title,description]=stageText[state.stage];text('arStage',title);text('stageDescription',description);text('imageSize',state.projection?state.projection.width+' × '+state.projection.height:'—');text('projectionRevision',state.projection_revision??'—');$('projectionRevision').title=String(state.projection_revision??'');text('snapshotInfo',state.snapshot?state.snapshot.id+' / '+state.snapshot.age_s.toFixed(1)+' с':'—');const m=state.metrics||{};text('checkFrequency',Number.isFinite(m.check_hz)?m.check_hz.toFixed(1)+' Гц':'—');text('updateCount',Number.isSafeInteger(m.update_count)?String(m.update_count):'—');const percent=x=>Number.isFinite(x)&&x>=0&&x<=1?Math.round(x*100)+'%':'—';text('surfaceCoverage',percent(m.measured_fraction)+' / '+percent(m.filled_fraction));}
 }
 function receive(s){
  const before=state?.projection?A.binding(state):null,next=s.projection?A.binding(s):null;state=s;healthy=true;
  if(next){
   if(before&&before!==next){confirmed=null;previewGood=false;lastFrame=null;pending=null;if(draft)draft.dirty=true;$('preview').getContext('2d').clearRect(0,0,$('preview').width,$('preview').height);text('editorStatus','Изменилась калибровка или поле проектора. Проверьте расположение границы.');toast(new Error('Изменилась калибровка проектора. Прежняя граница не применяется автоматически.'));}
   if(!draft){const saved=storageRead(draftKey());if(saved?.binding===next&&saved.draft?.values){try{A.settings({...saved.draft.values,roi:{coordinate_space:'projector_normalized',vertices:saved.draft.vertices}},s.projection);if(saved.draft.closed!==true)throw Error();draft=clone(saved.draft);draft.dirty=true;fillFields();}catch{draft=null;}}if(!draft)fromSettings(s.settings||defaults(s),!s.settings);confirmed=next;}
   else if(!draft.dirty&&!pending&&s.settings&&String(draft.baseRevision)!==String(s.settings_revision))fromSettings(s.settings);
   $('projectorFrame').hidden=false;$('empty').hidden=true;fit();draw();
  }else{previewGood=false;$('projectorFrame').hidden=true;$('empty').hidden=false;text('empty','AR пока не передал размер и доступное поле проектора. Завершите подготовку установки.');}
  const errors=JSON.stringify(s.errors||[]);if(errors!==lastServerError){lastServerError=errors;if(s.errors?.length)toast(new Error(s.errors.map(e=>typeof e==='string'?e:e.message||'Ошибка AR').join('\n')));}
  render();
 }
 function snapshotKey(s){return s.snapshot?JSON.stringify([s.snapshot.id,s.snapshot.projection_revision,s.snapshot.settings_revision]):null;}
 async function preview(version,signal,ticket){
  const s=state,key=snapshotKey(s);if(!s.projection||!key)return;
  if(String(s.snapshot.projection_revision)!==String(s.projection_revision)||String(s.snapshot.settings_revision)!==String(s.settings_revision)){previewGood=false;text('previewStatus','Ожидание кадра текущей калибровки и настроек');render();return;}
  if(key===lastFrame){previewGood=true;render();return;}
  const f=await client.preview(signal);if(version!==epoch||ticket!==pollSerial)return;
  if(String(f.snapshotId)!==String(s.snapshot.id)||String(f.projectionRevision)!==String(s.projection_revision)||String(f.projectionRevision)!==String(s.snapshot.projection_revision)||String(f.settingsRevision)!==String(s.snapshot.settings_revision)){
   previewGood=false;text('previewStatus','Ожидание кадра текущей калибровки и настроек');render();return;
  }
  const image=await createImageBitmap(f.blob);try{if(version!==epoch||ticket!==pollSerial)return;if(image.width!==s.projection.width||image.height!==s.projection.height)throw new A.ApiError('Размер предпросмотра не совпадает с полем проектора.','preview');const canvas=$('preview');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);}finally{image.close();}
  lastFrame=key;previewGood=true;text('previewStatus','Снимок '+s.snapshot.id+' · '+(client.demo?'демонстрация':'изображение AR'));
  if(pending&&String(s.settings_revision)===String(pending.settings_revision)&&String(s.snapshot.settings_revision)===String(pending.settings_revision)&&s.snapshot.id>=pending.snapshot_id){draft.dirty=false;draft.baseRevision=s.settings_revision;draft.values=readFields();pending=null;saveDraft();}
  render();
 }
 async function poll(version){
  if(version!==epoch||!client)return;const signal=connectionAbort.signal,ticket=++pollSerial;
  try{const s=await client.state(signal);if(version!==epoch||ticket!==pollSerial)return;receive(s);text('connectionStatus',(client.demo?'Демонстрация':'Подключено')+' · '+stageText[s.stage][0]);await preview(version,signal,ticket);if(ticket===pollSerial)lastError='';}
  catch(error){if(version!==epoch||ticket!==pollSerial||error.name==='AbortError')return;if(!error.field||!['preview','response'].includes(error.field)){healthy=false;previewGood=false;text('connectionStatus','Нет связи с AR');}else{previewGood=false;text('previewStatus','Предпросмотр недоступен');}if(error.message!==lastError){toast(error);lastError=error.message;}render();}
  if(version!==epoch||ticket!==pollSerial)return;
  if(pending&&Date.now()-pending.at>10000){pending=null;toast(new Error('Сервер принял настройки, но актуальное изображение не подтверждено. Проверьте состояние AR перед повторной отправкой.'));render();}
  if(version===epoch&&ticket===pollSerial)timer=setTimeout(()=>poll(version),healthy?1000:3000);
 }
 function disconnect(){epoch++;pollSerial++;clearTimeout(timer);connectionAbort?.abort();client=null;healthy=false;previewGood=false;pending=null;busy=false;drag=null;$('floorDialog').close();$('disconnect').hidden=true;$('connect').textContent='Подключиться';text('connectionStatus','Не подключено');text('modeNote','Подключение запускается вручную. Демо работает без оборудования.');text('previewStatus','Отключено · последнее изображение');render();}
 function begin(value){disconnect();client=value;state=null;draft=null;confirmed=null;lastFrame=null;history=[];lastError='';lastServerError='';connectionAbort=new AbortController();$('toast').hidden=true;$('projectorFrame').hidden=true;$('empty').hidden=false;text('empty','Загрузка состояния AR…');$('disconnect').hidden=false;text('connectionStatus',value.demo?'Демонстрация · загрузка':'Подключение…');text('modeNote',value.demo?'Демонстрация: изображение и калибровка тестовые. Оборудование не подключено.':'AR: '+value.address+' · данные установки не отправляются в Supabase');poll(epoch);}
 $('connectionForm').onsubmit=e=>{e.preventDefault();try{const value=new A.Client($('apiAddress').value);storageWrite('roi_ar_address_v1',value.address);begin(value);}catch(error){toast(error);}};
 const savedAddress=storageRead('roi_ar_address_v1');if(typeof savedAddress==='string')$('apiAddress').value=savedAddress;
 $('disconnect').onclick=disconnect;
 function framePoint(event){const r=$('editor').getBoundingClientRect();return [(event.clientX-r.left)/r.width,(event.clientY-r.top)/r.height];}
 function inField(v){const p=state.projection,a=p.available_rect;return v[0]*p.width>=a[0]&&v[0]*p.width<=a[2]&&v[1]*p.height>=a[1]&&v[1]*p.height<=a[3];}
 function clampPoint(v){const p=state.projection,a=p.available_rect;return [Math.max(a[0]/p.width,Math.min(a[2]/p.width,v[0])),Math.max(a[1]/p.height,Math.min(a[3]/p.height,v[1]))];}
 function nearest(v){const r=$('editor').getBoundingClientRect(),distance=(a,b)=>Math.hypot((a[0]-b[0])*r.width,(a[1]-b[1])*r.height);let vertex=-1,edge=-1,best=11;draft.vertices.forEach((p,i)=>{const d=distance(v,p);if(d<best){vertex=i;best=d;}});if(vertex>=0)return {vertex};best=9;if(draft.closed)draft.vertices.forEach((a,i)=>{const b=draft.vertices[(i+1)%draft.vertices.length],x=(b[0]-a[0])*r.width,y=(b[1]-a[1])*r.height,t=Math.max(0,Math.min(1,(((v[0]-a[0])*r.width)*x+((v[1]-a[1])*r.height)*y)/(x*x+y*y||1))),q=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t],d=distance(v,q);if(d<best){edge=i;best=d;}});return {vertex,edge};}
 function closeShape(){if(!canEdit()||draft.closed)return;try{A.roi(draft.vertices,state.projection);remember();draft.closed=true;mode='edit';changed();text('editorStatus','Граница замкнута. Проверьте настройки и нажмите «Применить к проектору».');}catch(error){toast(error);}}
 $('polygon').onclick=()=>{if(!canEdit())return;remember();draft.vertices=[];draft.closed=false;mode='polygon';selected=-1;changed();text('editorStatus','Добавляйте вершины кликами. Правая кнопка мыши замыкает границу.');};
 $('rectangle').onclick=()=>{mode='rectangle';draw();text('editorStatus','Зажмите левую кнопку внутри доступного поля и протяните прямоугольник.');};
 $('fullField').onclick=()=>{remember();draft.vertices=fullVertices(state.projection);draft.closed=true;selected=-1;mode='edit';changed();};
 $('clear').onclick=()=>{remember();draft.vertices=[];draft.closed=false;selected=-1;mode='polygon';changed();};
 $('closeShape').onclick=closeShape;
 $('undo').onclick=()=>{if(!history.length||!canEdit())return;Object.assign(draft,history.pop());selected=-1;mode=draft.closed?'edit':'polygon';changed();};
 function deleteVertex(){if(selected<0||!canEdit())return;remember();draft.vertices.splice(selected,1);if(draft.vertices.length<3)draft.closed=false;else if(draft.closed){try{A.roi(draft.vertices,state.projection);}catch(error){Object.assign(draft,history.pop());toast(error);return;}}selected=-1;changed();}
 $('deleteVertex').onclick=deleteVertex;
 const svg=$('editor');for(const type of ['contextmenu','dragstart','selectstart'])svg.addEventListener(type,event=>{event.preventDefault();if(type==='contextmenu')closeShape();});
 svg.onpointerdown=event=>{
  if(event.button!==0||!canEdit())return;event.preventDefault();svg.focus({preventScroll:true});const v=framePoint(event);if(!inField(v)){toast(new A.ApiError('Рисуйте внутри пунктирного поля проектора.','roi'));return;}
  const hit=nearest(v);if(mode!=='rectangle'&&hit.vertex===0&&!draft.closed&&draft.vertices.length>=3){closeShape();return;}
  if(mode==='rectangle'){drag={kind:'rectangle',start:v,before:{vertices:clone(draft.vertices),closed:draft.closed}};draft.vertices=[v,v,v,v];draft.closed=true;}
  else if(hit.vertex>=0){selected=hit.vertex;drag={kind:'vertex',before:{vertices:clone(draft.vertices),closed:draft.closed}};}
  else if(hit.edge>=0){if(draft.vertices.length>=32){toast(new A.ApiError('Максимум 32 вершины.','roi'));return;}remember();draft.vertices.splice(hit.edge+1,0,v);selected=hit.edge+1;changed();}
  else if(!draft.closed){if(draft.vertices.length>=32){toast(new A.ApiError('Максимум 32 вершины.','roi'));return;}const previous=draft.vertices.at(-1);if(previous&&Math.hypot(previous[0]-v[0],previous[1]-v[1])<1e-7)return;remember();draft.vertices.push(v);selected=draft.vertices.length-1;changed();}
  if(drag)svg.setPointerCapture(event.pointerId);draw();render();
 };
 svg.onpointermove=event=>{if(!drag||!canEdit())return;const v=clampPoint(framePoint(event));if(drag.kind==='vertex')draft.vertices[selected]=v;else{const a=drag.start;draft.vertices=[[Math.min(a[0],v[0]),Math.min(a[1],v[1])],[Math.max(a[0],v[0]),Math.min(a[1],v[1])],[Math.max(a[0],v[0]),Math.max(a[1],v[1])],[Math.min(a[0],v[0]),Math.max(a[1],v[1])]];}draw();};
 function finishDrag(cancel=false){if(!drag)return;const before=drag.before;drag=null;if(cancel){Object.assign(draft,before);draw();render();return;}try{if(draft.closed)A.roi(draft.vertices,state.projection);history.push(before);if(history.length>50)history.shift();mode=draft.closed?'edit':mode;changed();}catch(error){Object.assign(draft,before);draw();render();toast(error);}}
 svg.onpointerup=event=>{finishDrag();if(svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);};svg.onpointercancel=()=>finishDrag(true);svg.onlostpointercapture=()=>finishDrag(true);
 svg.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();finishDrag(true);}if(['Delete','Backspace'].includes(event.key)){event.preventDefault();deleteVertex();}if(event.key==='Enter'){event.preventDefault();closeShape();}};
 $('settingsForm').addEventListener('input',()=>{if(draft)changed();});
 $('confirmBinding').onclick=()=>{try{A.roi(draft.vertices,state.projection);confirmed=A.binding(state);saveDraft();render();}catch(error){toast(error);}};
 $('reloadSettings').onclick=()=>{if(!canEdit()||!state.settings)return;fromSettings(state.settings);confirmed=A.binding(state);saveDraft();draw();render();};
 $('settingsForm').onsubmit=async event=>{
  event.preventDefault();if($('apply').disabled)return;const version=epoch;
  try{const candidate=A.settings({...readFields(),request_id:crypto.randomUUID(),projection_revision:state.projection_revision,expected_settings_revision:draft.baseRevision},state.projection);busy=true;render();const reply=await client.apply(candidate,state.projection,connectionAbort.signal);if(version!==epoch)return;draft.values=clone(candidate);pending={...reply,at:Date.now()};lastFrame=null;clearTimeout(timer);await poll(version);}
  catch(error){if(version===epoch&&error.name!=='AbortError')toast(error);}finally{if(version===epoch){busy=false;render();}}
 };
 async function action(name){const version=epoch;if(!client||!healthy||busy||pending||(name==='rescan'?$('rescan'):$('calibrateFloor')).disabled)return;busy=true;render();try{await client.action(name,{schema_version:1,request_id:crypto.randomUUID(),projection_revision:state.projection_revision},connectionAbort.signal);if(version!==epoch)return;clearTimeout(timer);await poll(version);}catch(error){if(version===epoch&&error.name!=='AbortError')toast(error);}finally{if(version===epoch){busy=false;render();}}}
 $('rescan').onclick=()=>action('rescan');$('calibrateFloor').onclick=()=>$('floorDialog').showModal();$('cancelFloor').onclick=()=>$('floorDialog').close();$('startFloor').onclick=()=>{$('floorDialog').close();action('calibrate-floor');};
 $('help').onclick=()=>$('helpDialog').showModal();$('closeHelp').onclick=()=>$('helpDialog').close();
 function panel(value){document.body.dataset.panel=value;for(const button of document.querySelectorAll('.view-tabs button'))button.setAttribute('aria-pressed',String(button.dataset.panel===value));fit();draw();}
 for(const button of document.querySelectorAll('.view-tabs button'))button.onclick=()=>panel(button.dataset.panel);
 const compact=matchMedia('(max-width:900px)');if(!compact.matches)panel('settings');compact.addEventListener('change',()=>{if(!compact.matches&&document.body.dataset.panel==='map')panel('settings');});
 class DemoClient{
  constructor(){this.demo=true;this.address='demo';this.phase=0;this.captured=Date.now();this.value={schema_version:1,stage:'ready',projection_revision:'demo-projector-1',projection:{width:1280,height:800,available_rect:[227,0,1053,800],calibration_3d_accepted:true},settings_revision:1,metrics:{check_hz:1,update_count:1,measured_fraction:.94,filled_fraction:.04},errors:[]};this.value.settings=defaults(this.value);this.frame=1;}
  async state(){if(this.floorUntil&&Date.now()>=this.floorUntil){this.floorUntil=null;this.value.stage='ready';this.value.projection.calibration_3d_accepted=true;this.value.projection_revision='demo-projector-'+Date.now();this.captured=Date.now();this.frame++;}return A.state({...clone(this.value),snapshot:{id:this.frame,age_s:(Date.now()-this.captured)/1000,projection_revision:this.value.projection_revision,settings_revision:this.value.settings_revision}});}
  async apply(request,p){A.settings(request,p);if(request.projection_revision!==this.value.projection_revision)throw new A.ApiError('Калибровка проектора изменилась.','projection_revision',409);if(String(request.expected_settings_revision)!==String(this.value.settings_revision))throw new A.ApiError('Настройки изменены. Нажмите «Взять настройки AR» и повторите редактирование.','expected_settings_revision',409);this.value.settings=clone(request);this.value.settings_revision++;return {request_id:request.request_id,settings_revision:this.value.settings_revision,snapshot_id:this.frame};}
  async action(name,request){if(name==='rescan'){this.phase+=.7;this.captured=Date.now();this.frame++;this.value.metrics.update_count++;}else{this.value.stage='floor_required';this.value.projection.calibration_3d_accepted=false;this.floorUntil=Date.now()+2000;}return {request_id:request.request_id,accepted:true,action_id:crypto.randomUUID()};}
  async preview(){
   const meta={snapshotId:String(this.frame),projectionRevision:String(this.value.projection_revision),settingsRevision:String(this.value.settings_revision)},p=this.value.projection,settings=this.value.settings,canvas=document.createElement('canvas');canvas.width=p.width;canvas.height=p.height;const ctx=canvas.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,p.width,p.height);ctx.save();ctx.beginPath();settings.roi.vertices.forEach((v,i)=>i?ctx.lineTo(v[0]*p.width,v[1]*p.height):ctx.moveTo(v[0]*p.width,v[1]*p.height));ctx.closePath();ctx.clip();const a=p.available_rect;
   for(let y=a[1];y<a[3];y+=8)for(let x=a[0];x<a[2];x+=8){const u=(x-a[0])/(a[2]-a[0]),v=y/p.height,h=.23+.19*Math.sin(u*6+this.phase)*Math.cos(v*5)+.14*Math.exp(-((u-.7)**2+(v-.4)**2)/.02),[lo,hi]=settings.height_range_m,t=Math.pow(Math.max(0,Math.min(1,(h-lo)/(hi-lo))),settings.palette_gamma);ctx.fillStyle=h>hi?'#000':`hsl(${230-t*210} 72% 48%)`;ctx.fillRect(x,y,8,8);}ctx.restore();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.9));return {blob,...meta};
  }
 }
 $('demo').onclick=()=>begin(new DemoClient());
 window.addEventListener('pagehide',disconnect);
 render();
})();
