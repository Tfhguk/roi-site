/* UI for the synthetic station model. No commands are sent to equipment. */
(()=>{
  "use strict";
  const $=id=>document.getElementById(id), M=ChargingModel;
  let sim=new M.Simulation(),paused=false,last=0,notified="";
  const explanations={idle:"Нажмите «Запустить»: станция найдёт ноль, состыкуется с машиной и зарядит батарею.",homing:"Каретки возвращаются к опорным положениям. Подтверждение нуля имитируется.",detect:"Имитируется обнаружение неподвижной машины и получение положения её контакта.",align:"Станция совмещает высоту и поворот контакта. Перед машиной остаётся зазор 18 мм.",dock:"Механизм подходит к машине и замыкает захват. Зарядка начнётся после подтверждения контакта.",charge:"Идёт зарядка условной батареи. CC — постоянный ток, CV — постоянное напряжение на выходе зарядника.",disconnect:"Ток отключён. Ожидание модельного подтверждения перед расстыковкой.",undock:"Механизм отводит контакт и раскрывает захват. Ток равен нулю.",return:"Каретки возвращаются в исходное положение.",complete:"Цикл завершён. Можно скачать расчёт или изменить параметры для следующего опыта.",stopped:"Цикл остановлен пользователем, механизм возвращён. Для нового опыта нажмите «Сброс».",error:"Расчёт остановлен. Причина показана в уведомлении. Измените параметры или нажмите «Сброс»."};
  const phases=["homing","detect","align","dock","charge","disconnect","undock","return"];
  phases.forEach(stage=>{const span=document.createElement("span");span.title=M.labels[stage];$("timeline").append(span);});
  const number=(n,d=2)=>n.toLocaleString("ru-RU",{minimumFractionDigits:d,maximumFractionDigits:d});
  const time=t=>`${Math.floor(t/60).toString().padStart(2,"0")}:${Math.floor(t%60).toString().padStart(2,"0")}`;
  function speed(){return $("speed").value==="real"?1:$("speed").value==="fast"?(sim.stage==="charge"?600:3):(sim.stage==="charge"?120:1);}
  function toast(message){$("toast").querySelector("span").textContent=message;$("toast").hidden=false;}
  $("toast").querySelector("button").onclick=()=>{$("toast").hidden=true;};
  function render(){
    $("stage").textContent=M.labels[sim.stage]+(paused&&sim.active?" · пауза":"");
    $("clock").textContent=time(sim.time)+" · ×"+(paused?0:speed());
    $("soc").textContent=number(sim.soc*100,1)+" %";$("goal").textContent=number(sim.config.targetSoc*100,0)+" %";
    for(const [id,value,unit] of [["current",sim.current," А"],["voltage",sim.voltage," В"],["outputVoltage",sim.outputVoltage," В"],["force",sim.force," Н"]])$(id).textContent=number(value)+unit;
    $("mode").textContent=sim.mode;$("contact").textContent=sim.contact?"Есть":"Нет";$("batteryFill").style.width=sim.soc*100+"%";
    $("positions").textContent=`X ${number(sim.q[0],3)} м · Z ${number(sim.q[1],3)} м · ψ ${number(sim.q[2])} рад`;
    $("instruction").textContent=sim.stage==="error"?sim.error:explanations[sim.stage];
    $("summary").textContent=sim.reason||`В батарею ${number(sim.energyWh,3)} Вт·ч · потери в цепи ${number(sim.lossWh,3)} Вт·ч`;
    $("start").disabled=sim.stage!=="idle";$("pause").disabled=!sim.active;$("pause").textContent=paused?"Продолжить":"Пауза";$("stop").disabled=!sim.active;
    const index=phases.indexOf(sim.stage);
    [...$("timeline").children].forEach((item,i)=>{item.className=sim.stage==="complete"||sim.stage==="stopped"||i<index?"done":i===index?"active":"";});
    if(sim.error&&notified!==sim.error){notified=sim.error;toast(sim.error);}
    drawScene();drawChart();
  }
  function context(id){
    const canvas=$(id),bounds=canvas.getBoundingClientRect(),ratio=Math.min(window.devicePixelRatio||1,2);
    const width=Math.max(1,Math.round(bounds.width*ratio)),height=Math.max(1,Math.round(bounds.height*ratio));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    const ctx=canvas.getContext("2d");ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,bounds.width,bounds.height);
    return {ctx,w:bounds.width,h:bounds.height};
  }
  function drawScene(){
    const {ctx,w,h}=context("mechanism");if(w<2||h<2)return;
    const scale=Math.min(w/720,h/420),ox=(w-720*scale)/2,oy=(h-420*scale)/2;
    ctx.translate(ox,oy);ctx.scale(scale,scale);
    const px=x=>120+x*1800,pz=z=>340-z*1500;
    const line=(x1,y1,x2,y2,color,width=2)=>{ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();};
    const box=(x,y,a,b,color)=>{ctx.fillStyle=color;ctx.fillRect(x,y,a,b);};
    const text=(value,x,y,color="#cbd5e1",size=13)=>{ctx.fillStyle=color;ctx.font=`${size}px Segoe UI, sans-serif`;ctx.fillText(value,x,y);};
    for(let x=40;x<720;x+=40)line(x,30,x,355,"#203248",1);
    for(let y=35;y<=355;y+=40)line(40,y,680,y,"#203248",1);
    text("Вид сбоку · условная схема",40,25,"#94a3b8");
    line(50,355,680,355,"#64748b",2);
    box(78,347,400,8,"#475569");box(80,365,55,12,"#334155");box(425,365,55,12,"#334155");
    // Travel envelope, horizontal carriage and vertical rack.
    ctx.setLineDash([5,5]);ctx.strokeStyle="#365c75";ctx.lineWidth=1;ctx.strokeRect(px(0),pz(.16),.24*1800,.14*1500);ctx.setLineDash([]);
    const x=px(sim.q[0]),z=pz(sim.q[1]),target=sim.target(),tx=px(target[0]),tz=pz(target[1]);
    box(x-10,70,20,277,"#526b86");box(x-5,78,10,260,"#8ba2ba");
    for(let y=82;y<335;y+=9)line(x-4,y,x+4,y,"#334155",2);
    box(x-24,z-18,48,36,"#0284c7");box(x-17,z-12,34,24,"#38bdf8");
    box(x+18,z-6,35,12,"#a5b4fc");
    // Machine and its fixed contact move only when target parameters change.
    box(tx+66,tz-33,95,101,"#403265");box(tx+76,tz-44,66,30,"#6d55a0");
    for(const xx of [tx+87,tx+143]){ctx.beginPath();ctx.arc(xx,tz+71,16,0,Math.PI*2);ctx.fillStyle="#0b1221";ctx.fill();ctx.strokeStyle="#64748b";ctx.stroke();}
    line(tx+12,tz,tx+66,tz,"#a78bfa",9);
    const gap=sim.q[3]*23;
    line(x+28,z-4,x+49,z-gap,"#dbeafe",5);line(x+28,z+4,x+49,z+gap,"#dbeafe",5);
    line(x+49,z-gap,x+61,z-gap,"#dbeafe",5);line(x+49,z+gap,x+61,z+gap,"#dbeafe",5);
    ctx.beginPath();ctx.arc(tx+53,tz,7,0,Math.PI*2);ctx.fillStyle=sim.contact?"#4ade80":"#fbbf24";ctx.fill();
    if(sim.current>0){line(x+53,z,tx+53,tz,"#4ade80",4);text("⚡ "+number(sim.current)+" А",tx+70,tz-59,"#4ade80",16);}
    ctx.setLineDash([4,4]);line(tx+53,tz-22,tx+53,tz+22,"#fbbf24",1);ctx.setLineDash([]);
    text("Машина",tx+72,tz+106,"#c4b5fd");text("X →",490,382,"#94a3b8");text("Z ↑",42,75,"#94a3b8");
    text("Каретка",Math.max(40,x-28),55,"#7dd3fc");
    text("Ноль: "+(sim.homed?"подтверждён":"не установлен"),40,405,sim.homed?"#4ade80":"#94a3b8");
    // Rotation is shown separately because the main view is a side projection.
    const cx=620,cy=75;ctx.beginPath();ctx.arc(cx,cy,27,0,Math.PI*2);ctx.strokeStyle="#526079";ctx.lineWidth=2;ctx.stroke();
    line(cx,cy,cx+Math.cos(sim.q[2])*24,cy-Math.sin(sim.q[2])*24,"#38bdf8",3);
    line(cx,cy,cx+Math.cos(target[2])*30,cy-Math.sin(target[2])*30,"#fbbf24",1);
    text("Поворот ψ",580,121,"#94a3b8");
  }
  function drawChart(){
    const {ctx,w,h}=context("chart");if(w<2||h<2)return;
    for(let i=1;i<=3;i++){ctx.beginPath();ctx.moveTo(0,h*i/4);ctx.lineTo(w,h*i/4);ctx.strokeStyle="#334155";ctx.stroke();}
    const samples=[...sim.samples,{time:sim.time,soc:sim.soc,current:sim.current}],end=Math.max(sim.time,1);
    for(const [key,max,color] of [["soc",1,"#38bdf8"],["current",2,"#fbbf24"]]){
      ctx.beginPath();samples.forEach((s,i)=>{const x=s.time/end*w,y=h-4-s[key]/max*(h-8);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();
    }
  }
  function reset(input=sim.config){sim=new M.Simulation(input);paused=false;notified="";$("toast").hidden=true;last=0;render();}
  $("start").onclick=()=>{sim.start();paused=false;render();};
  $("pause").onclick=()=>{paused=!paused;last=0;render();};
  $("stop").onclick=()=>{sim.stop();paused=false;render();};
  $("reset").onclick=()=>reset();
  $("speed").onchange=render;
  $("settings").onclick=()=>{
    if(sim.active)paused=true;
    for(const [key,value] of Object.entries(sim.config))$("settingsForm").elements.namedItem(key).value=key.endsWith("Soc")?Math.round(value*100):value;
    $("settingsDialog").showModal();render();
  };
  $("cancelSettings").onclick=()=>$("settingsDialog").close();
  $("settingsForm").onsubmit=event=>{
    event.preventDefault();const input=Object.fromEntries(new FormData(event.target));
    for(const key of Object.keys(input))if(key!=="scenario")input[key]=Number(input[key])/(key.endsWith("Soc")?100:1);
    const goal=event.target.elements.namedItem("targetSoc");goal.setCustomValidity("");
    if(input.targetSoc<=input.initialSoc){goal.setCustomValidity("Целевой заряд должен быть больше начального.");goal.reportValidity();return;}
    try{reset(input);$("settingsDialog").close();}catch(error){$("settingsDialog").close();toast(error.message);}
  };
  $("settingsForm").addEventListener("input",()=>$("settingsForm").elements.namedItem("targetSoc").setCustomValidity(""));
  $("help").onclick=()=>{if(sim.active)paused=true;$("helpDialog").showModal();render();};
  $("closeHelp").onclick=()=>$("helpDialog").close();
  $("helpToggle").onclick=()=>{const details=$("helpModel").hidden;$("helpModel").hidden=!details;$("helpSteps").hidden=details;$("helpToggle").textContent=details?"Как пользоваться":"О модели";};
  $("download").onclick=()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(sim.export(),null,2)],{type:"application/json"}));
    const link=document.createElement("a");link.href=url;link.download="charging-test.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  document.addEventListener("visibilitychange",()=>{if(document.hidden&&sim.active){paused=true;last=0;render();}});
  window.addEventListener("resize",render);
  function frame(now){
    const elapsed=last?Math.min(.1,(now-last)/1000):0;last=now;
    if(sim.active&&!paused&&!document.hidden){
      // Keep slow movement visible when an accelerated charging step ends.
      let budget=elapsed*speed();const charging=sim.stage==="charge";
      while(budget>1e-8&&sim.active){const step=Math.min(.02,budget);sim.advance(step);budget-=step;if(charging&&sim.stage!=="charge")break;}
      render();
    }
    requestAnimationFrame(frame);
  }
  render();requestAnimationFrame(frame);
})();
