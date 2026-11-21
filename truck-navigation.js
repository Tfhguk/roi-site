(function(root){
  "use strict";
  const G=root.SetupGeometry;
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function rectangle(centre,length,width,heading=0){
    const ux=Math.cos(heading),uy=Math.sin(heading);
    return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({x:centre.x+ux*x*length/2-uy*y*width/2,y:centre.y+uy*x*length/2+ux*y*width/2}));
  }
  function create(source,config,route){
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
    const obstacles=[...stations.map(s=>s.obstacle),...(source.routingObstacles||[])],options={...policy,obstacles};
    function validate(points){return G.routeErrors({points,...options},source.boundary,source.depth,areas,safety);}
    let cachedPlanner;
    function plan(start,end){
      if(distance(start,end)<.1)return [{...start},{...end}];
      cachedPlanner??=G.createPathPlanner(source.boundary,source.depth,options);
      const points=cachedPlanner(start,end);
      return points&&!validate(points).length?points:null;
    }
    function estimate(points){
      const length=points.slice(1).reduce((sum,p,i)=>sum+distance(points[i],p)*scale,0),v=Math.min(config.speed,config.k*config.wheelLimit);
      const seconds=length/v+Math.max(0,points.length-2)*8+2*v/config.acceleration+40;
      const mass=config.massKg+config.payloadKg,power=Math.max(3,.18+12*(.12+.45*(mass*(config.acceleration+.03*9.81)*config.k)/.18));
      return {length,seconds,requiredSoc:seconds*power/(3600*config.capacityAh*3.2*config.converterEfficiency)};
    }
    function chargeRoute(start,soc){
      if(!stations.length)throw Error(unavailable.length?"В зоне зарядки не помещается тестовая станция с подъездом: "+unavailable.join(", "):"Добавьте зону зарядки внутри транспортной зоны.");
      const candidates=stations.flatMap(station=>{const points=plan(start,station.dock);return points?[{points,station,...estimate(points)}]:[];}).sort((a,b)=>a.requiredSoc-b.requiredSoc);
      if(!candidates.length)throw Error("Из текущего положения нет допустимого пути к зарядной станции по карте глубины.");
      const reachable=candidates.find(r=>r.requiredSoc+.055<soc);
      if(!reachable)throw Error("Заряда недостаточно для доезда до доступной станции с резервом. Увеличьте порог выезда на зарядку.");
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
        for(const end of [...anchors,centre]){const points=plan(start,end);if(points){candidates.push({points,zone,...estimate(points)});break;}}
      }
      candidates.sort((a,b)=>a.requiredSoc-b.requiredSoc);
      if(!candidates.length)throw Error("Не найден путь по карте глубины к "+(kind==="warehouse"?"складу":"зоне добычи")+" после зарядки.");
      return candidates[0];
    }
    function cycleRoute(start,kind){
      for(const r of haulRoutes){
        if(endpointKind(r,0)===kind&&distance(start,r.points[0])<.1&&!validate(r.points).length)return {...structuredClone(r),fromKind:kind,toKind:kind==="mining"?"warehouse":"mining"};
        if(r.bidirectional!==false&&endpointKind(r,1)===kind&&distance(start,r.points.at(-1))<.1&&!validate(r.points).length)return {...structuredClone(r),points:structuredClone(r.points).reverse(),fromKind:kind,toKind:kind==="mining"?"warehouse":"mining"};
      }
      const destination=workRoute(start,kind==="mining"?"warehouse":"mining");
      return {id:"dynamic-work",name:"Рабочий путь после зарядки",equipmentId:route.equipmentId,points:destination.points,fromKind:kind,toKind:destination.zone.kind,bidirectional:true};
    }
    return {stations,unavailable,obstacles,validate,plan,estimate,chargeRoute,chargeHint,workRoute,cycleRoute};
  }
  const api=Object.freeze({create,rectangle});if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.TruckNavigation=api;
})(globalThis);
