/* Cloud robot jobs are stored in Supabase. Browser never connects to ESP32 or LAN directly. */
(function(){
  'use strict';
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  function field(parent,label,type='text',value=''){
    const wrapper=el('label',label),input=el('input');
    input.type=type;input.value=value;input.setAttribute('aria-label',label);
    input.style.cssText='display:block;width:100%;box-sizing:border-box;margin:5px 0 10px;padding:8px;background:#0f172a;color:#f1f5f9;border:1px solid #64748b;border-radius:6px';
    wrapper.append(input);parent.append(wrapper);return input;
  }
  async function open(robot){
    if(!window.AppCloud?.configured)throw Error('Нужно подключить Supabase.');
    document.querySelector('.robot-cloud-dialog')?.remove();
    const dialog=el('dialog');dialog.className='robot-cloud-dialog';
    dialog.style.cssText='max-width:560px;width:calc(100% - 24px);max-height:90vh;overflow:auto;border:1px solid #64748b;border-radius:14px;padding:22px;background:#1e293b;color:#e2e8f0;font-family:inherit';
    const heading=el('h2','Диспетчер · '+robot.name),id=el('p','ArUco '+robot.marker_id+' · '+robot.id),status=el('p','Проверяем связь...');
    id.style.cssText='overflow-wrap:anywhere;color:#94a3b8;font-size:12px';
    status.setAttribute('role','status');
    const buttons=el('div'),controls=el('div');buttons.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin:10px 0';
    const makeButton=(text,action)=>{const b=el('button',text);b.type='button';b.style.cssText='padding:8px 12px;border-radius:7px;border:1px solid #64748b;background:#334155;color:#e2e8f0;cursor:pointer';b.onclick=action;return b;};
    const x=field(controls,'X цели (м)','number','1.0'),y=field(controls,'Y цели (м)','number','1.0'),headingInput=field(controls,'Курс цели (градусы, необязательно)','number','');
    for(const inp of [x,y,headingInput])inp.step='any';
    const history=el('div');history.style.cssText='font-size:12px;color:#cbd5e1;max-height:150px;overflow-y:auto';
    let currentMode='OFFLINE',busy=false,closed=false;
    const setStatus=(value,error=false)=>{status.textContent=value;status.style.color=error?'#fda4af':'#86efac';};
    async function submit(payload){
      if(busy)return;busy=true;
      try{
        await AppCloud.request('/rest/v1/robot_jobs',{method:'POST',body:{robot_id:robot.id,payload}});
        setStatus('Задание записано в облачную очередь. Ожидаем локальный сервер.');
        await refresh();
      }catch(e){setStatus('Ошибка отправки: '+e.message,true);}finally{busy=false;}
    }
    buttons.append(
      makeButton('Отправить к точке',()=>{
        if(!Number.isFinite(Number(x.value))||!Number.isFinite(Number(y.value))||x.value===''||y.value===''){setStatus('Укажите числовые координаты цели.',true);return;}
        const target={x:Number(x.value),y:Number(y.value)};
        if(headingInput.value.trim()!==''){const deg=Number(headingInput.value);if(!Number.isFinite(deg)){setStatus('Некорректный курс.',true);return;}target.heading=deg*Math.PI/180;}
        submit({action:'MOVE_TO',target});
      }),
      makeButton('АВАРИЙНЫЙ СТОП',()=>submit({action:'STOP'})),
      makeButton('Сброс аварии',()=>{if(confirm('Техника осмотрена, полигон свободен, робот неподвижен?'))submit({action:'RESET',confirm:true});}),
      makeButton('Ручное управление',()=>{if(confirm('Подтвердите осмотр робота и переход в ручное управление с ограничением шага.'))submit({action:'MANUAL_ENABLE',confirm:true});})
    );
    const manual=el('div');manual.style.cssText='display:flex;flex-wrap:wrap;gap:7px;margin:10px 0';
    for(const [label,kind,value,unit] of [['Вперед 2 см','forward',.02,'m'],['Назад 2 см','backward',.02,'m'],['Влево 5°','left',5,'deg'],['Вправо 5°','right',5,'deg']]){
      manual.append(makeButton(label,()=>submit({action:currentMode==='MANUAL'?'MANUAL_DRIVE':'DRIVE',command:{kind,value,unit}})));
    }
    const note=el('p','Все команды проверяет локальный сервер. Координаты в метрах после калибровки ArUco. Для выгрузки нужен отдельный исполнительный механизм.');
    note.style.cssText='font-size:12px;color:#cbd5e1';
    const close=makeButton('Закрыть',()=>dialog.close());
    dialog.append(heading,id,status,controls,buttons,manual,note,history,close);
    document.body.append(dialog);
    dialog.addEventListener('close',()=>{closed=true;dialog.remove();},{once:true});
    dialog.showModal();
    async function refresh(){
      if(closed)return;
      try{
        const [states,jobs]=await Promise.all([
          AppCloud.request('/rest/v1/robot_states?robot_id=eq.'+encodeURIComponent(robot.id)+'&select=*'),
          AppCloud.request('/rest/v1/robot_jobs?robot_id=eq.'+encodeURIComponent(robot.id)+'&select=*&order=created_at.desc&limit=7')
        ]);
        const s=states?.[0];currentMode=s?.mode||'OFFLINE';
        const online=s?.last_seen&&Date.now()-Date.parse(s.last_seen)<4000;
        setStatus((online?'На связи':'Нет свежей телеметрии')+' · '+currentMode+
          (s?.battery_v===null||s?.battery_v===undefined?'':' · АКБ '+Number(s.battery_v).toFixed(2)+' В')+
          (s?.fault?' · '+(s.fault.code||'ERROR'):''),!online||!!s?.fault);
        history.replaceChildren();
        for(const job of jobs||[]){const line=el('p',(job.created_at||'').slice(11,19)+' · '+(job.payload?.action||'?')+' · '+job.status+(job.details?.error?' · '+job.details.error:''));history.append(line);}
      }catch(e){setStatus(e.message,true);}
    }
    await refresh();
    (async()=>{while(!closed){await new Promise(r=>setTimeout(r,2500));if(!closed)await refresh();}})();
  }
  window.RobotCloud={open};
})();
