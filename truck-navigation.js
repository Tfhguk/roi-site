(function(root){
  "use strict";
  const G=root.SetupGeometry;
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function rectangle(centre,length,width,heading=0){
    const ux=Math.cos(heading),uy=Math.sin(heading);
    return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({x:centre.x+ux*x*length/2-uy*y*width/2,y:centre.y+uy*x*length/2+ux*y*width/2}));
  }
  function create(source,config,route,learning=null){
    const scale=config.metresPerUnit,areas=source.zones.filter(z=>z.kind==="transport").map(z=>z.points),markers=G.routingMarkers(source.boundary,source.zones),safety=G.safetyContext(source.boundary,areas,markers);
    const policy={maxDepth:5,maxSlope:2,boundaryClearance:5,markerClearance:40,...Object.fromEntries(["maxDepth","maxSlope","boundaryClearance","markerClearance"].filter(k=>route[k]!==undefined).map(k=>[k,route[k]])),transportAreas:areas,markers};
    const stations=[],unavailable=[];
    for(const zone of source.zones.filter(z=>z.kind==="charging")){
      const centre=zone.points.reduce((a,p)=>({x:a.x+p.x/zone.points.length,y:a.y+p.y/zone.points.length}),{x:0,y:0});
      const anchors=source.routes.filter(r=>r.equipmentId===route.equipmentId).flatMap(r=>[r.points[0],r.points.at(-1)]).filter(p=>G.inside(p,zone.points));
      const cells=source.depth.cells.flatMap((v,i)=>{const p={x:(i%source.depth.cols+.5)*1000/source.depth.cols,y:(Math.floor(i/source.depth.cols)+.5)*700/source.depth.rows};return v!==null&&G.inside(p,zone.points)?[p]:[];}).sort((a,b)=>distance(a,centre)-distance(b,centre)).slice(0,24);
      let station;
      for(const dock of [...anchors,centre,...cells]){
        if(!G.inside(dock,zone.points)||G.clearanceErrors([dock],policy,safety).length)continue;
        const i=Math.min(source.depth.rows-1,Math.floor(dock.y/700*source.depth.rows))*source.depth.cols+Math.min(source.depth.cols-1,Math.floor(dock.x/1000*source.depth.cols));
        if(source.depth.cells[i]===null||source.depth.cells[i]>policy.maxDepth)continue;
        for(const heading of [0,Math.PI/2,Math.PI,-Math.PI/2]){
          const reach=.16/scale,base={x:dock.x-Math.cos(heading)*(config.stationLengthM/scale/2+reach),y:dock.y-Math.sin(heading)*(config.stationLengthM/scale/2+reach)};
          const footprint=rectangle(base,config.stationLengthM/scale,config.stationWidthM/scale,heading),obstacle=rectangle(base,(config.stationLengthM+.04)/scale,(config.stationWidthM+.04)/scale,heading);
          if(!G.inPolygon(obstacle,zone.points)||!G.inPolygon(obstacle,source.boundary)||!G.inAreas(obstacle,areas,true))continue;
          if(G.hitsObstacles([...obstacle,obstacle[0]],source.routingObstacles||[]))continue;
          if(G.clearanceErrors([...obstacle,obstacle[0]],{boundaryClearance:0,markerClearance:policy.markerClearance},safety).length)continue;
          if(source.routes.some(r=>r.points.length>1&&G.hitsObstacles(r.points,[obstacle]))||stations.some(s=>G.hitsObstacles([...obstacle,obstacle[0]],[s.obstacle])||G.hitsObstacles(s.footprint,[obstacle])))continue;
          station={id:zone.id,name:zone.name,dock:{...dock},centre:base,heading,dockHeading:Math.atan2(-Math.sin(heading),-Math.cos(heading)),lengthM:config.stationLengthM,widthM:config.stationWidthM,dimensionsStatus:"synthetic",footprint,obstacle};break;
        }
        if(station)break;
      }
      if(station)stations.push(station);else unavailable.push(zone.name);
    }
    const obstacles=[...stations.map(s=>s.obstacle),...(source.routingObstacles||[]),...(learning?.memory.hazards||[])],options={...policy,obstacles};
    const metric=!!(source.elevation&&root.MetricTerrain),preferred=config.maxGradeDeg??18,hard=Math.max(preferred,config.emergencyGradeDeg??25);
    let lastAnalysis=null,remembered=false;const assessments=new Map();
    function assess(a,b){
      if(!metric)return {passable:true,maxGradeDeg:0,minTractionReserve:1,reasons:[]};
      const key=[a.x,a.y,b.x,b.y].join(',');if(assessments.has(key))return assessments.get(key);
      const heading=Math.atan2(b.y-a.y,b.x-a.x),n=Math.max(1,Math.ceil(distance(a,b)*scale/.10)),result={passable:true,maxGradeDeg:0,minTractionReserve:1,driveFactor:0,reasons:[],warnings:[]};
      const height=(x,y)=>root.MetricTerrain.sample(source.elevation,x/scale,y/scale),mass=config.massKg+config.payloadKg;
      for(let i=0;i<=n;i++){
        const t=i/n,p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},x=p.x*scale,y=p.y*scale,h=.04,gx=(height(x+h,y)-height(x-h,y))/(2*h),gy=(height(x,y+h)-height(x,y-h))/(2*h);
        const along=gx*Math.cos(heading)+gy*Math.sin(heading),cross=-gx*Math.sin(heading)+gy*Math.cos(heading),incline=Math.atan(Math.hypot(gx,gy))*180/Math.PI,theta=Math.atan(Math.abs(along));
        const force=mass*9.81*(Math.sin(theta)+.03*Math.cos(theta)),traction=Math.min(config.mu*mass*9.81*Math.cos(theta),2*config.torqueLimit/config.k),reserve=1-force/Math.max(1e-6,traction);
        const tilt=Math.atan(Math.hypot(gx,gy)),terrainForce=mass*9.81*(Math.sin(tilt)+.03*Math.cos(tilt)),terrainGrip=Math.min(config.mu*mass*9.81*Math.cos(tilt),2*config.torqueLimit/config.k),terrainReserve=1-terrainForce/Math.max(1e-6,terrainGrip);
        // Penalize terrain roughness independently of edge heading. Otherwise
        // splitting one climb into oblique zigzags artificially lowers its cost.
        result.driveFactor+=(i===0||i===n ? .5 : 1)*(1+.6*(Math.hypot(gx,gy)/Math.tan(preferred*Math.PI/180))**2+1.2*(cross/Math.tan(hard*Math.PI/180))**2+3*Math.max(0,.2-terrainReserve)**2)/n;
        result.maxGradeDeg=Math.max(result.maxGradeDeg,incline);result.minTractionReserve=Math.min(result.minTractionReserve,reserve);
        const body=rectangle(p,.20/scale,.15/scale,heading);
        let reason='';
        if(!G.inPolygon(body,source.boundary)||!G.inAreas(body,areas,true)||G.hitsObstacles([...body,body[0]],stations.map(s=>s.footprint)))reason='Не проходит габарит машины';
        if(reason){result.passable=false;if(!result.reasons.includes(reason))result.reasons.push(reason);break;}
        if(incline>hard+.05&&!result.warnings.includes('Большой уклон'))result.warnings.push('Большой уклон');
        if(reserve<.10&&!result.warnings.includes('Малый запас тяги с грузом'))result.warnings.push('Малый запас тяги с грузом');
        if(Math.abs(Math.atan(cross))>Math.min(hard*Math.PI/180,Math.atan(config.trackWidth/(2*.07)))&&!result.warnings.includes('Большой поперечный наклон'))result.warnings.push('Большой поперечный наклон');
      }
      result.driveFactor=Math.max(1,result.driveFactor);if(assessments.size>20000)assessments.clear();assessments.set(key,result);return result;
    }
    // The third search is a physical attempt, not a claim of sufficient traction.
    // Geometry remains mandatory; slope and traction estimates become warnings.
    const driveCost=(a,b,m)=>m.length*assess(a,b).driveFactor;
    function limits(level){return {...options,...(metric?{maxSlope:1000,edgeCost:driveCost,traversable:(a,b)=>{const r=assess(a,b);return r.passable&&(level===2||!r.warnings.length&&r.maxGradeDeg<=(level===1?hard:preferred)+.05);}}:{})};}
    function analyze(points){
      const reasons=G.routeErrors({points,...limits(2)},source.boundary,source.depth,areas,safety),result={passable:!reasons.length,maxGradeDeg:0,minTractionReserve:1,preferredGradeDeg:preferred,hardGradeDeg:hard,steepFallback:false,attemptedFallback:false,remembered,reasons,warnings:[]};
      for(let i=1;i<points.length;i++){const r=assess(points[i-1],points[i]);result.maxGradeDeg=Math.max(result.maxGradeDeg,r.maxGradeDeg);result.minTractionReserve=Math.min(result.minTractionReserve,r.minTractionReserve);result.warnings.push(...(r.warnings||[]));if(!r.passable){result.passable=false;result.reasons.push(...r.reasons);}}
      result.lengthM=points.slice(1).reduce((sum,p,i)=>sum+distance(points[i],p)*scale,0);result.turns=Math.max(0,points.length-2);
      result.steepFallback=metric&&result.maxGradeDeg>preferred+.05;result.attemptedFallback=result.warnings.length>0;result.reasons=[...new Set(result.reasons)];result.warnings=[...new Set(result.warnings)];return result;
    }
    function validate(points){return analyze(points).reasons;}
    const cachedPlanners=new Map();
    function plan(start,end,objective="terrain"){
      if(distance(start,end)<.1){remembered=false;lastAnalysis=analyze([start,end]);return [{...start},{...end}];}
      remembered=false;
      for(const level of metric?[1,2]:[0]){
        const target=metric&&objective!=="shortest"?"efficient":objective,key=target+':'+level,rule={...limits(level),objective:target};
        if(!cachedPlanners.has(key))cachedPlanners.set(key,G.createPathPlanner(source.boundary,source.depth,rule));
        let points=cachedPlanners.get(key)(start,end);
        const score=p=>p.slice(1).reduce((sum,b,i)=>sum+(metric&&objective!=="shortest"?driveCost(p[i],b,{length:distance(p[i],b)}):distance(p[i],b)),0);
        const known=(learning?.candidates(start,end,scale)||[]).filter(p=>!G.routeErrors({points:p,...rule},source.boundary,source.depth,areas,safety).length&&p.slice(1).every((b,i)=>!rule.traversable||rule.traversable(p[i],b))).map(p=>metric?G.simplifyPath(p,source.boundary,source.depth,{...rule,edgeCost:objective==="shortest"?((a,b,m)=>m.length):driveCost}):p).filter(Boolean).sort((a,b)=>score(a)-score(b))[0];
        if(known&&(!points||score(known)<=score(points)+1e-5)){points=known;remembered=true;}
        if(points){lastAnalysis=analyze(points);if(lastAnalysis.passable)return points;}
      }
      lastAnalysis={passable:false,reasons:['Нет пути с учётом границ, габарита, препятствий и сохранённых запретов; ограничение уклона уже снято'],preferredGradeDeg:preferred,hardGradeDeg:hard};return null;
    }
    function estimate(points){
      const length=points.slice(1).reduce((sum,p,i)=>sum+distance(points[i],p)*scale,0),v=Math.min(config.speed,config.k*config.wheelLimit);
      const seconds=length/v+Math.max(0,points.length-2)*8+2*v/config.acceleration+40;
      const mass=config.massKg+config.payloadKg,power=Math.max(3,.18+12*(.12+.45*(mass*(config.acceleration+.03*9.81)*config.k)/.18));
      return {length,seconds,requiredSoc:seconds*power/(3600*config.capacityAh*3.2*config.converterEfficiency)};
    }
    function chargeRoute(start,soc){
      if(!stations.length)throw Error(unavailable.length?"В зоне зарядки не помещается тестовая станция с подъездом: "+unavailable.join(", "):"Добавьте зону зарядки внутри транспортной зоны.");
      const candidates=stations.flatMap(station=>{const points=plan(start,station.dock,"shortest");return points?[{points,station,analysis:lastAnalysis,...estimate(points)}]:[];}).sort((a,b)=>Number(a.analysis.attemptedFallback)-Number(b.analysis.attemptedFallback)||a.length-b.length||a.requiredSoc-b.requiredSoc);
      if(!candidates.length)throw Error("Из текущего положения нет допустимого пути к зарядной станции по карте глубины.");
      const reachable=candidates.find(r=>r.requiredSoc+.055<soc);
      if(!reachable)throw Error("Заряда недостаточно для доезда до доступной станции с резервом. Увеличьте порог выезда на зарядку.");
      lastAnalysis=reachable.analysis;
      return reachable;
    }
    function chargeHint(start){return stations.length?Math.min(...stations.map(s=>estimate([start,s.dock]).requiredSoc)):0;}
    function endpointKind(r,index){const point=index?r.points.at(-1):r.points[0];return source.zones.find(z=>z.id===(index?r.toZoneId:r.fromZoneId))?.kind||source.zones.find(z=>z.kind!=="transport"&&G.inside(point,z.points))?.kind;}
    const haulRoutes=source.routes.filter(r=>r.equipmentId===route.equipmentId&&[endpointKind(r,0),endpointKind(r,1)].sort().join(":")==="mining:warehouse");
    function workRoute(start,kind){
      const candidates=[];
      for(const zone of source.zones.filter(z=>z.kind===kind)){
        const centre=zone.points.reduce((a,p)=>({x:a.x+p.x/zone.points.length,y:a.y+p.y/zone.points.length}),{x:0,y:0});
        const anchors=haulRoutes.flatMap(r=>[r.points[0],r.points.at(-1)]).filter(p=>G.inside(p,zone.points));
        // Prefer a saved hauling endpoint, so work can resume on that trajectory.
        for(const end of [...anchors,centre]){const points=plan(start,end);if(points){candidates.push({points,zone,analysis:lastAnalysis,...estimate(points)});break;}}
      }
      candidates.sort((a,b)=>Number(a.analysis.attemptedFallback)-Number(b.analysis.attemptedFallback)||Number(a.analysis.steepFallback)-Number(b.analysis.steepFallback)||a.requiredSoc-b.requiredSoc);
      if(!candidates.length)throw Error("Не найден путь по карте глубины к "+(kind==="warehouse"?"складу":"зоне добычи")+" после зарядки.");
      lastAnalysis=candidates[0].analysis;
      return candidates[0];
    }
    function cycleRoute(start,kind){
      for(const r of haulRoutes){
        if(endpointKind(r,0)===kind&&distance(start,r.points[0])<.1&&!validate(r.points).length){lastAnalysis=analyze(r.points);return {...structuredClone(r),fromKind:kind,toKind:kind==="mining"?"warehouse":"mining"};}
        if(r.bidirectional!==false&&endpointKind(r,1)===kind&&distance(start,r.points.at(-1))<.1&&!validate(r.points).length){lastAnalysis=analyze(r.points);return {...structuredClone(r),points:structuredClone(r.points).reverse(),fromKind:kind,toKind:kind==="mining"?"warehouse":"mining"};}
      }
      const destination=workRoute(start,kind==="mining"?"warehouse":"mining");
      return {id:"dynamic-work",name:"Рабочий путь после зарядки",equipmentId:route.equipmentId,points:destination.points,fromKind:kind,toKind:destination.zone.kind,bidirectional:true};
    }
    function avoid(obstacle){obstacles.push(obstacle);learning?.hazard(obstacle);cachedPlanners.clear();}
    return {stations,unavailable,obstacles,validate,plan,estimate,chargeRoute,chargeHint,workRoute,cycleRoute,avoid,analyze,get analysis(){return lastAnalysis??=analyze(route.points);}};
  }
  const api=Object.freeze({create,rectangle});if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.TruckNavigation=api;
})(globalThis);
