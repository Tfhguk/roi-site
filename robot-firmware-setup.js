/* The browser is not allowed to mint local device tokens or firmware ZIPs.
   The local wizard is the only authority, avoiding duplicated/mismatched device keys. */
(function(){
'use strict';
function open(robot){
  document.querySelector('.robot-pairing-dialog')?.remove();
  const dialog=document.createElement('dialog');dialog.className='robot-pairing-dialog';
  dialog.style.cssText='background:#1d2731;color:#e7eff5;border:1px solid #516171;border-radius:14px;max-width:480px;padding:24px;line-height:1.5';
  const title=document.createElement('h2');title.textContent='Прошивка ESP32 · '+(robot.name||'Робот');
  const info=document.createElement('p');info.textContent='Сначала запусти SETUP-ROBOTS-WINDOWS.cmd на локальном компьютере. Мастер сам создаст токен робота и вставит его в готовый ZIP.';
  const id=document.createElement('p');id.style.cssText='color:#a7bdc9;font-size:12px;overflow-wrap:anywhere';id.textContent='UUID: '+robot.id+' · ArUco: '+(robot.marker_id??'?');
  const link=document.createElement('a');link.href='http://127.0.0.1:8767/';link.target='_blank';link.rel='noopener noreferrer';
  link.textContent='Открыть мастер на этом компьютере';link.style.cssText='display:inline-block;padding:10px 12px;border-radius:8px;background:#e0b55d;color:#1d2731;font-weight:bold;margin-bottom:12px';
  const note=document.createElement('p');note.textContent='Если мастер не открылся, запусти SETUP-ROBOTS-WINDOWS.cmd и воспользуйся ссылкой, которая откроется автоматически. Для безопасности мастер работает только на самом компьютере.';
  note.style.cssText='font-size:12px;color:#b9c9d1';
  const copy=document.createElement('button');copy.textContent='Копировать UUID';copy.type='button';
  copy.style.cssText='padding:8px 11px;border-radius:6px;color:#f1f4f6;background:#304251;border:1px solid #738496;margin-right:8px';
  copy.onclick=async()=>{try{await navigator.clipboard.writeText(robot.id);copy.textContent='UUID скопирован';}catch{copy.textContent='Выдели UUID выше';}};
  const close=document.createElement('button');close.type='button';close.textContent='Закрыть';
  close.style.cssText='padding:8px 11px;border-radius:6px;color:#f1f4f6;background:#304251;border:1px solid #738496';
  close.onclick=()=>dialog.close();dialog.append(title,info,id,link,note,copy,close);document.body.append(dialog);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
}
window.RobotFirmwareHelper={open};
})();
