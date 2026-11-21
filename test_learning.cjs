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
const mixed=source(0);mixed.zones.push(box('far-flat','charging',800,90,120,140));mixed.elevation.cells=mixed.elevation.cells.map((v,i)=>Math.max(0,Math.floor(i/101)*.1-4.5)*Math.tan(12*Math.PI/180));mixed.depth.cells=mixed.depth.cells.map((v,i)=>MetricTerrain.sample(mixed.elevation,(i%20+.5)*50,(Math.floor(i/20)+.5)*50));const mixedNav=N.create(mixed,config,route);assert.equal(mixedNav.chargeRoute({x:200,y:400},.8).station.id,'far-flat','A reachable gentle charging approach takes priority over a closer steep fallback');
assert.equal(mixedNav.chargeRoute(mixedNav.stations[0].dock,.8).station.id,mixedNav.stations[0].id,'Already being at a dock is a valid zero-distance charging approach');
console.log('PASS learning: prefer gentle paths, attempt steep or low-traction paths only as fallback, chassis clearance, persistent paths, invalidation and map isolation');
