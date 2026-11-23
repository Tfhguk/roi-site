'use strict';
const $=id=>document.getElementById(id), selected=new Map();
const api=async(endpoint,body)=>{
  const r=await fetch('/api/'+endpoint,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const t=r.headers.get('content-type')||'';
  if(t.includes('application/zip')){if(!r.ok)throw Error('ZIP generation failed');return r.blob();}
  const data=await r.json();if(!r.ok)throw Error(data.error||'Ошибка '+r.status);return data;
};
const tell=(msg,error=false)=>{const e=$('alert');e.classList.remove('hidden');e.className='notice '+(error?'error':'success');e.textContent=msg;e.scrollIntoView({behavior:'smooth',block:'nearest'});};
const busy=async(fn)=>{try{await fn();}catch(e){tell(e.message,true);}};
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
function addRobot(r){
  if(!r.id)return;
  const marker=(r.marker_id===null||r.marker_id===undefined)?'':String(r.marker_id);
  const polygon=r.polygon_id||'';
  selected.set(r.id,{id:r.id,marker_id:marker,polygon_id:polygon,name:r.name||'Робот'});
  renderChoices();
}
function renderChoices(){
  const parent=$('robots');parent.replaceChildren();
  for(const row of selected.values()){
    const item=el('div','robot'),box=el('input');box.type='checkbox';box.checked=true;box.setAttribute('aria-label','Добавить '+row.name);
    box.onchange=()=>{if(!box.checked)selected.delete(row.id);renderChoices();};
    const middle=el('div'),strong=el('strong','',row.name),hint=el('div','muted',row.id);middle.append(strong,hint);
    const fields=el('div','row');
    const mid=el('div','half'),p1=el('label','', 'ArUco ID'),m=el('input');m.type='number';m.min='0';m.value=row.marker_id;
    m.oninput=()=>{row.marker_id=m.value;};mid.append(p1,m);
    const pid=el('div','half'),p2=el('label','', 'UUID полигона'),p=el('input');p.placeholder='Необязательно';p.value=row.polygon_id||'';
    p.oninput=()=>{row.polygon_id=p.value;};pid.append(p2,p);fields.append(mid,pid);middle.append(fields);
    item.append(box,middle);parent.append(item);
  }
}
function renderConfigured(robots){
  const parent=$('configured');parent.replaceChildren();
  if(!robots.length){parent.append(el('p','muted','Пока нет настроенных роботов.'));return;}
  robots.forEach(r=>{
    const section=el('div','robot'),a=el('div'),right=el('div','tools'),title=el('strong','', 'ArUco '+r.marker_id+' · '+r.id.slice(0,8));
    a.append(title,el('div','muted',r.id));
    const token=el('span','token hidden');const actions=el('div','row');
    let value='';
    const show=el('button','compact','Показать токен');show.type='button';
    const copy=el('button','compact','Копировать');copy.type='button';
    show.onclick=()=>busy(async()=>{
      if(!value)value=(await api('token?id='+encodeURIComponent(r.id))).token;
      token.textContent=value;token.classList.toggle('hidden');show.textContent=token.classList.contains('hidden')?'Показать токен':'Скрыть токен';
    });
    copy.onclick=()=>busy(async()=>{
      if(!value)value=(await api('token?id='+encodeURIComponent(r.id))).token;
      try{await navigator.clipboard.writeText(value);}catch{
        const f=document.createElement('textarea');f.value=value;document.body.append(f);f.select();
        if(!document.execCommand('copy'))throw Error('Буфер обмена заблокирован. Нажмите «Показать».');f.remove();
      }
      tell('Токен '+r.id.slice(0,8)+' скопирован. Никому не передавай его.');
    });
    const download=el('button','primary compact','Скачать прошивку');download.type='button';
    download.onclick=()=>busy(async()=>{
      const ssid=$('wifi-ssid').value,password=$('wifi-pass').value,host=$('host').value,port=$('port').value;
      const b=await api('firmware',{id:r.id,ssid,password,host,port});
      const href=URL.createObjectURL(b),link=document.createElement('a');link.href=href;link.download='roi_robot-'+r.id.slice(0,8)+'.zip';
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),1000);
      tell('ZIP сформирован с уникальным токеном робота. Храни файл локально.');
    });
    actions.append(show,copy,download);right.append(actions,token);section.append(el('div'),a,right);parent.append(section);
  });
}
const credentials=()=>({url:$('sb-url').value.trim(),key:$('sb-key').value.trim(),email:$('email').value.trim()});
$('login').onclick=()=>busy(async()=>{const a=await api('login',{...credentials(),password:$('password').value});
  $('password').value='';$('login-state').textContent='Вход выполнен: '+a.user;tell('Supabase подключен. Теперь загрузите технику.');await load();});
$('send-otp').onclick=()=>busy(async()=>{await api('otp/send',credentials());tell('Запрос отправлен. Если письмо содержит числовой код, вставьте его ниже.');});
$('verify-otp').onclick=()=>busy(async()=>{const a=await api('otp/verify',{...credentials(),otp:$('otp').value.trim()});
  $('otp').value='';$('login-state').textContent='Вход выполнен: '+a.user;tell('Supabase подключен через OTP.');await load();});
async function load(){const response=await api('robots');selected.clear();response.robots.forEach(addRobot);tell('Найдено записей техники: '+response.robots.length+'. Проверь ArUco ID перед сохранением.');}
$('load').onclick=()=>busy(load);
$('add-manual').onclick=()=>{addRobot({id:$('manual-id').value.trim(),marker_id:$('manual-marker').value,polygon_id:$('manual-polygon').value.trim(),name:'Локальный робот'});};
$('save').onclick=()=>busy(async()=>{
  const robots=[...selected.values()].map(x=>({id:x.id,marker_id:x.marker_id,polygon_id:x.polygon_id}));
  const answer=await api('save',{robots});renderConfigured(answer.robots);
  tell('Готово: конфигурация и токены созданы. Теперь можно скачать персональную прошивку.');
});
$('local-robots').onclick=()=>busy(async()=>{const s=await api('state');renderConfigured(s.robots);tell('Показаны роботы, уже подключенные к этому компьютеру.');});
(async()=>{
  try{
    const s=await api('state');
    $('sb-url').value=s.cloud.url||s.detected.url;
    $('sb-key').value=s.cloud.publishableKey||s.detected.publishableKey;
    if(s.ips.length){$('host').replaceChildren();s.ips.forEach(ip=>{const opt=el('option','',ip);opt.value=ip;$('host').append(opt);});}
    renderConfigured(s.robots);
    if(s.connected)$('login-state').textContent='Подключен: '+s.loggedEmail;
    if(s.robots.length)tell('Найдено настроенных роботов: '+s.robots.length+'. Их токены сохранены.');
  }catch(e){tell(e.message,true);}
})();
