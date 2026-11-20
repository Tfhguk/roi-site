(function(root){
  "use strict";
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const defaults=Object.freeze({capacityAh:.8,initialSoc:.35,targetSoc:.95,currentA:1,resistanceOhm:.12,targetX:.16,targetZ:.08,targetAngle:.25,scenario:"normal"});
  const labels=Object.freeze({idle:"Готова к запуску",homing:"Поиск нуля",detect:"Обнаружение техники",align:"Совмещение",dock:"Стыковка",charge:"Зарядка",disconnect:"Отключение тока",undock:"Расстыковка",return:"Возврат механизма",complete:"Цикл завершён",stopped:"Цикл остановлен",error:"Ошибка"});
  const home=[.01,.13,0,.75], limits=[[0,.24],[.02,.16],[-.8,.8],[.1,.9]];
  const vmax=[.035,.025,.45,.6], amax=[.08,.06,.9,1.2];
  const terminal=new Set(["idle","complete","stopped","error"]);
  function config(input={}){
    const c={...defaults,...input};
    for(const [key,min,max] of [["capacityAh",.1,5],["initialSoc",.05,.95],["targetSoc",.1,1],["currentA",.1,2],["resistanceOhm",.01,.5],["targetX",.05,.21],["targetZ",.04,.14],["targetAngle",-.6,.6]]){
      if(!Number.isFinite(c[key])||c[key]<min||c[key]>max)throw Error("Недопустимый параметр: "+key);
    }
    if(c.targetSoc<=c.initialSoc)throw Error("Целевой заряд должен быть больше начального.");
    if(!["normal","no-contact","connection","unreachable"].includes(c.scenario))throw Error("Неизвестный сценарий.");
    return c;
  }
  class Simulation{
    constructor(input){this.config=config(input);this.reset();}
    reset(){
      this.time=0;this.stageTime=0;this.stage="idle";this.q=[.025,.08,-.12,.6];this.velocity=[0,0,0,0];
      this.soc=this.config.initialSoc;this.polarization=0;this.current=0;this.voltage=this.ocv();this.outputVoltage=this.voltage;
      this.lossWh=0;this.energyWh=0;this.force=0;this.axisForce=[0,0];this.contact=false;this.homed=false;this.connected=true;this.mode="—";
      this.error="";this.reason="";this.userStopped=false;this.history=[];this.samples=[];this.sampleAt=0;this.lowCurrentTime=0;this.sample();
    }
    get active(){return !terminal.has(this.stage);}
    ocv(){return 3.2+.9*this.soc+.1*this.soc**8;}
    target(){return [this.config.scenario==="unreachable"?.32:this.config.targetX,this.config.targetZ,this.config.targetAngle,.3];}
    transition(stage){this.stage=stage;this.stageTime=0;this.history.push({time:this.time,stage});this.sample();}
    start(){if(this.stage!=="idle")return;this.transition("homing");}
    stop(){if(!this.active)return;this.userStopped=true;this.current=0;this.mode="—";this.transition("disconnect");}
    fail(message){this.error=message;this.current=0;this.mode="—";this.velocity.fill(0);this.transition("error");}
    move(goal,dt){
      if(goal.some((v,i)=>v<limits[i][0]||v>limits[i][1])){this.fail("Контакт машины вне рабочей области станции.");return false;}
      for(let i=0;i<4;i++){
        const error=goal[i]-this.q[i];
        const request=Math.sign(error)*Math.min(vmax[i],Math.sqrt(2*amax[i]*Math.abs(error)),5*Math.abs(error));
        const acceleration=clamp((request-this.velocity[i])/dt,-amax[i],amax[i]);
        this.velocity[i]+=acceleration*dt;this.q[i]=clamp(this.q[i]+this.velocity[i]*dt,...limits[i]);
        // Ideal closed-loop axes: gravity compensation, Coulomb and viscous friction.
        if(i<2)this.axisForce[i]=.25*acceleration+(i===1?.25*9.81:0)+.15*Math.sign(this.velocity[i])+.2*this.velocity[i];
      }
      return goal.every((v,i)=>Math.abs(v-this.q[i])<(i<2?.00015:.002)&&Math.abs(this.velocity[i])<(i<2?.0005:.005));
    }
    sample(){
      this.samples.push({time:this.time,stage:this.stage,q:[...this.q],soc:this.soc,current:this.current,voltage:this.voltage,outputVoltage:this.outputVoltage,force:this.force,contact:this.contact});
      if(this.samples.length>5000)this.samples.splice(1,1);
    }
    advance(seconds){
      if(!Number.isFinite(seconds)||seconds<0||seconds>60)throw Error("Шаг симуляции должен быть от 0 до 60 с.");
      let remaining=seconds;
      while(remaining>1e-9&&this.active){const dt=Math.min(.02,remaining);this.step(dt);remaining-=dt;}
    }
    step(dt){
      this.time+=dt;this.stageTime+=dt;this.axisForce=[0,0];
      if(this.stage==="charge"&&this.config.scenario==="connection"&&this.stageTime>=8){this.connected=false;this.fail("Потеря связи с контроллером. Ток отключён; механизм остаётся на месте.");return;}
      const target=this.target(),approach=[target[0]-.018,target[1],target[2],.75];
      if(this.stage==="homing"&&this.move(home,dt)){this.homed=true;this.transition("detect");}
      else if(this.stage==="detect"&&this.stageTime>=1)this.transition("align");
      else if(this.stage==="align"&&this.move(approach,dt))this.transition("dock");
      else if(this.stage==="dock"){
        const docked=this.move([target[0]+.001,target[1],target[2],target[3]],dt);
        this.force=Math.max(0,this.q[0]-target[0])*1000;
        this.contact=docked&&this.force>=.5&&this.config.scenario!=="no-contact";
        if(this.force>4)this.fail("Превышено тестовое усилие контакта.");
        else if(this.contact)this.transition("charge");
        else if(this.stageTime>8)this.fail("Нет подтверждения электрического контакта. Зарядка запрещена.");
      }else if(this.stage==="charge"){
        if(!this.contact||!this.homed||!this.connected){this.fail("Не выполнены условия разрешения заряда.");return;}
        const r0=.1,rp=.06,cp=600,voltageLimit=4.2,efficiency=.98;
        const allowed=clamp((voltageLimit-this.ocv()-this.polarization)/(r0+this.config.resistanceOhm),0,this.config.currentA);
        this.current=allowed;this.mode=allowed<this.config.currentA-1e-6?"CV":"CC";
        const chargeTime=Math.min(dt,(this.config.targetSoc-this.soc)*3600*this.config.capacityAh/(efficiency*Math.max(allowed,1e-12)));
        this.soc=clamp(this.soc+efficiency*allowed*chargeTime/(3600*this.config.capacityAh),0,this.config.targetSoc);
        this.polarization=allowed*rp+(this.polarization-allowed*rp)*Math.exp(-dt/(rp*cp));
        this.voltage=this.ocv()+allowed*r0+this.polarization;
        this.outputVoltage=this.voltage+allowed*this.config.resistanceOhm;
        this.lossWh+=allowed**2*this.config.resistanceOhm*chargeTime/3600;
        this.energyWh+=this.voltage*allowed*chargeTime/3600;
        this.lowCurrentTime=allowed<=.05?this.lowCurrentTime+dt:0;
        if(this.soc>=this.config.targetSoc-1e-10||this.lowCurrentTime>=5){
          this.reason=this.lowCurrentTime>=5?"Завершение по малому току":"Достигнут целевой заряд";
          this.current=0;this.mode="—";this.transition("disconnect");
        }
      }else if(this.stage==="disconnect"){
        this.current=0;
        if(this.stageTime>=.7)this.transition(this.contact?"undock":"return");
      }else if(this.stage==="undock"){
        if(this.current!==0){this.fail("Расстыковка при ненулевом токе запрещена.");return;}
        if(this.move(approach,dt)){this.contact=false;this.force=0;this.transition("return");}
        else{this.force=Math.max(0,this.q[0]-target[0])*1000;if(this.q[0]<target[0])this.contact=false;}
      }else if(this.stage==="return"&&this.move(home,dt)){
        this.velocity.fill(0);this.transition(this.userStopped?"stopped":"complete");
      }
      if(this.stage!=="charge"){
        this.current=0;this.polarization*=Math.exp(-dt/36);this.voltage=this.ocv()+this.polarization;this.outputVoltage=this.voltage;
      }
      if(this.stageTime>120&&["homing","align","dock","undock","return"].includes(this.stage))this.fail("Истекло время движения механизма.");
      if(this.time>=this.sampleAt){this.sample();this.sampleAt=this.time+2;}
    }
    export(){return {format:"roi-charging-test",version:1,synthetic:true,assumptions:{mechanics:"Ideal closed-loop acceleration-limited axes; not a validated motor model",battery:"Synthetic 1S OCV + R0 + one RC branch; constant 25 C; ideal CC/CV",sensors:"Simulated; no camera, controller or BMS connection",units:{time:"s",position:"m",angle:"rad",current:"A",voltage:"V",force:"N"}},config:{...this.config},result:{stage:this.stage,time:this.time,soc:this.soc,energyWh:this.energyWh,lossWh:this.lossWh,error:this.error,reason:this.reason},history:this.history,samples:[...this.samples,{time:this.time,stage:this.stage,q:[...this.q],soc:this.soc,current:this.current,voltage:this.voltage,outputVoltage:this.outputVoltage,force:this.force,contact:this.contact}]};}
  }
  const api=Object.freeze({Simulation,defaults,labels,limits});
  if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.ChargingModel=api;
})(typeof globalThis!=="undefined"?globalThis:this);
