/* Browser controls and telemetry use the existing truck page; physics is MuJoCo. */
(()=>{
  "use strict";
  if(new URLSearchParams(location.search).get("mujoco")!=="1")return;
  const $=id=>document.getElementById(id);
  let queue=Promise.resolve();
  const image=document.createElement("img");image.alt="3D сцена MuJoCo";
  Object.assign(image.style,{position:"absolute",inset:"0",width:"100%",height:"100%",objectFit:"contain",touchAction:"none"});
  $("scene").append(image);$("depthReadout").hidden=true;
  const camera=document.createElement("div");Object.assign(camera.style,{position:"absolute",top:"8px",right:"8px",display:"flex",gap:"6px",zIndex:2});
  camera.innerHTML='<button type="button" id="follow3d">За самосвалом</button><button type="button" id="overview3d">Общий вид</button>';
  $("scene").append(camera);
  document.querySelector("h1").textContent="3D симуляция · MuJoCo";
  document.querySelector(".badge").textContent="Физика MuJoCo";
  document.querySelector(".truck-side").hidden=true;
  $("showDepthValues").closest("label").hidden=true;
  $("depthRange").textContent="Мышь — вращение · колесо — масштаб";
  let current=null,drag=null;
  function cameraCommand(values){return current?current.command("camera",values):Promise.resolve();}
  $("follow3d").onclick=()=>cameraCommand({follow:true,zoom:1});
  $("overview3d").onclick=()=>cameraCommand({follow:false,zoom:1});
  image.onpointerdown=e=>{image.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY};};
  image.onpointerup=image.onpointercancel=()=>{drag=null;};
  image.onpointermove=e=>{if(!drag||!current)return;current.azimuth+=(e.clientX-drag.x)*.5;current.elevation=Math.max(-89,Math.min(-10,current.elevation-(e.clientY-drag.y)*.3));drag={x:e.clientX,y:e.clientY};if(!current.cameraBusy){current.cameraBusy=true;cameraCommand({azimuth:current.azimuth,elevation:current.elevation}).finally(()=>{current.cameraBusy=false;});}};
  image.onwheel=e=>{e.preventDefault();if(current){current.zoom=Math.max(.2,Math.min(4,current.zoom*Math.exp(e.deltaY*.001)));cameraCommand({zoom:current.zoom});}};
  class Remote extends TruckModel.Simulation{
    constructor(route,config,source,onUpdate,onError){
      super(route,config,null);this.isMuJoCo=true;this.session=crypto.randomUUID();this.update=onUpdate;this.onError=onError;this.azimuth=90;this.elevation=-55;this.zoom=1;current=this;
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
        if(this.station)this.station.export=()=>({stage:this.station.stage});
        this.update();
      };
      const task=queue.then(run);queue=task.catch(()=>{});
      return task.catch(error=>{if(!this.disposed){this.error=error.message;this.stage="error";this.onError(error.message);this.update();}});
    }
    start(){this.command("start");}
    stop(){this.command("stop");}
    advance(seconds){if(this.busy||this.disposed||seconds<=0)return;this.busy=true;this.command("advance",{seconds:Math.min(1,seconds)}).finally(()=>{this.busy=false;});}
    sample(){}
    paint(){if(this.picture&&image.src!==this.picture)image.src=this.picture;}
    dispose(){this.disposed=true;}
    export(){const result=super.export();return {...result,engine:"MuJoCo",assumptions:{...result.assumptions,drive:"MuJoCo planar chassis dynamics and simplified lateral resistance; flat physical ground"}};}
  }
  $("showDepth").addEventListener("change",()=>current?.command("depth",{visible:$("showDepth").checked}));
  window.MuJoCoTruck=Remote;
})();
