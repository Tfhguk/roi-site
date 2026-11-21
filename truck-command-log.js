/* Movement orders use metres/radians in the physical world, not map pixels. */
(function(root){
 'use strict';
 const angle=x=>Math.atan2(Math.sin(x),Math.cos(x));
 const number=(x,digits)=>x.toFixed(digits).replace('.',',');
 function create(){
  const entries=[];let revision=0,serial=0,key=null,manual=null,previous=null;
  function add(time,kind,message,details={}){
   const row={id:++serial,time,kind,message,...details};entries.push(row);
   if(entries.length>200)entries.shift();revision++;return row;
  }
  function refresh(row,value){
   row.value=value;
   const message=row.unit==='m'?(row.kind==='forward'?'Вперёд':'Назад')+' (ручное): пройдено '+number(value,2)+' м':
    'Поворот '+(row.kind==='left'?'влево':'вправо')+' (ручное): выполнено '+number(value,1)+'°';
   if(row.message!==message){row.message=message;revision++;}
  }
  function update(r,p,recovery,input={drive:0,turn:0}){
   // Complete the previous manual interval before changing input or mode.
   if(manual&&previous){
    if(manual.drive)refresh(manual.drive,manual.drive.value+Math.hypot(p.x-previous.x,p.y-previous.y));
    if(manual.turn)refresh(manual.turn,manual.turn.value+Math.abs(angle(p.yaw-previous.yaw))*180/Math.PI);
   }
   const mode=recovery.mode,target=mode==='back'?recovery.target:r.target();
   const next=mode==='manual'?JSON.stringify([mode,input.drive,input.turn]):JSON.stringify([mode,r.stage,r.pathRole,r.index,r.direction,target?.x,target?.y]);
   previous={...p};if(next===key)return;key=next;manual=null;
   if(mode==='manual'){
    manual={};
    if(input.drive){manual.drive=add(r.time,input.drive>0?'forward':'backward','',{manual:true,unit:'m',value:0});refresh(manual.drive,0);}
    if(input.turn){manual.turn=add(r.time,input.turn>0?'left':'right','',{manual:true,unit:'deg',value:0});refresh(manual.turn,0);}
    if(!input.drive&&!input.turn)add(r.time,'stop','Стоп · ручное управление');
    return;
   }
   if(mode==='request'){add(r.time,'stop','Стоп · требуется ручное управление');return;}
   if(mode==='back'){
    const value=Math.hypot(target.x-p.x,target.y-p.y);add(r.time,'backward','Назад на '+number(value,2)+' м · попытка выезда',{unit:'m',value});return;
   }
   if(mode!=='auto')return;
   if(r.stage==='turning'||r.stage==='dock-align'){
    const heading=r.stage==='dock-align'?(r.chargingSite?.dockHeading??p.yaw):Math.atan2(target.y-p.y,target.x-p.x);
    const delta=angle(heading-p.yaw),value=Math.abs(delta)*180/Math.PI;
    if(value>=1)add(r.time,delta>0?'left':'right','Поворот '+(delta>0?'влево':'вправо')+' на '+number(value,1)+'°',{unit:'deg',value});
   }else if(r.stage==='driving'){
    const value=Math.hypot(target.x-p.x,target.y-p.y);
    if(value>=.005)add(r.time,'forward','Вперёд на '+number(value,2)+' м',{unit:'m',value});
   }else{
    const labels={loading:'Погрузка · 4 с',raising:'Разгрузка · 4 с',station:'Зарядка',stopping:'Остановиться','charge-stop':'Остановиться перед поездкой на зарядку',error:'Стоп · '+r.error,complete:'Маршрут завершён'};
    if(labels[r.stage])add(r.time,r.stage,labels[r.stage]);
   }
  }
  return {update,get revision(){return revision;},export:()=>entries.map(row=>({...row}))};
 }
 const api={create};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.TruckCommandLog=api;
})(typeof globalThis!=='undefined'?globalThis:this);
