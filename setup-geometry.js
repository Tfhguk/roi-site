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
  function inAreas(points,areas,closed=false){
    const contains=p=>areas.some(area=>inside(p,area));
    if(!areas.length||!points.every(contains))return false;
    for(let i=0;i<points.length-(closed?0:1);i++){
      const a=points[i],b=points[(i+1)%points.length],ts=[0,1,...areas.flatMap(area=>segmentCuts(a,b,area))].sort((a,b)=>a-b);
      for(let j=1;j<ts.length;j++){const t=(ts[j-1]+ts[j])/2;if(!contains({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}))return false;}
    }
    return true;
  }
  function zoneErrors(zones,polygon){
    const areas=zones.filter(z=>z.kind==="transport").map(z=>z.points),errors=[];
    if(areas.length>1)return ["В проекте полигона допускается только одна транспортная зона. Удалите лишнюю или измените существующую."];
    if(!areas.length)return ["Нарисуйте транспортную зону — область, внутри которой разрешено движение техники."];
    for(const zone of zones)if(zone.kind!=="transport"&&(!inPolygon(zone.points,polygon)||!inAreas(zone.points,areas,true)))errors.push("Зона «"+zone.name+"» должна целиком находиться в транспортной зоне.");
    return errors;
  }
  function segmentDistance(a,b,c,d){
    const den=(b.x-a.x)*(d.y-c.y)-(b.y-a.y)*(d.x-c.x);
    if(Math.abs(den)>EPS){const t=((c.x-a.x)*(d.y-c.y)-(c.y-a.y)*(d.x-c.x))/den,u=((c.x-a.x)*(b.y-a.y)-(c.y-a.y)*(b.x-a.x))/den;if(t>=0&&t<=1&&u>=0&&u<=1)return 0;}
    return Math.min(nearSegment(a,c,d).distance,nearSegment(b,c,d).distance,nearSegment(c,a,b).distance,nearSegment(d,a,b).distance);
  }
  function hitsObstacles(points,obstacles=[]){
    return obstacles.some(polygon=>points.some(p=>inside(p,polygon))||points.some((p,i)=>i&&polygon.some((q,j)=>segmentDistance(points[i-1],p,q,polygon[(j+1)%polygon.length])<EPS)));
  }
  function areaEdges(areas){
    const edges=[],contains=p=>areas.some(area=>inside(p,area));
    for(const area of areas)area.forEach((a,i)=>{
      const b=area[(i+1)%area.length],length=dist(a,b);if(length<EPS)return;
      const ts=[0,1,...areas.flatMap(other=>segmentCuts(a,b,other)),...areas.flatMap(other=>other.filter(p=>nearSegment(p,a,b).distance<EPS).map(p=>nearSegment(p,a,b).t))].sort((a,b)=>a-b);
      for(let j=1;j<ts.length;j++){if(ts[j]-ts[j-1]<EPS)continue;const t=(ts[j]+ts[j-1])/2,p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},nx=-(b.y-a.y)/length*1e-4,ny=(b.x-a.x)/length*1e-4;
        if(contains({x:p.x+nx,y:p.y+ny})&&contains({x:p.x-nx,y:p.y-ny}))continue;
        edges.push([{x:a.x+(b.x-a.x)*ts[j-1],y:a.y+(b.y-a.y)*ts[j-1]},{x:a.x+(b.x-a.x)*ts[j],y:a.y+(b.y-a.y)*ts[j]}]);
      }
    });return edges;
  }
  function routingMarkers(polygon,zones){return [...polygon,...zones.flatMap(zone=>zone.points)].filter((p,i,all)=>all.findIndex(q=>dist(p,q)<EPS)===i);}
  function safetyContext(polygon,areas,markers=[]){return {edges:[...polygon.map((p,i)=>[p,polygon[(i+1)%polygon.length]]),...areaEdges(areas||[])],markers};}
  function clearanceErrors(points,policy,context){
    const edgeGap=policy.boundaryClearance??0,markerGap=policy.markerClearance??0,errors=[];
    if(![edgeGap,markerGap].every(v=>Number.isFinite(v)&&v>=0&&v<=1000))return ["Укажите корректные отступы от границ и арукомаркеров."];
    for(let i=0;i<Math.max(1,points.length-1);i++){
      const a=points[i],b=points[i+1]||a;
      if(edgeGap>0&&context.edges.some(([c,d])=>segmentDistance(a,b,c,d)<edgeGap-EPS))errors.push("Недостаточный отступ от границы транспортной зоны или полигона.");
      if(markerGap>0&&context.markers.some(p=>nearSegment(p,a,b).distance<markerGap-EPS))errors.push("Траектория проходит слишком близко к арукомаркеру.");
    }return [...new Set(errors)];
  }
  function validateDepth(map) {
    if(!map||map.version!==1||map.width!==W||map.height!==H||!Number.isInteger(map.cols)||!Number.isInteger(map.rows)||
      map.cols<2||map.cols>100||map.rows<2||map.rows>100||!Array.isArray(map.cells)||map.cells.length!==map.cols*map.rows||
      !map.cells.every(v=>v===null||Number.isFinite(v)&&v>=0&&v<=1000)) throw Error("Некорректная карта: version=1, поле 1000×700, сетка 2–100, значения 0–1000 или null (препятствие).");
    return {version:1,width:W,height:H,cols:map.cols,rows:map.rows,unit:"условные единицы",cells:map.cells.slice(),
      ...(map.source==="synthetic"&&Number.isInteger(map.seed)?{source:"synthetic",seed:map.seed>>>0}:{})};
  }
  function routeErrors(route,polygon,depth,transportAreas,safety) {
    const errors=[];
    if(!validPoints(route.points,false)) return ["Нужно не менее двух разных точек без самопересечений."];
    if(!inPolygon(route.points,polygon,false)) errors.push("Траектория выходит за границу полигона.");
    if(transportAreas&&!inAreas(route.points,transportAreas))errors.push("Траектория выходит из транспортной зоны — области разрешённого движения.");
    if(hitsObstacles(route.points,route.obstacles))errors.push("Траектория пересекает корпус зарядной станции.");
    errors.push(...clearanceErrors(route.points,route,safety||safetyContext(polygon,transportAreas)));
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
  class MinHeap {
    constructor(compare){this.items=[];this.compare=compare;}
    get length(){return this.items.length;}
    push(item){const a=this.items;let i=a.length;a.push(item);while(i){const p=(i-1)>>1;if(this.compare(a[p],item)<=0)break;a[i]=a[p];i=p;}a[i]=item;}
    pop(){const a=this.items,first=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&this.compare(a[c+1],a[c])<0)c++;if(this.compare(a[c],last)>=0)break;a[i]=a[c];i=c;}a[i]=last;}return first;}
  }
  function cellsAt(p,depth){
    const x=p.x/W*depth.cols,y=p.y/H*depth.rows;
    const xs=[Math.floor(x),...(Math.abs(x-Math.round(x))<EPS?[Math.round(x)-1]:[])];
    const ys=[Math.floor(y),...(Math.abs(y-Math.round(y))<EPS?[Math.round(y)-1]:[])];
    const result=[];for(const cy of ys)for(const cx of xs)if(cx>=0&&cx<depth.cols&&cy>=0&&cy<depth.rows)result.push(cy*depth.cols+cx);
    return result;
  }
  function zoneCentre(zone){
    const points=zone.points;
    let area=0,x=0,y=0;
    points.forEach((p,i)=>{const q=points[(i+1)%points.length],a=p.x*q.y-q.x*p.y;area+=a;x+=(p.x+q.x)*a;y+=(p.y+q.y)*a;});
    const candidates=[];if(Math.abs(area)>EPS)candidates.push({x:x/(3*area),y:y/(3*area)});
    candidates.push({x:points.reduce((s,p)=>s+p.x,0)/points.length,y:points.reduce((s,p)=>s+p.y,0)/points.length});
    points.forEach((p,i)=>{const a=points[(i+points.length-1)%points.length],b=points[(i+1)%points.length];candidates.push({x:(a.x+p.x+b.x)/3,y:(a.y+p.y+b.y)/3});});
    return candidates.find(p=>inside(p,points))||{x:points[0].x,y:points[0].y};
  }
  function generateDepth(polygon,zones=[],seed=1,cols=40,rows=28,options={}) {
    const limits=plannerLimits({...(zones.length?{boundaryClearance:5,markerClearance:40,markers:routingMarkers(polygon,zones)}:{}),...options,...(zones.length?{transportAreas:zones.filter(z=>z.kind==="transport").map(z=>z.points)}:{})});
    if(!validPoints(polygon)||zones.some(z=>!validPoints(z.points)||!inPolygon(z.points,polygon)))throw Error("Проверьте границы полигона и расположение зон.");
    if(zones.length&&zoneErrors(zones,polygon).length)throw Error(zoneErrors(zones,polygon).join("\n"));
    let state=seed>>>0;
    const random=()=>{state=(state+0x6D2B79F5)>>>0;let n=Math.imul(state^(state>>>15),1|state);n^=n+Math.imul(n^(n>>>7),61|n);return ((n^(n>>>14))>>>0)/4294967296;};
    const map=validateDepth({...emptyDepth(),cols,rows,cells:Array(cols*rows).fill(0)});
    const hills=Array.from({length:7},()=>({x:random()*W,y:random()*H,r:100+random()*170,h:1+random()*4}));
    const heights=map.cells.map((_,i)=>{
      const p={x:(i%cols+.5)*W/cols,y:(Math.floor(i/cols)+.5)*H/rows};
      const value=.2+.45*hills.reduce((sum,h)=>sum+h.h*Math.exp(-((p.x-h.x)**2+(p.y-h.y)**2)/(2*h.r*h.r)),0);
      return Math.min(limits.maxDepth*.95,Math.round(value*1e6)/1e6);
    });
    // The lower envelope bounds neighbouring gradients. The margin also covers
    // routes touching several cells at a grid corner, including zero-slope maps.
    const heap=new MinHeap((a,b)=>a.h-b.h),grade=limits.maxSlope/8;
    heights.forEach((h,i)=>heap.push({i,h}));
    while(heap.length){const {i,h}=heap.pop();if(h>heights[i]+EPS)continue;const x=i%cols,y=Math.floor(i/cols);
      for(const [dx,dy]of [[-1,0],[1,0],[0,-1],[0,1]]){const nx=x+dx,ny=y+dy,j=ny*cols+nx;if(nx<0||nx>=cols||ny<0||ny>=rows)continue;
        if(heights[j]>h+grade){heights[j]=h+grade;heap.push({i:j,h:heights[j]});}
      }
    }
    // Reserve continuous corridors before placing obstacles. Polygon vertices
    // keep these corridors connected even when a neck is thinner than a cell.
    const reserved=new Set(),working=zones.filter(z=>z.kind!=="transport"),flat={...map,cells:map.cells.slice()};let centres=working.map(zoneCentre);
    function reserve(p){for(const i of cellsAt(p,map)){const x=i%cols,y=Math.floor(i/cols);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx>=0&&nx<cols&&ny>=0&&ny<rows)reserved.add(ny*cols+nx);}}}
    const flatGraph=makeGraph(polygon,flat,limits);
    centres=centres.map((p,i)=>{
      if(!clearanceErrors([p],limits,flatGraph.safety).length)return p;
      const candidates=flatGraph.nodes.filter((q,j)=>flatGraph.allowed[j]&&inside(q,working[i].points)).sort((a,b)=>dist(a,p)-dist(b,p));
      if(!candidates.length)throw Error("Нет безопасного подъезда к зоне «"+working[i].name+"»: проверьте отступы от её арукомаркеров и границ.");
      return candidates[0];
    });centres.forEach(reserve);
    for(const centre of centres.slice(1)){
      if(dist(centres[0],centre)<=.1)continue;
      const path=searchPath(centres[0],centre,polygon,flat,limits,flatGraph);
      if(!path)throw Error("Не удалось обеспечить проезд ко всем зонам с заданными отступами от границы и арукомаркеров. Расширьте узкие участки транспортной зоны или проверьте размеры отступов.");
      for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],ts=segmentCuts(a,b,polygon,map);
        for(const t of [0,...ts.slice(1).flatMap((t,j)=>[(ts[j]+t)/2,t])])reserve({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
      }
    }
    map.cells=heights.map((value,i)=>{const p={x:(i%cols+.5)*W/cols,y:(Math.floor(i/cols)+.5)*H/rows},blocked=random()<.045;
      return reserved.has(i)?value:!inside(p,polygon)||(limits.transportAreas&&!inAreas([p],limits.transportAreas))||blocked?null:value;
    });
    return {...map,source:"synthetic",seed:seed>>>0};
  }
  function plannerLimits(options={}) {
    const limits={maxDepth:options.maxDepth??5,maxSlope:options.maxSlope??2,boundaryClearance:options.boundaryClearance??0,markerClearance:options.markerClearance??0};
    if(!Object.values(limits).every(v=>Number.isFinite(v)&&v>=0&&v<=1000))throw Error("Глубина и перепад для автопостроения должны быть от 0 до 1000.");
    return {...limits,objective:options.objective==="shortest"?"shortest":"terrain",traversable:options.traversable,...(options.transportAreas?{transportAreas:options.transportAreas}:{}),markers:options.markers||[],obstacles:options.obstacles||[]};
  }
  function makeGraph(polygon,depth,limits) {
    limits={...limits,safety:safetyContext(polygon,limits.transportAreas,limits.markers)};
    const nodes=depth.cells.map((value,i)=>({x:(i%depth.cols+.5)*W/depth.cols,y:(Math.floor(i/depth.cols)+.5)*H/depth.rows}));
    const within=p=>inside(p,polygon)&&(!limits.transportAreas||inAreas([p],limits.transportAreas))&&!hitsObstacles([p],limits.obstacles)&&!clearanceErrors([p],limits,limits.safety).length;
    const allowed=nodes.map((p,i)=>depth.cells[i]!==null&&depth.cells[i]<=limits.maxDepth&&within(p));
    const gridCount=nodes.length,edges=new Map(),links=new Map();
    const vertices=[...polygon,...(limits.transportAreas||[]).flat(),...limits.obstacles.flat()],extra=[...vertices];
    for(const p of vertices)if(limits.boundaryClearance>0)for(let k=0;k<8;k++)extra.push({x:p.x+Math.cos(k*Math.PI/4)*limits.boundaryClearance*1.5,y:p.y+Math.sin(k*Math.PI/4)*limits.boundaryClearance*1.5});
    for(const p of limits.markers)if(limits.markerClearance>0)for(let k=0;k<8;k++)extra.push({x:p.x+Math.cos(k*Math.PI/4)*limits.markerClearance*1.1,y:p.y+Math.sin(k*Math.PI/4)*limits.markerClearance*1.1});
    for(const p of extra){if(!within(p)||nodes.slice(gridCount).some(q=>dist(p,q)<=.1))continue;nodes.push({x:p.x,y:p.y});allowed.push(cellsAt(p,depth).every(i=>depth.cells[i]!==null&&depth.cells[i]<=limits.maxDepth));}
    const metric=(a,b)=>segmentMetrics(a,b,polygon,depth,limits);
    function link(i,j){const m=metric(nodes[i],nodes[j]);if(!m)return;for(const [a,b]of [[i,j],[j,i]]){if(!links.has(a))links.set(a,[]);links.get(a).push({i:b,...m});}}
    for(let i=gridCount;i<nodes.length;i++)if(allowed[i]){
      const nearest=nodes.slice(0,gridCount).map((p,j)=>({j,d:dist(nodes[i],p)})).filter(p=>allowed[p.j]).sort((a,b)=>a.d-b.d).slice(0,24);
      for(const {j}of nearest)link(i,j);
      const visibleNodes=nodes.map((p,j)=>({j,d:dist(nodes[i],p)})).filter(p=>p.j>=gridCount&&p.j!==i&&allowed[p.j]).sort((a,b)=>a.d-b.d).slice(0,16);
      for(const {j}of visibleNodes)if(j<i)link(i,j);
    }
    function neighbours(i){
      if(edges.has(i))return edges.get(i);
      const x=i%depth.cols,y=Math.floor(i/depth.cols),result=[...(links.get(i)||[])];
      if(i>=gridCount){edges.set(i,result);return result;}
      for(const [dx,dy]of (limits.objective==="shortest"?[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]:[[-1,0],[1,0],[0,-1],[0,1]])){
        const nx=x+dx,ny=y+dy,j=ny*depth.cols+nx;
        if(nx<0||nx>=depth.cols||ny<0||ny>=depth.rows||!allowed[j])continue;
        if(Math.abs(depth.cells[i]-depth.cells[j])>limits.maxSlope||!inPolygon([nodes[i],nodes[j]],polygon,false)||(limits.transportAreas&&!inAreas([nodes[i],nodes[j]],limits.transportAreas))||hitsObstacles([nodes[i],nodes[j]],limits.obstacles)||clearanceErrors([nodes[i],nodes[j]],limits,limits.safety).length)continue;
        if(limits.traversable&&!limits.traversable(nodes[i],nodes[j]))continue;
        const delta=Math.abs(depth.cells[i]-depth.cells[j]);
        const m=dx&&dy?metric(nodes[i],nodes[j]):{peak:delta,variation:delta,length:dist(nodes[i],nodes[j])};
        if(m)result.push({i:j,...m});
      }
      edges.set(i,result);return result;
    }
    return {nodes,allowed,neighbours,metric,gridCount,safety:limits.safety};
  }
  function segmentMetrics(a,b,polygon,depth,limits){
    if(dist(a,b)<=.1)return {peak:0,variation:0,length:0};
    if(routeErrors({points:[a,b],...limits},polygon,depth,limits.transportAreas,limits.safety).length)return null;
    if(limits.traversable&&!limits.traversable(a,b))return null;
    const ts=segmentCuts(a,b,polygon,depth);let previous,previousValue,peak=0,variation=0;
    for(const t of [0,...ts.slice(1).flatMap((t,j)=>[(ts[j]+t)/2,t])]){
      const values=cellsAt({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t},depth).map(i=>depth.cells[i]);
      const low=Math.min(...values),high=Math.max(...values),value=(low+high)/2;
      peak=Math.max(peak,high-low,...(previous?[Math.abs(high-previous.low),Math.abs(low-previous.high)]:[]));
      if(previousValue!==undefined)variation+=Math.abs(value-previousValue);
      previous={low,high};previousValue=value;
    }
    return {peak,variation,length:dist(a,b)};
  }
  function pathMetrics(points,polygon,depth,options={}){
    const limits=plannerLimits(options),result={peak:0,variation:0,length:0};
    limits.safety=safetyContext(polygon,limits.transportAreas,limits.markers);
    for(let i=1;i<points.length;i++){const m=segmentMetrics(points[i-1],points[i],polygon,depth,limits);if(!m)return null;result.peak=Math.max(result.peak,m.peak);result.variation+=m.variation;result.length+=m.length;}
    return result;
  }
  function shortestPath(start,end,graph,starts,ends){
    const {nodes}=graph,lengths=new Float64Array(nodes.length).fill(Infinity),previous=new Int32Array(nodes.length).fill(-1);
    const heap=new MinHeap((a,b)=>a.f-b.f),closed=new Uint8Array(nodes.length);
    for(const item of starts){lengths[item.i]=item.length;heap.push({i:item.i,d:item.length,f:item.length+dist(nodes[item.i],end)});}
    let goal=-1,best=Infinity;
    while(heap.length){const item=heap.pop(),i=item.i;if(item.f>=best-EPS)break;if(closed[i]||item.d>lengths[i]+EPS)continue;closed[i]=1;
      const finish=ends.get(i);if(finish&&item.d+finish.length<best){best=item.d+finish.length;goal=i;}
      for(const edge of graph.neighbours(i)){const d=item.d+edge.length;if(closed[edge.i]||d>=lengths[edge.i]-EPS)continue;lengths[edge.i]=d;previous[edge.i]=i;heap.push({i:edge.i,d,f:d+dist(nodes[edge.i],end)});}
    }
    if(goal<0)return null;
    const points=[];for(let i=goal;i>=0;i=previous[i])points.push(nodes[i]);points.reverse();points.unshift(start);points.push(end);
    const result=[points[0]];let index=0;
    while(index<points.length-1){let next=points.length-1;while(next>index+1&&!graph.metric(points[index],points[next]))next--;result.push(points[next]);index=next;}
    return result.filter((p,i)=>!i||dist(p,result[i-1])>.1).map(p=>({...p}));
  }
  // Working routes first minimize the steepest transition (bottleneck search). At that bound,
  // minimize cumulative elevation changes, then distance. Smoothing must preserve
  // both terrain objectives; a merely legal straight line is not preferred.
  function searchPath(start,end,polygon,depth,limits,graph) {
    if(dist(start,end)<=.1)return null;
    const {nodes,allowed}=graph;
    function connectors(p){
      const candidates=nodes.map((q,i)=>({i,d:dist(p,q)})).filter(item=>allowed[item.i]);
      const near=candidates.filter(item=>item.i<graph.gridCount).sort((a,b)=>a.d-b.d).slice(0,24);
      return [...near,...candidates.filter(item=>item.i>=graph.gridCount)].map(item=>({i:item.i,...graph.metric(p,nodes[item.i])})).filter(item=>item.peak!==undefined);
    }
    const starts=connectors(start),ends=new Map(connectors(end).map(item=>[item.i,item])),direct=graph.metric(start,end);
    if(limits.objective==="shortest")return direct?[{...start},{...end}]:shortestPath(start,end,graph,starts,ends);
    let ceiling=direct?.peak??Infinity;
    const peaks=new Float64Array(nodes.length).fill(Infinity),bottlenecks=new MinHeap((a,b)=>a.peak-b.peak);
    for(const item of starts){peaks[item.i]=item.peak;bottlenecks.push({i:item.i,peak:item.peak});}
    while(bottlenecks.length){const item=bottlenecks.pop(),i=item.i;if(item.peak>=ceiling)break;if(item.peak>peaks[i])continue;
      if(ends.has(i))ceiling=Math.min(ceiling,Math.max(item.peak,ends.get(i).peak));
      for(const edge of graph.neighbours(i)){const peak=Math.max(item.peak,edge.peak);if(peak>=peaks[edge.i])continue;peaks[edge.i]=peak;bottlenecks.push({i:edge.i,peak});}
    }
    if(!Number.isFinite(ceiling))return null;
    const costs=new Float64Array(nodes.length).fill(Infinity),lengths=new Float64Array(nodes.length).fill(Infinity),previous=new Int32Array(nodes.length).fill(-1),closed=new Uint8Array(nodes.length);
    const heap=new MinHeap((a,b)=>a.v-b.v||a.f-b.f),better=(v,d,oldV,oldD)=>v<oldV-EPS||Math.abs(v-oldV)<=EPS&&d<oldD-EPS;
    for(const item of starts)if(item.peak<=ceiling+EPS&&better(item.variation,item.length,costs[item.i],lengths[item.i])){costs[item.i]=item.variation;lengths[item.i]=item.length;heap.push({i:item.i,v:item.variation,f:item.length+dist(nodes[item.i],end)});}
    let goal=-1,bestV=direct&&direct.peak<=ceiling+EPS?direct.variation:Infinity,bestD=Number.isFinite(bestV)?direct.length:Infinity;
    while(heap.length){
      const item=heap.pop(),i=item.i;if(!better(item.v,item.f,bestV,bestD))break;if(closed[i])continue;closed[i]=1;
      const finish=ends.get(i);
      if(finish&&finish.peak<=ceiling+EPS&&better(costs[i]+finish.variation,lengths[i]+finish.length,bestV,bestD)){bestV=costs[i]+finish.variation;bestD=lengths[i]+finish.length;goal=i;}
      for(const edge of graph.neighbours(i)){
        if(edge.peak>ceiling+EPS)continue;
        const j=edge.i,v=costs[i]+edge.variation,d=lengths[i]+edge.length;
        if(!better(v,d,costs[j],lengths[j]))continue;costs[j]=v;lengths[j]=d;previous[j]=i;heap.push({i:j,v,f:d+dist(nodes[j],end)});
      }
    }
    if(goal<0)return direct&&direct.peak<=ceiling+EPS?[{...start},{...end}]:null;
    const raw=[];for(let i=goal;i>=0;i=previous[i])raw.push(nodes[i]);raw.reverse();raw.unshift(start);raw.push(end);
    const unique=raw.filter((p,i)=>!i||dist(p,raw[i-1])>.1),corners=[];
    for(const p of unique){while(corners.length>1&&Math.abs(cross(corners.at(-2),corners.at(-1),p))<EPS)corners.pop();corners.push(p);}
    const prefix=[0];for(let i=1;i<corners.length;i++){const m=graph.metric(corners[i-1],corners[i]);if(!m)return null;prefix.push(prefix.at(-1)+m.variation);}
    const simplified=[corners[0]];let index=0;
    while(index<corners.length-1){let next=Math.min(corners.length-1,index+100);
      while(next>index+1){const m=graph.metric(corners[index],corners[next]);if(m&&m.peak<=ceiling+EPS&&m.variation<=prefix[next]-prefix[index]+EPS)break;next--;}
      simplified.push(corners[next]);index=next;
    }
    return !routeErrors({points:simplified,...limits},polygon,depth,limits.transportAreas,graph.safety).length?simplified.map(p=>({...p})):null;
  }
  function findPath(start,end,polygon,depth,options={}) {
    return createPathPlanner(polygon,depth,options)(start,end);
  }
  function createPathPlanner(polygon,depth,options={}) {
    validateDepth(depth);const limits=plannerLimits(options);
    const graph=makeGraph(polygon,depth,limits);
    return (start,end)=>searchPath(start,end,polygon,depth,limits,graph);
  }
  function equipmentRole(type){
    const roles={truck:{label:"Самосвал",baseKind:"warehouse",hauls:true},bulldozer:{label:"Бульдозер",baseKind:"warehouse",hauls:false},loader:{label:"Погрузчик",baseKind:"mining",hauls:false},charging_station:{label:"Зарядная станция",baseKind:null,hauls:false,stationary:true},other:{label:"Иное",baseKind:null,hauls:false,manual:true}};
    return roles[type==="excavator"?"bulldozer":type==="robot"?"charging_station":type]||roles.other;
  }
  function vehicleRouteErrors(route,zones,vehicle){
    if(!vehicle)return ["Выберите технику, которой принадлежит маршрут."];
    const role=equipmentRole(vehicle.type);if(role.hauls||route.points.length<2)return [];
    if(role.stationary)return ["Зарядная станция неподвижна: траектории для неё не создаются."];
    if(role.manual)return route.purpose==="haul"?["Перевозки между добычей и складом назначаются только самосвалу."]:[];
    const allowed=zones.filter(z=>z.kind===role.baseKind||z.kind==="charging");
    if(route.purpose==="haul"||![route.points[0],route.points.at(-1)].every(p=>allowed.some(z=>inside(p,z.points))))return [role.label+": разрешены местные перемещения в "+(role.baseKind==="mining"?"зоне добычи":"зоне склада")+" и поездки на зарядку. Между добычей и складом ездит только самосвал."];
    return [];
  }
  function planRoutes(polygon,zones,equipment,depth,options={}) {
    const errors=zoneErrors(zones,polygon);if(errors.length)throw Error(errors.join("\n"));
    validateDepth(depth);const limits=plannerLimits({boundaryClearance:5,markerClearance:40,...options,markers:routingMarkers(polygon,zones),transportAreas:zones.filter(z=>z.kind==="transport").map(z=>z.points)}),graph=makeGraph(polygon,depth,limits);
    if(!equipment.length)throw Error("Добавьте технику в гараж.");
    const jobs=[];
    for(const vehicle of equipment){const role=equipmentRole(vehicle.type);
      for(const from of zones)for(const to of zones){
        if(role.hauls&&from.kind==="mining"&&to.kind==="warehouse")jobs.push({vehicle,from,to,purpose:"haul"});
        if(from.kind===role.baseKind&&to.kind==="charging")jobs.push({vehicle,from,to,purpose:"charging"});
      }
    }
    if(!jobs.length)throw Error("Для выбранной техники нужны её рабочая зона и зарядка внутри транспортной зоны.");
    if(jobs.length>30)throw Error("Получается больше 30 траекторий. Выберите одну единицу техники для автопостроения.");
    function anchor(zone){
      const centre=zoneCentre(zone);
      if(!clearanceErrors([centre],limits,graph.safety).length&&cellsAt(centre,depth).every(i=>depth.cells[i]!==null&&depth.cells[i]<=limits.maxDepth)&&graph.nodes.some((p,i)=>graph.allowed[i]&&graph.metric(centre,p)))return centre;
      const candidates=graph.nodes.filter((p,i)=>graph.allowed[i]&&inside(p,zone.points)).sort((a,b)=>dist(a,centre)-dist(b,centre));
      if(candidates.length)return candidates[0];
      return [centre,...zone.points].find(p=>inside(p,zone.points)&&graph.nodes.some((q,i)=>graph.allowed[i]&&graph.metric(p,q)));
    }
    const anchors=new Map(zones.map(zone=>[zone.id,anchor(zone)])),routes=[],unreachable=[],paths=new Map();
    for(const {from,to,vehicle,purpose}of jobs){
      const a=anchors.get(from.id);let b=anchors.get(to.id);
      // Overlapping zones may have the same centre. Reach a nearby point in the
      // destination rather than treating an already adjacent zone as isolated.
      if(a&&b&&dist(a,b)<=.1)b=to.points.map(p=>{const t=Math.min(.5,1/Math.max(1,dist(p,b)));return {x:b.x+(p.x-b.x)*t,y:b.y+(p.y-b.y)*t};}).find(p=>dist(a,p)>.1&&inside(p,to.points)&&graph.metric(a,p));
      const key=from.id+":"+to.id;if(!paths.has(key))paths.set(key,a&&b?searchPath(a,b,polygon,depth,limits,graph):null);const path=paths.get(key);
      if(!path){unreachable.push(vehicle.name+": "+from.name+" ↔ "+to.name);continue;}
      routes.push({name:Array.from(vehicle.name+": "+from.name+" ↔ "+to.name).slice(0,100).join(""),equipmentId:vehicle.id,fromZoneId:from.id,toZoneId:to.id,purpose,bidirectional:true,points:path.map(p=>({...p})),maxDepth:limits.maxDepth,maxSlope:limits.maxSlope,boundaryClearance:limits.boundaryClearance,markerClearance:limits.markerClearance});
    }
    return {routes,unreachable};
  }
  global.SetupGeometry=Object.freeze({W,H,inside,nearSegment,validPoints,inPolygon,inAreas,zoneErrors,emptyDepth,validateDepth,routeErrors,generateDepth,findPath,createPathPlanner,planRoutes,pathMetrics,routingMarkers,safetyContext,clearanceErrors,hitsObstacles,equipmentRole,vehicleRouteErrors});
})(globalThis);
