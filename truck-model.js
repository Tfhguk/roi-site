(function(root){
  "use strict";
  const Station=typeof module!=="undefined"&&module.exports?require("./charging-model.js"):root.ChargingModel;
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x)), angle=x=>Math.atan2(Math.sin(x),Math.cos(x));
  const defaults=Object.freeze({metresPerUnit:.01,capacityAh:.8,initialSoc:.65,payloadKg:.2,massKg:1.2,trackWidth:.11,k:.018,wheelLimit:2*Math.PI,torqueLimit:.18,speed:.09,acceleration:.08,angularAcceleration:.8,mu:.5,converterEfficiency:.85,targetSoc:.9});
  const labels=Object.freeze({idle:"Готов к запуску",loading:"Погрузка",turning:"Поворот",driving:"Движение",raising:"Подъём кузова",unloading:"Разгрузка",lowering:"Опускание кузова",waiting:"Подтверждение остановки",station:"Зарядная станция",stopping:"Остановка",complete:"Маршрут завершён",stopped:"Остановлен",error:"Расчёт остановлен"});
  const terminal=new Set(["idle","complete","stopped","error"]);
  function configure(input){
    const c={...defaults,...input};
    for(const [key,lo,hi]of [["metresPerUnit",.0001,1],["capacityAh",.1,5],["initialSoc",.1,.95],["payloadKg",0,2],["massKg",.1,10],["trackWidth",.02,1],["k",.005,.1],["wheelLimit",.1,20],["torqueLimit",.01,1],["speed",.01,.3],["acceleration",.005,1],["angularAcceleration",.05,5],["mu",.05,1],["converterEfficiency",.1,1],["targetSoc",.2,.95]])if(!Number.isFinite(c[key])||c[key]<lo||c[key]>hi)throw Error("Недопустимый тестовый параметр: "+key);
    return c;
  }
  // Exact polyline following: brake at corners, turn in place, then move along
  // the next segment. This deliberately avoids shortcuts across forbidden land.
  class Simulation{
    constructor(route,config={}){
      this.config=configure(config);
      if(!route||!Array.isArray(route.points)||route.points.length<2||route.points.length>200||route.points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw Error("Выберите траекторию минимум из двух точек.");
      if(route.points.some((p,i)=>i&&Math.hypot(p.x-route.points[i-1].x,p.y-route.points[i-1].y)<1e-6))throw Error("В траектории есть совпадающие соседние точки.");
      this.route=structuredClone(route);this.points=route.points.map(p=>({x:p.x*this.config.metresPerUnit,y:p.y*this.config.metresPerUnit}));
      this.x=this.points[0].x;this.y=this.points[0].y;this.psi=0;this.v=0;this.omega=0;this.phiL=0;this.phiR=0;this.wL=0;this.wR=0;
      this.theta=0;this.payload=0;this.energyWh=0;this.motorPower=0;this.current=0;this.voltage=0;this.distance=0;this.time=0;this.stageTime=0;this.stage="idle";this.error="";
      this.battery={soc:this.config.initialSoc,polarization:0,loadA:0,chargeEnabled:false};
      this.voltage=this.ocv();
      this.station=null;this.index=1;this.direction=1;this.leg=0;this.history=[];this.samples=[];this.sampleAt=0;this.sample();
    }
    get active(){return !terminal.has(this.stage);}
    get soc(){return this.battery.soc;}
    ocv(){return 3.2+.9*this.soc+.1*this.soc**8;}
    transition(stage){this.stage=stage;this.stageTime=0;this.history.push({stage,time:this.time});this.sample();}
    start(){if(this.stage!=="idle")return;this.depart(this.route.fromKind);}
    depart(kind){if(kind==="mining"&&this.config.payloadKg>0)this.transition("loading");else this.transition("turning");}
    stop(){if(!this.active)return;if(this.station?.active)this.station.stop();this.transition("stopping");}
    fail(message){this.error=message;this.v=this.omega=this.wL=this.wR=0;this.battery.chargeEnabled=false;if(this.station?.active)this.station.fail(message);this.current=0;this.transition("error");}
    limits(){
      const c=this.config,m=c.massKg+this.payload;
      return {a:Math.max(0,Math.min(c.acceleration,(Math.min(2*c.torqueLimit/c.k,c.mu*m*9.81)-.03*m*9.81)/m)),alpha:Math.min(c.angularAcceleration,(c.trackWidth*c.torqueLimit/c.k)/(m*c.trackWidth*c.trackWidth/6)),v:Math.min(c.speed,c.k*c.wheelLimit),omega:Math.min(1.2,2*c.k*c.wheelLimit/c.trackWidth)};
    }
    target(){return this.points[this.index];}
    axis(speed,remaining,acceleration,maximum,dt){
      // The dt allowance starts braking early enough for discrete integration.
      const request=Math.min(maximum,Math.max(0,Math.sqrt(2*acceleration*Math.max(0,remaining))-acceleration*dt));
      return clamp(speed+clamp(request-speed,-acceleration*dt,acceleration*dt),0,maximum);
    }
    arrived(){
      this.v=this.omega=0;
      const end=this.direction===1?this.points.length-1:0;
      if(this.index!==end){this.index+=this.direction;this.transition("turning");return;}
      const kind=this.direction===1?this.route.toKind:this.route.fromKind;
      if(kind==="warehouse"&&this.payload>1e-6)this.transition("raising");
      else if(kind==="charging")this.transition("waiting");
      else this.finishLeg();
    }
    finishLeg(){
      if(this.route.returnTrip&&this.route.bidirectional!==false&&!this.leg){
        this.leg=1;this.direction=-1;this.index=this.points.length-2;this.depart(this.route.toKind);
      }else this.transition("complete");
    }
    advance(seconds){
      if(!Number.isFinite(seconds)||seconds<0||seconds>60)throw Error("Шаг расчёта должен быть от 0 до 60 с.");
      let remaining=seconds;
      while(this.active&&remaining>1e-9){const dt=Math.min(.01,remaining);this.step(dt);remaining-=dt;}
    }
    step(dt){
      this.time+=dt;this.stageTime+=dt;const c=this.config,lim=this.limits(),oldV=this.v,oldOmega=this.omega,oldTheta=this.theta;
      let stationAdvanced=false,batteryIntegrated=false;
      if(lim.a===0){this.fail("Для тестовой массы не хватает тяги. Проверьте массу и параметры привода.");return;}
      if(this.stage==="loading"){
        this.payload=Math.min(c.payloadKg,this.payload+c.payloadKg*dt/2);
        if(this.payload>=c.payloadKg-1e-9){this.payload=c.payloadKg;this.transition("turning");}
      }else if(this.stage==="turning"){
        const target=this.target(),error=angle(Math.atan2(target.y-this.y,target.x-this.x)-this.psi);
        const speed=this.axis(Math.abs(this.omega),Math.abs(error),lim.alpha,lim.omega,dt);
        const delta=Math.sign(error)*Math.min(Math.abs(error),(Math.abs(this.omega)+speed)*dt/2);
        this.psi=angle(this.psi+delta);this.omega=Math.sign(error)*speed;
        if(Math.abs(error)<=lim.alpha*dt*dt&&speed<=2*lim.alpha*dt){this.psi=Math.atan2(target.y-this.y,target.x-this.x);this.omega=0;this.transition("driving");}
      }else if(this.stage==="driving"||this.stage==="stopping"){
        if(this.stage==="stopping"&&this.station?.active){this.battery.chargeEnabled=false;batteryIntegrated=this.station.stage==="charge";this.station.advance(dt);stationAdvanced=true;}
        const target=this.target(),left=Math.hypot(target.x-this.x,target.y-this.y);
        const speed=this.stage==="stopping"?Math.max(0,this.v-lim.a*dt):this.axis(this.v,left,lim.a,lim.v,dt);
        const movement=Math.min(left,(this.v+speed)*dt/2);
        if(left>0){this.x+=(target.x-this.x)*movement/left;this.y+=(target.y-this.y)*movement/left;this.distance+=movement;}
        this.v=speed;this.omega=Math.sign(this.omega)*Math.max(0,Math.abs(this.omega)-lim.alpha*dt);
        if(this.stage==="stopping"){
          this.psi=angle(this.psi+(oldOmega+this.omega)*dt/2);this.theta=Math.max(0,this.theta-.35*dt);
          if(this.v<1e-9&&Math.abs(this.omega)<1e-9&&this.theta===0&&!this.station?.active)this.transition("stopped");
        }else if(left<=lim.a*dt*dt&&speed<=2*lim.a*dt){this.distance+=Math.max(0,left-movement);this.x=target.x;this.y=target.y;this.arrived();}
      }else if(this.stage==="raising"){
        this.theta=Math.min(.85,this.theta+.35*dt);if(this.theta>=.85)this.transition("unloading");
      }else if(this.stage==="unloading"){
        this.payload=Math.max(0,this.payload-.2*Math.max(0,Math.sin(this.theta-.4))*dt);
        if(this.payload<=1e-6){this.payload=0;this.transition("lowering");}
      }else if(this.stage==="lowering"){
        this.theta=Math.max(0,this.theta-.35*dt);if(!this.theta)this.finishLeg();
      }else if(this.stage==="waiting"&&this.stageTime>=.5){
        if(this.soc>=c.targetSoc)this.finishLeg();
        else{
          this.station=new Station.Simulation({capacityAh:c.capacityAh,initialSoc:this.soc,targetSoc:c.targetSoc},this.battery);this.station.start();this.transition("station");
        }
      }else if(this.stage==="station"){
        this.battery.chargeEnabled=this.v===0&&this.omega===0&&this.theta===0;
        this.battery.loadA=.05;batteryIntegrated=this.station.stage==="charge";this.station.advance(dt);stationAdvanced=true;
        if(this.station.stage==="error"){this.fail(this.station.error);return;}
        if(!this.station.active)this.finishLeg();
      }
      this.wL=(this.v-this.omega*c.trackWidth/2)/c.k;this.wR=(this.v+this.omega*c.trackWidth/2)/c.k;
      this.phiL+=this.wL*dt;this.phiR+=this.wR*dt;
      const acceleration=(this.v-oldV)/dt,alpha=(this.omega-oldOmega)/dt,m=c.massKg+this.payload,inertia=m*c.trackWidth*c.trackWidth/6;
      const force=m*acceleration+.03*m*9.81*Math.sign(this.v),yaw=inertia*alpha;
      const torqueL=(force/2-yaw/c.trackWidth)*c.k,torqueR=(force/2+yaw/c.trackWidth)*c.k;
      this.motorPower=Math.abs(torqueL*this.wL)+Math.abs(torqueR*this.wR);
      const driving=Math.abs(this.wL)+Math.abs(this.wR)>0;
      const power=.18+(driving?12*(.12+.45*(Math.abs(torqueL)+Math.abs(torqueR))/.18):0)+(this.theta!==oldTheta?1.5:0);
      // Synthetic 1S supply, virtual 12 V motor bus; motor braking is dissipative.
      if(!batteryIntegrated){
        const load=(this.stage==="station"||this.station?.active)?.05:power/(c.converterEfficiency*Math.max(2.5,this.ocv()));
        this.battery.soc=clamp(this.soc-load*dt/(3600*c.capacityAh),0,1);
        if(!stationAdvanced)this.battery.polarization=(-load)*.06+(this.battery.polarization+load*.06)*Math.exp(-dt/36);
        this.current=-load;this.voltage=this.ocv()-.1*load+this.battery.polarization;this.energyWh+=power*dt/3600;
      }else{this.current=this.station.current-this.battery.loadA;this.voltage=this.station.voltage;}
      if(this.soc<=.05){this.fail("Тестовая батарея разряжена. Увеличьте начальный заряд или сократите маршрут.");return;}
      if(this.stageTime>7200){this.fail("Превышено модельное время этапа.");return;}
      if(!this.active){this.v=this.omega=this.wL=this.wR=0;this.current=0;this.battery.chargeEnabled=false;}
      if(this.time>=this.sampleAt){this.sample();this.sampleAt=this.time+.5;}
    }
    sample(){this.samples.push({time:this.time,stage:this.stage,x:this.x,y:this.y,psi:this.psi,v:this.v,omega:this.omega,wL:this.wL,wR:this.wR,phiL:this.phiL,phiR:this.phiR,theta:this.theta,payloadKg:this.payload,soc:this.soc,current:this.current,voltage:this.voltage,motorPowerW:this.motorPower,distance:this.distance});if(this.samples.length>10000)this.samples.splice(1,1);}
    export(){return {format:"roi-truck-test",version:1,synthetic:true,assumptions:{drive:"Ideal differential drive; brake at every polyline vertex; no slip or collision envelope",parameters:"Virtual test parameters, not an identified JGA25-370 or lift linkage",battery:"Shared 1S OCV + R0 + RC battery; virtual 12 V bus; constant 25 C; no regenerative braking",unknown:["real motor variant","servo calibration and linkage","strength and stability","real battery and BMS limits","physical terrain slope and footprint"]},config:{...this.config},route:structuredClone(this.route),result:{stage:this.stage,time:this.time,distance:this.distance,soc:this.soc,energyWh:this.energyWh,error:this.error},history:[...this.history],samples:[...this.samples],station:this.station?.export()||null};}
  }
  const api=Object.freeze({Simulation,defaults,labels});if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.TruckModel=api;
})(globalThis);
