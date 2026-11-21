const assert=require('node:assert/strict');
require('./polygon-geometry.js');require('./setup-geometry.js');global.MetricTerrain=require('./mujoco_sim/terrain.cjs');
{
 const input={zones:[]},make=(relief,seed)=>MetricTerrain.generate(input,.01,relief,seed),flat=make(0,123),low=make(.3,123),high=make(1.5,123);
 assert(flat.cells.every(h=>h===0),'Zero extremity is a flat surface');
 assert.deepEqual(low,make(.3,123),'A seed reproduces the same terrain');
 assert.notDeepEqual(low.cells,make(.3,124).cells,'Regeneration changes the landscape');
 assert(high.cells.every((h,i)=>Number.isFinite(h)&&h>=0&&h<=1.5&&Math.abs(h-low.cells[i]*5)<1e-12),'Increasing extremity scales all heights proportionally');
 const slope=map=>Math.max(...map.cells.slice(1).map((h,i)=>Math.abs(h-map.cells[i])));
 assert(slope(high)>slope(low)*4.99,'Slopes become steeper with extremity');
 const pad={kind:'charging',points:[{x:100,y:100},{x:300,y:100},{x:300,y:300},{x:100,y:300}]},padded=MetricTerrain.generate({zones:[pad]},.01,1.5,123);
 assert(Math.abs(MetricTerrain.sample(padded,150,150)-MetricTerrain.sample(padded,250,250))<1e-12,'Working zones remain level');
 assert.throws(()=>make(.75,-1));assert.throws(()=>make(2,123));
 console.log('PASS seeded terrain: repeatability, regeneration, flat surface, proportional heights and grades, level pads');
}
const N=require('./truck-navigation.js'),L=require('./truck-learning.js'),{defaults}=require('./truck-model.js'),G=global.SetupGeometry;
const box=(id,kind,x,y,w,h)=>({id,name:id,kind,points:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]});
function field(degrees){const slope=Math.tan(degrees*Math.PI/180);return {unit:'m',cols:101,rows:71,cells:Array.from({length:7171},(_,i)=>(i%101)*.1*slope)};}
function source(grade){const e=field(grade),depth=G.emptyDepth();depth.cells=depth.cells.map((_,i)=>MetricTerrain.sample(e,(i%depth.cols+.5)*1000/depth.cols,(Math.floor(i/depth.cols)+.5)*700/depth.rows));return {boundary:box('p',null,20,20,960,660).points,zones:[box('t','transport',45,45,910,610),box('c','charging',100,470,160,140)],elevation:e,depth,routes:[]};}
const config={...defaults,maxGradeDeg:6,emergencyGradeDeg:18,mu:.8},route={id:'test',equipmentId:'truck',points:[{x:200,y:300},{x:800,y:300}],maxDepth:1000,maxSlope:2,boundaryClearance:5,markerClearance:0};
const hill=source(12),nav=N.create(hill,config,route),path=nav.plan(route.points[0],route.points[1],'shortest');assert(path,'If the entire map is steep, use a physically admissible fallback');assert(nav.analysis.steepFallback);assert(nav.analysis.maxGradeDeg>11.8&&nav.analysis.maxGradeDeg<12.2);assert(nav.analysis.minTractionReserve>.1);assert.deepEqual(nav.validate(path),[]);
const tooSteep=N.create(source(32),config,route);assert(tooSteep.plan(route.points[0],route.points[1]),'When no gentler route exists, attempt a slope beyond the normal threshold');assert(tooSteep.analysis.attemptedFallback);assert(tooSteep.analysis.maxGradeDeg>31.8);assert(tooSteep.analysis.warnings.includes('Большой уклон'));
const weak=N.create(hill,{...config,mu:.1},route);assert(weak.plan(route.points[0],route.points[1]),'An estimated traction deficit allows a physical attempt instead of refusing to start');assert(weak.analysis.attemptedFallback);assert(weak.analysis.minTractionReserve<0);
const flat=source(0),id=L.key(flat,route,config),memory=L.create(id);memory.success([{x:200,y:300},{x:500,y:300},{x:800,y:300}],true);const restored=L.create(id,JSON.parse(JSON.stringify(memory.export())));assert.equal(restored.summary().routes,1);
const familiar=N.create(flat,config,route,restored);assert(familiar.plan(route.points[0],route.points[1]));assert(familiar.analysis.remembered,'Reuse a previously successful path after revalidation');
const hazard=box('blocked',null,480,270,40,60).points;familiar.avoid(hazard);assert.equal(restored.summary().hazards,1);const around=familiar.plan(route.points[0],route.points[1]);assert(around&&around.length>2,'An unsuccessful approach invalidates the saved path and forces an alternative');assert(!G.hitsObstacles(around,[hazard]));assert.equal(L.create(id+'-changed',restored.export()).summary().routes,0,'Never transfer experience to another map/configuration');
const narrow={...flat,zones:[box('narrow','transport',100,295,800,10)]},lane=N.create(narrow,config,route);assert.equal(lane.plan(route.points[0],route.points[1]),null,'A centerline cannot make a lane wide enough for the chassis');
const mixed=source(0);mixed.zones.push(box('far-flat','charging',800,90,120,140));mixed.elevation.cells=mixed.elevation.cells.map((v,i)=>Math.max(0,Math.floor(i/101)*.1-4.5)*Math.tan(12*Math.PI/180));mixed.depth.cells=mixed.depth.cells.map((v,i)=>MetricTerrain.sample(mixed.elevation,(i%20+.5)*50,(Math.floor(i/20)+.5)*50));const mixedNav=N.create(mixed,config,route);assert.equal(mixedNav.chargeRoute({x:200,y:400},.8).station.id,'c','A nearby station over a passable ordinary slope beats a much farther flat station');
assert.equal(mixedNav.chargeRoute(mixedNav.stations[0].dock,.8).station.id,mixedNav.stations[0].id,'Already being at a dock is a valid zero-distance charging approach');
{
 const ripple=source(0),start=route.points[0],end=route.points[1];
 const surface=(map,amplitude,width)=>{map.elevation.cells=map.elevation.cells.map((_,i)=>amplitude*Math.exp(-(((i%101*.1-5)/width)**2+((Math.floor(i/101)*.1-3)/1.1)**2)));map.depth.cells=map.depth.cells.map((v,i)=>MetricTerrain.sample(map.elevation,(i%20+.5)*50,(Math.floor(i/20)+.5)*50));};
 surface(ripple,.004,.3);const practical=N.create(ripple,{...config,maxGradeDeg:18,emergencyGradeDeg:25},route),direct=practical.plan(start,end);
 assert(direct&&direct.length===2,'A 4 mm ripple must not trigger a long detour or grid zigzags');assert(Math.abs(practical.estimate(direct).length-6)<1e-8);assert(practical.analysis.passable);
 surface(ripple,.8,.3);const steep=N.create(ripple,{...config,maxGradeDeg:18,emergencyGradeDeg:25},route),around=steep.plan(start,end);
 assert(steep.analyze([start,end]).maxGradeDeg>25,'The hill really is too steep for the ordinary direct approach');assert(around&&around.length>2,'Still avoid a genuinely steep hill when there is an ordinary detour');assert(steep.analysis.maxGradeDeg<=25.05);assert(!steep.analysis.attemptedFallback);assert.deepEqual(steep.validate(around),[]);
 const travelled=L.create(L.key(ripple,route,config));surface(ripple,.004,.3);travelled.success([{x:200,y:300},{x:200,y:160},{x:800,y:160},{x:800,y:300}],true);const recalled=N.create(ripple,config,route,travelled),better=recalled.plan(start,end);
 assert(better&&recalled.estimate(better).length<=6.001,'Previously successful detours cannot override a cheaper direct route');
 const risk=structuredClone(mixed);risk.elevation.cells=risk.elevation.cells.map((_,i)=>Math.max(0,Math.floor(i/101)*.1-4.5)*Math.tan(32*Math.PI/180));risk.depth.cells=risk.depth.cells.map((v,i)=>MetricTerrain.sample(risk.elevation,(i%20+.5)*50,(Math.floor(i/20)+.5)*50));assert.equal(N.create(risk,config,route).chargeRoute({x:200,y:400},.8).station.id,'far-flat','A dangerous charging approach is still a last resort');
 const blocked=G.emptyDepth();blocked.cells[6*20+10]=null;const detour=G.findPath({x:225,y:325},{x:775,y:325},flat.boundary,blocked,{objective:'efficient',edgeCost:(a,b,m)=>m.length});assert(detour&&detour.length>2);assert.deepEqual(G.routeErrors({points:detour,maxDepth:1000,maxSlope:1000},flat.boundary,blocked),[],'Efficient search can start at an exact grid node and must not cross an obstacle');
 console.log('PASS efficient routing: tiny ripples take a direct path, steep hills get real detours, old route memory cannot force detours, closest ordinary charger, dangerous slope fallback and obstacle containment');
}
console.log('PASS learning: prefer gentle paths, attempt steep or low-traction paths only as fallback, chassis clearance, persistent paths, invalidation and map isolation');
