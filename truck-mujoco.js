/* Browser controls and telemetry use the existing truck page; physics is MuJoCo. */
(()=>{
  "use strict";
  if(new URLSearchParams(location.search).get("mujoco")!=="1")return;
  const $=id=>document.getElementById(id);
  document.body.classList.add('mujoco-mode');
  let queue=Promise.resolve();
  const image=document.createElement("img");image.alt="3D сцена MuJoCo";image.draggable=false;
  Object.assign(image.style,{position:"absolute",inset:"0",width:"100%",height:"100%",objectFit:"contain",touchAction:"none",userSelect:"none",webkitUserSelect:"none",overscrollBehavior:"contain",cursor:"grab"});
  image.style.setProperty("-webkit-user-drag","none");
  for(const event of ["contextmenu","dragstart","selectstart"])image.addEventListener(event,e=>e.preventDefault());
  $("scene").append(image);$("depthReadout").hidden=true;
  const camera=document.createElement("div");Object.assign(camera.style,{position:"absolute",top:"8px",right:"8px",display:"flex",gap:"6px",zIndex:2});
  camera.innerHTML='<button type="button" id="follow3d">За самосвалом</button><button type="button" id="overview3d">Общий вид</button>';
  $("scene").append(camera);
  document.querySelector("h1").textContent="3D симуляция · MuJoCo";
  document.querySelector(".badge").textContent="Физика MuJoCo";
  document.querySelector(".truck-side").hidden=true;
  document.querySelector('.note').textContent='Высоты заданы в метрах. Рельеф и размеры техники тестовые. Площадки рабочих зон выровнены.';
  $("showDepthValues").closest("label").hidden=true;
  $("showDepth").parentElement.lastChild.textContent="Высоты, м";
  document.querySelector('.metrics').insertAdjacentHTML('beforeend','<div><span>Высота поверхности</span><strong id="height3d">0,00 м</strong></div><div><span>Продольный / боковой наклон</span><strong id="slope3d">0° / 0°</strong></div>');
  for(const id of ['leftSpeed','rightSpeed'])$(id).parentElement.classList.add('shaft-metric');
  document.querySelector('#settingsForm .fields').insertAdjacentHTML('beforeend','<label>Перепад рельефа, м<input name="terrainReliefM" type="number" min="0" max="0.6" step="0.05" required></label><label>Предельный уклон, °<input name="maxGradeDeg" type="number" min="2" max="20" step="1" required></label>');
  $("depthRange").textContent="Мышь — вращение · колесо — масштаб";
  let current=null,drag=null;
  function cameraCommand(values){return current?current.command("camera",values):Promise.resolve();}
  $("follow3d").onclick=()=>cameraCommand({follow:true,zoom:1});
  $("overview3d").onclick=()=>cameraCommand({follow:false,zoom:1});
  image.onpointerdown=e=>{if(e.button>2)return;e.preventDefault();image.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY};image.style.cursor="grabbing";};
  image.onpointerup=image.onpointercancel=e=>{e.preventDefault();drag=null;image.style.cursor="grab";if(image.hasPointerCapture(e.pointerId))image.releasePointerCapture(e.pointerId);};
  image.onlostpointercapture=()=>{drag=null;image.style.cursor="grab";};
  image.onpointermove=e=>{if(!drag||!current)return;current.azimuth+=(e.clientX-drag.x)*.5;current.elevation=Math.max(-89,Math.min(-10,current.elevation-(e.clientY-drag.y)*.3));drag={x:e.clientX,y:e.clientY};if(!current.cameraBusy){current.cameraBusy=true;cameraCommand({azimuth:current.azimuth,elevation:current.elevation}).finally(()=>{current.cameraBusy=false;});}};
  image.addEventListener("wheel",e=>{e.preventDefault();if(current){current.zoom=Math.max(.2,Math.min(4,current.zoom*Math.exp(e.deltaY*.001)));cameraCommand({zoom:current.zoom});}},{passive:false});
  class Remote extends TruckModel.Simulation{
    static defaults={terrainReliefM:.3,maxGradeDeg:10};
    constructor(route,config,source,onUpdate,onError){
      super(route,config,null);this.isMuJoCo=true;this.initializing=true;this.session=crypto.randomUUID();this.update=onUpdate;this.onError=onError;this.azimuth=90;this.elevation=-55;this.zoom=1;current=this;
      this.command("configure",{source,route,config});
    }
    command(op,values={}){
      const run=async()=>{
        if(this.disposed)return;
        const response=await fetch("/api/mujoco",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({op,session:this.session,...values})});
        const result=await response.json();if(!response.ok)throw Error(result.error||"Ошибка MuJoCo");
        if(this.disposed)return;
        // active is a getter on the common model; the stage determines it.
        const {active,soc,...state}=result.state;this.battery.soc=soc;Object.assign(this,state);this.picture="data:image/jpeg;base64,"+result.image;
        if(result.elevation)this.elevationMap=result.elevation;
        this.initializing=false;
        if(state.groundHeightM!==undefined){
          const n=v=>v.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
          $('height3d').textContent=n(state.groundHeightM)+' м';$('slope3d').textContent=n(state.pitchDeg)+'° / '+n(state.rollDeg)+'°';
          $('depthRange').textContent=n(state.heightMinM)+' — '+n(state.heightMaxM)+' м';
        }
        if(this.station)this.station.export=()=>({stage:this.station.stage});
        this.update();
      };
      const task=queue.then(run);queue=task.catch(()=>{});
      return task.catch(error=>{if(!this.disposed){this.initializing=false;this.error=error.message;this.stage="error";this.onError(error.message);this.update();}});
    }
    start(){this.command("start");}
    stop(){this.command("stop");}
    advance(seconds){if(this.busy||this.disposed||seconds<=0)return;this.busy=true;this.command("advance",{seconds:Math.min(1,seconds)}).finally(()=>{this.busy=false;});}
    sample(){}
    paint(){if(this.picture&&image.src!==this.picture)image.src=this.picture;}
    dispose(){this.disposed=true;}
    export(){const result=super.export();return {...result,engine:"MuJoCo",elevation:{...this.elevationMap,unit:"m",minimum:this.heightMinM,maximum:this.heightMaxM,groundHeight:this.groundHeightM},assumptions:{...result.assumptions,drive:"MuJoCo metric heightfield contacts; simplified skid-drive force controller and support spheres"}};}
  }
  $("showDepth").addEventListener("change",()=>current?.command("depth",{visible:$("showDepth").checked}));
  window.MuJoCoTruck=Remote;
})();
