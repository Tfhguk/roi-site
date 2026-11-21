/* Proposed AR GUI contract v1. Projector coordinates are never workspace coordinates. */
(function(root){
 'use strict';
 const stages=['mount_pending','stereo_required','floor_required','projector_required','ready'];
 class ApiError extends Error{constructor(message,field='',status=0){super(message);this.field=field;this.status=status;}}
 const fail=(message,field)=>{throw new ApiError(message,field);};
 const finite=x=>typeof x==='number'&&Number.isFinite(x);
 const revision=x=>(typeof x==='string'&&x.length>0&&x.length<=200)||(Number.isSafeInteger(x)&&x>=0);
 function baseURL(value){
  let url;try{url=new URL(value);}catch{fail('Укажите полный адрес AR-сервера, например http://127.0.0.1:8765','apiAddress');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('Нужен HTTP(S)-адрес без пароля, параметров и #.','apiAddress');
  return url.href.replace(/\/$/,'');
 }
 function projection(value){
  const p=value;if(!p||![p.width,p.height].every(x=>Number.isInteger(x)&&x>=2&&x<=16384))fail('AR не передал корректный размер изображения.','projection');
  const a=p.available_rect;if(!Array.isArray(a)||a.length!==4||!a.every(finite)||a[0]<0||a[1]<0||a[2]>p.width||a[3]>p.height||a[0]>=a[2]||a[1]>=a[3])fail('AR не передал доступное поле проектора.','projection.available_rect');
  return structuredClone(p);
 }
 function roi(vertices,p){
  projection(p);
  if(!Array.isArray(vertices)||vertices.length<3||vertices.length>32)fail('Граница должна содержать от 3 до 32 вершин.','roi');
  const a=p.available_rect;
  if(!vertices.every(v=>Array.isArray(v)&&v.length===2&&v.every(finite)&&v[0]>=0&&v[0]<=1&&v[1]>=0&&v[1]<=1&&v[0]*p.width>=a[0]-1e-7&&v[0]*p.width<=a[2]+1e-7&&v[1]*p.height>=a[1]-1e-7&&v[1]*p.height<=a[3]+1e-7))fail('Все вершины должны находиться внутри доступного поля проектора.','roi');
  if(!root.PolygonGeometry.isSimple(vertices.map(v=>({x:v[0]*10000,y:v[1]*10000}))))fail('Граница пересекает себя, содержит повторные точки или имеет нулевую площадь.','roi');
  return structuredClone(vertices);
 }
 function settings(value,p){
  const s=value;if(!s||s.schema_version!==1)fail('Неподдерживаемая версия настроек AR.','schema_version');
  const h=s.height_range_m;if(!Array.isArray(h)||h.length!==2||!h.every(finite)||h[0]<0||h[1]>.5||h[0]>=h[1])fail('Диапазон высот: от 0 до 0,50 м; верхняя граница должна быть больше нижней.','height_range_m');
  if(s.above_range!=='black')fail('Объекты выше диапазона должны оставаться чёрными.','above_range');
  if(!finite(s.palette_gamma)||s.palette_gamma<.1||s.palette_gamma>3)fail('Гамма палитры: от 0,1 до 3.','palette_gamma');
  if(!finite(s.update_interval_s)||s.update_interval_s<.5||s.update_interval_s>10)fail('Интервал обновления: от 0,5 до 10 с.','update_interval_s');
  if(s.roi?.coordinate_space!=='projector_normalized')fail('Нужны координаты полного поля проектора.','roi');
  return {...structuredClone(s),roi:{coordinate_space:'projector_normalized',vertices:roi(s.roi.vertices,p)}};
 }
 function state(value){
  const s=structuredClone(value);
  if(!s||s.schema_version!==1||!stages.includes(s.stage))fail('AR прислал неизвестный формат состояния.','state');
  if(s.projection){s.projection=projection(s.projection);if(!revision(s.projection_revision))fail('AR не передал ревизию проектора.','projection_revision');}
  if(s.stage==='ready'&&(!s.projection||s.projection.calibration_3d_accepted!==true))fail('AR объявил готовность без принятой 3D-калибровки проектора.','projection.calibration_3d_accepted');
  if(s.stage==='ready'&&!s.settings)fail('AR не передал текущие настройки проекции.','settings');
  if(s.settings){if(!s.projection)fail('Настройки AR получены без параметров проектора.','projection');s.settings=settings(s.settings,s.projection);if(!revision(s.settings_revision))fail('Не передана ревизия настроек.','settings_revision');}
  if(s.snapshot){const f=s.snapshot;if(!Number.isSafeInteger(f.id)||f.id<0||!finite(f.age_s)||f.age_s<0||!revision(f.projection_revision)||!revision(f.settings_revision))fail('Некорректные метаданные снимка AR.','snapshot');}
  return s;
 }
 function binding(s){return JSON.stringify([s.projection_revision,s.projection?.width,s.projection?.height,s.projection?.available_rect]);}
 function applied(reply,request){if(!reply||reply.request_id!==request.request_id||!revision(reply.settings_revision)||!Number.isSafeInteger(reply.snapshot_id)||reply.snapshot_id<0)fail('AR не подтвердил применение настроек. Проверьте состояние перед повторной отправкой.','response');return reply;}
 class Client{
  constructor(address,fetcher=root.fetch.bind(root),timeout=5000){this.address=baseURL(address);this.fetcher=fetcher;this.timeout=timeout;}
  async request(path,{body,signal,image=false}={}){
   const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
   const timer=setTimeout(abort,this.timeout);
   try{
    const response=await this.fetcher(this.address+'/api/v1/'+path,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,headers:body?{'Content-Type':'application/json'}:undefined,signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store',mode:'cors'});
    if(!response.ok){let error;try{error=await response.json();}catch{}throw new ApiError(error?.error?.message||'Ошибка AR-сервера: HTTP '+response.status,error?.error?.field||'',response.status);}
    if(image){
     if(!(response.headers.get('Content-Type')||'').toLowerCase().startsWith('image/jpeg'))fail('Вместо предпросмотра AR вернул не JPEG.','preview');
     const blob=await response.blob();if(blob.size>10*1024*1024)fail('Предпросмотр AR слишком большой.','preview');
     const frame={blob,snapshotId:response.headers.get('X-Snapshot-Id'),projectionRevision:response.headers.get('X-Projection-Revision'),settingsRevision:response.headers.get('X-Settings-Revision')};
     if(frame.snapshotId===null||frame.projectionRevision===null||frame.settingsRevision===null)fail('AR не передал метаданные JPEG. Проверьте заголовки X-Snapshot-Id, X-Projection-Revision, X-Settings-Revision и их доступность через CORS.','preview');
     return frame;
    }
    try{return await response.json();}catch{fail('AR вернул некорректный JSON.','response');}
   }catch(error){if(error instanceof ApiError)throw error;if(signal?.aborted)throw new DOMException('Aborted','AbortError');throw new ApiError(controller.signal.aborted?'AR не ответил за 5 секунд.':'Нет соединения с AR. Проверьте адрес, запуск сервера и разрешение доступа из браузера.');}
   finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async state(signal){return state(await this.request('state',{signal}));}
  preview(signal){return this.request('preview.jpg',{signal,image:true});}
  async apply(value,p,signal){const request=settings(value,p);if(typeof request.request_id!=='string'||!request.request_id||!revision(request.projection_revision)||!revision(request.expected_settings_revision))fail('Не задан запрос или ревизия настроек AR.','request_id');return applied(await this.request('settings',{body:request,signal}),request);}
  async action(name,request,signal){if(!['rescan','calibrate-floor'].includes(name))fail('Неизвестное действие AR.','action');const reply=await this.request('actions/'+name,{body:request,signal});if(reply?.request_id!==request.request_id||reply.accepted!==true)fail('AR не подтвердил запуск операции.','response');return reply;}
 }
 const api={ApiError,baseURL,projection,roi,settings,state,binding,applied,Client};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ARApi=Object.freeze(api);
})(globalThis);
