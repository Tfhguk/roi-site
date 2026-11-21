(function(root){
 'use strict';
 const finitePoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1000&&p.y>=0&&p.y<=700;
 function key(source,route,config){
  const text=JSON.stringify(['traction-v3-footprint',source.id||'demo',route.equipmentId,source.boundary,source.zones,source.depth,config.terrainSeed||0,...['metresPerUnit','terrainReliefM','maxGradeDeg','emergencyGradeDeg','massKg','payloadKg','mu','torqueLimit','trackWidth','k'].map(k=>config[k])]);
  let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return 'v1-'+(hash>>>0).toString(16);
 }
 function create(id,saved){
  const memory={version:1,key:id,routes:[],hazards:[],revision:0};
  if(saved?.version===1&&saved.key===id){memory.routes=(Array.isArray(saved.routes)?saved.routes:[]).filter(r=>Array.isArray(r.points)&&r.points.length>=2&&r.points.length<=200&&r.points.every(finitePoint)).slice(-20).map(r=>({points:structuredClone(r.points),runs:Math.max(1,Math.min(10000,Number(r.runs)||1)),loaded:!!r.loaded}));memory.hazards=(Array.isArray(saved.hazards)?saved.hazards:[]).filter(p=>Array.isArray(p)&&p.length===4&&p.every(finitePoint)).slice(-20).map(p=>structuredClone(p));}
  function success(points,loaded){
   if(points.length<2||points.length>200||!points.every(finitePoint))return;
   const same=memory.routes.find(r=>r.loaded===loaded&&Math.hypot(r.points[0].x-points[0].x,r.points[0].y-points[0].y)<10&&Math.hypot(r.points.at(-1).x-points.at(-1).x,r.points.at(-1).y-points.at(-1).y)<10);
   if(same){same.runs++;same.points=structuredClone(points);}else{memory.routes.push({points:structuredClone(points),runs:1,loaded});if(memory.routes.length>20)memory.routes.shift();}memory.revision++;
  }
  function hazard(points){if(!points.every(finitePoint))return;if(memory.hazards.some(p=>Math.hypot(p[0].x-points[0].x,p[0].y-points[0].y)<5))return;memory.hazards.push(structuredClone(points));if(memory.hazards.length>20)memory.hazards.shift();memory.revision++;}
  function candidates(start,end,scale){return memory.routes.flatMap(r=>[r.points,[...r.points].reverse()]).filter(p=>Math.hypot(p[0].x-start.x,p[0].y-start.y)*scale<.3&&Math.hypot(p.at(-1).x-end.x,p.at(-1).y-end.y)*scale<.3).map(p=>[start,...p,end].filter((v,i,a)=>!i||Math.hypot(v.x-a[i-1].x,v.y-a[i-1].y)>.1)).filter(p=>p.length<=200);}
  return {memory,success,hazard,candidates,export:()=>structuredClone(memory),summary:()=>({routes:memory.routes.length,hazards:memory.hazards.length,runs:memory.routes.reduce((n,r)=>n+r.runs,0),key:id,revision:memory.revision})};
 }
 const api={key,create};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.TruckLearning=api;
})(globalThis);
