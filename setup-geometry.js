(function (global) {
  "use strict";
  const W = 1000, H = 700, EPS = 1e-7;
  const cross = (a,b,c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  function nearSegment(p,a,b) {
    const d=(b.x-a.x)**2+(b.y-a.y)**2;
    const t=d ? Math.max(0,Math.min(1,((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/d)) : 0;
    const point={x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)};
    return {point,t,distance:dist(p,point)};
  }
  function inside(p, points) {
    let yes=false;
    for(let i=0,j=points.length-1;i<points.length;j=i++) {
      const a=points[j],b=points[i];
      if(nearSegment(p,a,b).distance<EPS) return true;
      if((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) yes=!yes;
    }
    return yes;
  }
  function validPoints(points, closed=true) {
    return Array.isArray(points) && points.length>=(closed?3:2) && points.length<=200 &&
      points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=W&&p.y>=0&&p.y<=H) &&
      points.every((p,i)=>points.every((q,j)=>i===j||dist(p,q)>0.1)) && PolygonGeometry.isSimple(points,closed);
  }
  // Split a segment at every polygon edge and grid boundary. Checking each
  // resulting interval covers concave boundaries and thin blocked cells.
  function segmentCuts(a,b,polygon,depth) {
    const ts=[0,1];
    for(let i=0;i<polygon.length;i++) {
      const c=polygon[i],d=polygon[(i+1)%polygon.length];
      const den=(b.x-a.x)*(d.y-c.y)-(b.y-a.y)*(d.x-c.x);
      if(Math.abs(den)<EPS) continue;
      const t=((c.x-a.x)*(d.y-c.y)-(c.y-a.y)*(d.x-c.x))/den;
      const u=((c.x-a.x)*(b.y-a.y)-(c.y-a.y)*(b.x-a.x))/den;
      if(t>0&&t<1&&u>=0&&u<=1) ts.push(t);
    }
    if(depth) {
      for(let x=0;x<=depth.cols;x++) if(Math.abs(b.x-a.x)>EPS) {const t=(x*W/depth.cols-a.x)/(b.x-a.x);if(t>0&&t<1)ts.push(t);}
      for(let y=0;y<=depth.rows;y++) if(Math.abs(b.y-a.y)>EPS) {const t=(y*H/depth.rows-a.y)/(b.y-a.y);if(t>0&&t<1)ts.push(t);}
    }
    return ts.sort((a,b)=>a-b).filter((t,i,all)=>!i||t-all[i-1]>EPS);
  }
  function inPolygon(points, polygon, closed=true) {
    if(!points.every(p=>inside(p,polygon))) return false;
    for(let i=0;i<points.length-(closed?0:1);i++) {
      const a=points[i],b=points[(i+1)%points.length],ts=segmentCuts(a,b,polygon);
      for(let j=1;j<ts.length;j++) {const t=(ts[j-1]+ts[j])/2;if(!inside({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},polygon))return false;}
    }
    return true;
  }
  function emptyDepth() {return {version:1,width:W,height:H,cols:20,rows:14,unit:"условные единицы",cells:Array(280).fill(0)};}
  function validateDepth(map) {
    if(!map||map.version!==1||map.width!==W||map.height!==H||!Number.isInteger(map.cols)||!Number.isInteger(map.rows)||
      map.cols<2||map.cols>100||map.rows<2||map.rows>100||!Array.isArray(map.cells)||map.cells.length!==map.cols*map.rows||
      !map.cells.every(v=>v===null||Number.isFinite(v)&&v>=0&&v<=1000)) throw Error("Некорректная карта: version=1, поле 1000×700, сетка 2–100, значения 0–1000 или null (препятствие).");
    return {version:1,width:W,height:H,cols:map.cols,rows:map.rows,unit:"условные единицы",cells:map.cells.slice(),
      ...(map.source==="synthetic"&&Number.isInteger(map.seed)?{source:"synthetic",seed:map.seed>>>0}:{})};
  }
  function routeErrors(route,polygon,depth) {
    const errors=[];
    if(!validPoints(route.points,false)) return ["Нужно не менее двух разных точек без самопересечений."];
    if(!inPolygon(route.points,polygon,false)) errors.push("Траектория выходит за границу полигона.");
    if(!Number.isFinite(route.maxDepth)||route.maxDepth<0||!Number.isFinite(route.maxSlope)||route.maxSlope<0) return [...errors,"Задайте допустимую глубину и перепад не меньше нуля."];
    for(let i=1;i<route.points.length;i++) {
      const a=route.points[i-1],b=route.points[i],ts=segmentCuts(a,b,polygon,depth);
      let previous;
      const samples=[0,...ts.slice(1).flatMap((t,j)=>[(ts[j]+t)/2,t])];
      for(const t of samples) {
        const x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;
        // At grid boundaries include both neighbouring cells, so a route
        // cannot run exactly along the edge of a blocked cell.
        const col=x/W*depth.cols,row=y/H*depth.rows;
        const cs=[Math.floor(col),...(Math.abs(col-Math.round(col))<EPS?[Math.round(col)-1]:[])];
        const rs=[Math.floor(row),...(Math.abs(row-Math.round(row))<EPS?[Math.round(row)-1]:[])];
        const values=[];
        for(const cy of rs)for(const cx of cs)if(cx>=0&&cy>=0&&cx<depth.cols&&cy<depth.rows)values.push(depth.cells[cy*depth.cols+cx]);
        if(values.includes(null)) errors.push("Траектория пересекает препятствие на карте глубины.");
        if(values.some(v=>v!==null&&v>route.maxDepth))errors.push("Превышена допустимая глубина.");
        const numeric=values.filter(v=>v!==null);
        if(numeric.length) {
          const low=Math.min(...numeric),high=Math.max(...numeric);
          if(high-low>route.maxSlope||previous&&(Math.abs(high-previous.low)>route.maxSlope||Math.abs(low-previous.high)>route.maxSlope)) errors.push("Превышен допустимый перепад глубин.");
          previous={low,high};
        }
      }
    }
    return [...new Set(errors)];
  }
  function generateDepth(polygon,zones=[],seed=1,cols=40,rows=28) {
    let state=seed>>>0;
    const random=()=>{state=(state+0x6D2B79F5)>>>0;let n=Math.imul(state^(state>>>15),1|state);n^=n+Math.imul(n^(n>>>7),61|n);return ((n^(n>>>14))>>>0)/4294967296;};
    const map=validateDepth({...emptyDepth(),cols,rows,cells:Array(cols*rows).fill(0)});
    const hills=Array.from({length:7},()=>({x:random()*W,y:random()*H,r:100+random()*170,h:1+random()*4}));
    map.cells=map.cells.map((_,i)=>{
      const p={x:(i%cols+.5)*W/cols,y:(Math.floor(i/cols)+.5)*H/rows};
      let value=.2+.45*hills.reduce((sum,h)=>sum+h.h*Math.exp(-((p.x-h.x)**2+(p.y-h.y)**2)/(2*h.r*h.r)),0);
      const protectedZone=zones.some(z=>inside(p,z.points)||z.points.some(q=>dist(p,q)<Math.hypot(W/cols,H/rows)));
      const blocked=random()<.045;
      if(protectedZone)value=Math.min(value,2);
      return !inside(p,polygon)?null:blocked&&!protectedZone?null:Math.round(value*100)/100;
    });
    return {...map,source:"synthetic",seed:seed>>>0};
  }
  function plannerLimits(options={}) {
    const limits={maxDepth:options.maxDepth??5,maxSlope:options.maxSlope??2};
    if(!Object.values(limits).every(v=>Number.isFinite(v)&&v>=0&&v<=1000))throw Error("Глубина и перепад для автопостроения должны быть от 0 до 1000.");
    return limits;
  }
  function makeGraph(polygon,depth,limits) {
    const nodes=depth.cells.map((value,i)=>({x:(i%depth.cols+.5)*W/depth.cols,y:(Math.floor(i/depth.cols)+.5)*H/depth.rows}));
    const allowed=nodes.map((p,i)=>depth.cells[i]!==null&&depth.cells[i]<=limits.maxDepth&&inside(p,polygon));
    const edges=new Map();
    const safe=(a,b)=>!routeErrors({points:[a,b],...limits},polygon,depth).length;
    function neighbours(i){
      if(edges.has(i))return edges.get(i);
      const x=i%depth.cols,y=Math.floor(i/depth.cols),result=[];
      for(const [dx,dy]of [[-1,0],[1,0],[0,-1],[0,1]]){
        const nx=x+dx,ny=y+dy,j=ny*depth.cols+nx;
        if(nx<0||nx>=depth.cols||ny<0||ny>=depth.rows||!allowed[j])continue;
        if(Math.abs(depth.cells[i]-depth.cells[j])>limits.maxSlope||!inPolygon([nodes[i],nodes[j]],polygon,false))continue;
        result.push(j);
      }
      edges.set(i,result);return result;
    }
    return {nodes,allowed,neighbours,safe};
  }
  // A* searches four-connected cell centres. Each shortcut is rechecked by the
  // same exact segment/cell validator used for manually edited routes.
  function searchPath(start,end,polygon,depth,limits,graph) {
    if(dist(start,end)<=.1)return null;
    if(graph.safe(start,end))return [start,end].map(p=>({...p}));
    const {nodes,allowed}=graph;
    function connectors(p){
      return nodes.map((q,i)=>({i,d:dist(p,q)})).filter(item=>allowed[item.i]).sort((a,b)=>a.d-b.d).slice(0,24)
        .filter(item=>item.d<=.1||graph.safe(p,nodes[item.i]));
    }
    const starts=connectors(start),ends=new Map(connectors(end).map(item=>[item.i,item.d]));
    if(!starts.length||!ends.size)return null;
    const costs=new Float64Array(nodes.length).fill(Infinity),previous=new Int32Array(nodes.length).fill(-1),closed=new Uint8Array(nodes.length),heap=[];
    function push(item){let i=heap.length;heap.push(item);while(i){const parent=(i-1)>>1;if(heap[parent].f<=item.f)break;heap[i]=heap[parent];i=parent;}heap[i]=item;}
    function pop(){const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].f<heap[child].f)child++;if(heap[child].f>=last.f)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;}
    for(const item of starts){costs[item.i]=item.d;push({i:item.i,f:item.d+dist(nodes[item.i],end)});}
    let goal=-1,best=Infinity;
    while(heap.length){
      const item=pop(),i=item.i;if(item.f>=best)break;if(closed[i])continue;closed[i]=1;
      if(ends.has(i)&&costs[i]+ends.get(i)<best){best=costs[i]+ends.get(i);goal=i;}
      for(const j of graph.neighbours(i)){
        const risk=.15*depth.cells[j]/Math.max(1,limits.maxDepth)+.3*Math.abs(depth.cells[i]-depth.cells[j])/Math.max(1,limits.maxSlope);
        const cost=costs[i]+dist(nodes[i],nodes[j])*(1+risk);
        if(cost>=costs[j])continue;costs[j]=cost;previous[j]=i;push({i:j,f:cost+dist(nodes[j],end)});
      }
    }
    if(goal<0)return null;
    const raw=[];for(let i=goal;i>=0;i=previous[i])raw.push(nodes[i]);raw.reverse();raw.unshift(start);raw.push(end);
    const unique=raw.filter((p,i)=>!i||dist(p,raw[i-1])>.1),corners=[];
    for(const p of unique){while(corners.length>1&&Math.abs(cross(corners.at(-2),corners.at(-1),p))<EPS)corners.pop();corners.push(p);}
    const simplified=[corners[0]];let index=0;
    while(index<corners.length-1){let next=Math.min(corners.length-1,index+100);while(next>index+1&&!graph.safe(corners[index],corners[next]))next--;simplified.push(corners[next]);index=next;}
    return !routeErrors({points:simplified,...limits},polygon,depth).length?simplified.map(p=>({...p})):null;
  }
  function findPath(start,end,polygon,depth,options={}) {
    validateDepth(depth);const limits=plannerLimits(options);
    return searchPath(start,end,polygon,depth,limits,makeGraph(polygon,depth,limits));
  }
  function planRoutes(polygon,zones,equipment,depth,options={}) {
    validateDepth(depth);const limits=plannerLimits(options),graph=makeGraph(polygon,depth,limits);
    const pairs=[];
    for(const from of zones)for(const to of zones)if(from.id!==to.id&&(
      options.allPairs?zones.indexOf(from)<zones.indexOf(to):from.kind==="mining"&&to.kind==="warehouse"||from.kind==="warehouse"&&["transport","charging"].includes(to.kind)))pairs.push([from,to]);
    if(!equipment.length)throw Error("Добавьте технику в гараж.");
    if(!pairs.length)throw Error("Для автопостроения нужны зоны добычи, склада, транспортировки или зарядки.");
    if(pairs.length*equipment.length>30)throw Error("Получается больше 30 траекторий. Выберите одну единицу техники для автопостроения.");
    function anchor(zone){
      const centre={x:zone.points.reduce((s,p)=>s+p.x,0)/zone.points.length,y:zone.points.reduce((s,p)=>s+p.y,0)/zone.points.length};
      const candidates=graph.nodes.filter((p,i)=>graph.allowed[i]&&inside(p,zone.points)).sort((a,b)=>dist(a,centre)-dist(b,centre));
      if(candidates.length)return candidates[0];
      return [centre,...zone.points].find(p=>inside(p,zone.points)&&graph.nodes.some((q,i)=>graph.allowed[i]&&(dist(p,q)<=.1||graph.safe(p,q))));
    }
    const anchors=new Map(zones.map(zone=>[zone.id,anchor(zone)])),routes=[],unreachable=[];
    for(const [from,to]of pairs){
      const a=anchors.get(from.id),b=anchors.get(to.id),path=a&&b?searchPath(a,b,polygon,depth,limits,graph):null;
      if(!path){unreachable.push(from.name+" → "+to.name);continue;}
      for(const vehicle of equipment)routes.push({name:Array.from(vehicle.name+": "+from.name+" → "+to.name).slice(0,100).join(""),equipmentId:vehicle.id,fromZoneId:from.id,toZoneId:to.id,points:path.map(p=>({...p})),...limits});
    }
    return {routes,unreachable};
  }
  global.SetupGeometry=Object.freeze({W,H,inside,nearSegment,validPoints,inPolygon,emptyDepth,validateDepth,routeErrors,generateDepth,findPath,planRoutes});
})(globalThis);
