/* Source download only. Credentials remain in memory and the downloaded config. */
(function(){
 "use strict";
 const names=["roi_robot.ino","hardware.h","hardware-config.h","indicators.h","README.md","robot-server.cjs"],paths=names.map(n=>n==='robot-server.cjs'?n:'firmware/'+n);
 const signals=[['0','— / — / —','Нет индикации'],['2','Синий / Синий / Синий','Начальная проверка'],['1','Зелёный / Зелёный / Зелёный','Готов к командам'],['3','Голубой / Голубой / Голубой','Выполняется движение'],['4','Красный / — / —','Нет связи с сервером'],['5','Красный / Красный / —','Низкое напряжение'],['6','Красный / Жёлтый / —','Истекло время движения'],['7','Красный / Красный / Красный','Сбой, остановка или не настроено'],['8','Красный / Фиолетовый / —','Некорректное измерение напряжения'],['9','Красный / Жёлтый / Жёлтый','Ошибка DRV8833 (нужен nFAULT)']];
 const encoder=new TextEncoder();let sourcesPromise;
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 function zip(files){
  const chunks=[],central=[];let offset=0,total=0;
  const table=Array.from({length:256},(_,i)=>{for(let b=0;b<8;b++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
  for(const [name,text] of Object.entries(files)){
   const data=encoder.encode(text),nameBytes=encoder.encode(name);let crc=0xffffffff;for(const b of data)crc=table[(crc^b)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
   const header=new Uint8Array(30+nameBytes.length),h=new DataView(header.buffer);h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);h.setUint32(14,crc,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,nameBytes.length,true);header.set(nameBytes,30);
   const c=new Uint8Array(46+nameBytes.length),v=new DataView(c.buffer);v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint16(8,0x800,true);v.setUint16(14,33,true);v.setUint32(16,crc,true);v.setUint32(20,data.length,true);v.setUint32(24,data.length,true);v.setUint16(28,nameBytes.length,true);v.setUint32(42,offset,true);c.set(nameBytes,46);central.push(c);total+=c.length;chunks.push(header,data);offset+=header.length+data.length;
  }
  const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,central.length,true);v.setUint16(10,central.length,true);v.setUint32(12,total,true);v.setUint32(16,offset,true);return new Blob([...chunks,...central,end],{type:'application/zip'});
 }
 // Escape UTF-8 C++ strings, including control characters and line separators.
 const literal=value=>'"'+Array.from(encoder.encode(String(value))).map(b=>b>=32&&b<127&&b!==34&&b!==92?String.fromCharCode(b):'\\'+b.toString(8).padStart(3,'0')).join('')+'"';
 function configuration(item,values){return `#pragma once\n// Private: do not commit or share this file.\n#define DEVICE_ID ${literal(item.id)}\n#define POLYGON_ID ${literal(item.polygon_id||'')}\n#define MARKER_ID ${Number.isInteger(item.marker_id)?item.marker_id:-1}\n#define SERVER_URL ${literal(values.server.replace(/\/+$/,''))}\n#define DEVICE_TOKEN ${literal(values.token)}\n#define WIFI_SSID ${literal(values.ssid)}\n#define WIFI_PASSWORD ${literal(values.password)}\n// Hardware wiring and calibration: hardware-config.h\n`;}
 async function open(item){
  const previous=document.querySelector('.firmware-dialog');if(previous?.open)return;previous?.remove();
  const dialog=el('dialog',undefined,'firmware-dialog'),form=el('form'),heading=el('div',undefined,'firmware-heading'),title=el('h2','Прошивка ESP32 · '+item.name),close=el('button','Закрыть');close.type='button';close.onclick=()=>dialog.close();heading.append(title,close);
  const summary=el('p','ID '+item.marker_id+' · UUID техники: '+item.id,'firmware-summary'),tabs=el('nav',undefined,'firmware-tabs'),body=el('div',undefined,'firmware-body'),footer=el('div',undefined,'firmware-footer'),message=el('p','Загрузка исходников…','firmware-message'),download=el('button','Скачать проект ESP32 (.zip)');download.type='button';download.disabled=true;message.setAttribute('role','status');footer.append(message,download);form.append(heading,summary,tabs,body,footer);dialog.append(form);document.body.append(dialog);
  const values={server:'http://192.168.1.100:8766',ssid:'',password:'',token:''};let files=null,page=0,selected='roi_robot.ino',tab='settings';
  const error=text=>{message.textContent=text;message.setAttribute('role','alert');};
  const valuesList=()=>({...files,'config.h':configuration(item,values)});
  function render(){
   body.replaceChildren();for(const b of tabs.children)b.setAttribute('aria-selected',String(b.dataset.tab===tab));
   if(tab==='settings'){
    body.append(el('p','ESP32 DevKit V1 · DRV8833: 25/26 и 27/12. Исходники, не готовый .bin. До настройки измерения напряжения и калибровки движение заблокировано. Настройки — в hardware-config.h.','firmware-warning'));
    const fields=el('div',undefined,'firmware-settings');
    for(const [key,label,type] of [['server','Адрес сервера команд','url'],['ssid','Wi-Fi: имя сети','text'],['password','Wi-Fi: пароль','password'],['token','Токен только этой техники','password']]){const l=el('label',label),input=el('input');input.type=type;input.value=values[key];input.autocomplete='off';input.name=key;input.oninput=()=>{values[key]=input.value;};l.append(input);fields.append(l);}
    const generate=el('button','Создать токен техники');generate.type='button';generate.onclick=()=>{values.token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');render();};
    body.append(fields,generate,el('p','Для ESP32 нужен отдельный сервер команд — GitHub Pages его не запускает. В архиве есть сервер и инструкция. Пароли остаются в памяти этого окна и в скачанном config.h.'),el('small','UUID адресует конкретную машину; ID маркера может повторяться на разных полигонах. Старые логи симуляции автоматически не воспроизводятся.'));
   }else if(tab==='signals'){
    body.append(el('p','Три адресных RGB: порядок GPIO 2 / 4 / 19. «—» — выключен. Тип WS2812 требует подтверждения; до этого RGB_LAYOUT = 0.'));
    const table=el('table'),head=el('tr');for(const t of ['Код','Цвета (2 / 4 / 19)','Значение'])head.append(el('th',t));table.append(head);
    for(const row of signals){const tr=el('tr');row.forEach((t,i)=>tr.append(el('td',t,i===0?'led-pattern':undefined)));table.append(tr);}body.append(table,el('small','Разряд определяется по АЦП и делителю. Одним напряжением нельзя надёжно определить заклинивание или обрыв мотора; без энкодеров расстояние и угол приблизительные.'));
   }else{
    if(!files){body.append(el('p','Исходники ещё загружаются.'));return;}
    const select=el('select');select.setAttribute('aria-label','Файл прошивки');for(const name of [...names,'config.h']){const option=el('option',name);option.value=name;select.append(option);}select.value=selected;select.onchange=()=>{selected=select.value;page=0;render();};
    const lines=valuesList()[selected].split('\n'),count=12,max=Math.max(0,Math.ceil(lines.length/count)-1);page=Math.min(max,page);
    const controls=el('div',undefined,'firmware-page');for(const [label,delta] of [['←',-1],['→',1]]){const b=el('button',label);b.type='button';b.disabled=delta<0?page===0:page===max;b.onclick=()=>{page+=delta;render();};controls.append(b);}controls.append(el('small',`${page+1} / ${max+1}`));
    const pre=el('pre',lines.slice(page*count,(page+1)*count).join('\n'));body.append(select,pre,controls);
   }
  }
  for(const [key,label] of [['settings','Подключение'],['source','Исходники'],['signals','Сигналы LED']]){const b=el('button',label);b.type='button';b.dataset.tab=key;b.onclick=()=>{tab=key;render();};tabs.append(b);}
  function dispose(){values.password='';values.token='';dialog.remove();}
  close.onclick=()=>{dialog.close();dispose();};dialog.addEventListener('cancel',e=>{e.preventDefault();dialog.close();dispose();});
  form.onsubmit=e=>e.preventDefault();dialog.addEventListener('close',dispose,{once:true});dialog.showModal();render();
  download.onclick=()=>{
   try{const url=new URL(values.server);if(url.protocol!=='http:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Укажите HTTP-адрес отдельного сервера, например http://192.168.1.100:8766.');if(!values.ssid.trim()||values.token.length<24)throw Error('Укажите имя Wi-Fi и случайный токен техники длиной не менее 24 символов.');
    const archive=zip({...Object.fromEntries(names.filter(n=>/\.(ino|h)$/.test(n)).map(n=>['roi_robot/'+n,files[n]])),'roi_robot/config.h':configuration(item,values),'README.md':files['README.md'],'server/robot-server.cjs':files['robot-server.cjs']});
    const href=URL.createObjectURL(archive),a=el('a');a.href=href;a.download='esp32-'+String(item.id).replace(/[^a-z0-9-]/gi,'')+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(href),10000);message.setAttribute('role','status');message.textContent='Архив скачан. Начните с README.md.';
   }catch(e){error(e.message);}
  };
  try{sourcesPromise??=Promise.all(paths.map(async path=>{const r=await fetch(path);if(!r.ok)throw Error('Не удалось загрузить исходники. Повторите открытие окна.');return r.text();})).catch(e=>{sourcesPromise=null;throw e;});const text=await sourcesPromise;files=Object.fromEntries(names.map((name,i)=>[name,text[i]]));download.disabled=false;message.textContent='Проект требует настройки оборудования.';render();}catch(e){error(e.message);}
 }
 window.RobotFirmware={open};
})();
