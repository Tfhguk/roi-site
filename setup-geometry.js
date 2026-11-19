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
    return {version:1,width:W,height:H,cols:map.cols,rows:map.rows,unit:"условные единицы",cells:map.cells.slice()};
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
  global.SetupGeometry=Object.freeze({W,H,inside,nearSegment,validPoints,inPolygon,emptyDepth,validateDepth,routeErrors});
})(globalThis);
