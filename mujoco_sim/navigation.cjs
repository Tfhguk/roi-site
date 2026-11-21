// JSON-lines bridge: reuse the site's depth and clearance planner without a server.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=path.join(__dirname,'..');
require(path.join(root,'polygon-geometry.js'));
require(path.join(root,'setup-geometry.js'));
const G=global.SetupGeometry,N=require(path.join(root,'truck-navigation.js'));
const Truck=require(path.join(root,'truck-model.js')),defaults=Truck.defaults;
const Terrain=require('./terrain.cjs');
let source,nav,route,config;
const box=(id,kind,x,y,w,h)=>({id,name:id,kind,points:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]});
function initialize(message){
  config={...defaults,...message.config};
  config=new Truck.Simulation({points:[{x:0,y:0},{x:1,y:1}]},config).config;
  if(message.source){
    source=message.source;route=message.route;
    G.validateDepth(source.depth);
    if(!G.inside(route?.points?.[0],source.boundary))throw Error('Route spawn must be inside polygon');
  }else if(message.workspace){
    const w=JSON.parse(fs.readFileSync(message.workspace,'utf8'));
    if(w.version!==1||!w.polygon?.geometry?.points)throw Error('Expected roi-workspace.json exported from workspace settings');
    source={boundary:w.polygon.geometry.points,zones:w.zones,depth:G.validateDepth(w.depth),routes:w.routes||[]};
    const truck=(w.equipment||[]).find(e=>e.type==='truck');
    if(!truck)throw Error('Workspace must contain a truck');
    route=source.routes.find(r=>r.equipmentId===truck.id&&r.purpose==='haul');
    if(!route){const plan=G.planRoutes(source.boundary,source.zones,[truck],source.depth,{boundaryClearance:5,markerClearance:40});route=plan.routes.find(r=>r.purpose==='haul');}
    if(!route)throw Error('No reachable mining-to-warehouse route for truck');
  }else{
    source={boundary:box('polygon',null,20,20,960,660).points,zones:[box('transport','transport',45,45,910,610),box('mining','mining',90,90,160,150),box('warehouse','warehouse',700,440,170,150),box('charging','charging',90,460,160,140)],depth:null,routes:[]};
    source.depth=G.generateDepth(source.boundary,source.zones,42,40,28,{boundaryClearance:5,markerClearance:40});
    route=G.planRoutes(source.boundary,source.zones,[{id:'truck',name:'Test truck',type:'truck'}],source.depth,{boundaryClearance:5,markerClearance:40}).routes.find(r=>r.purpose==='haul');
  }
  if(!route)throw Error('Could not generate working route');
  source.elevation=Terrain.generate(source,config.metresPerUnit,config.terrainReliefM??.3);
  // Keep old null cells as obstacles; plan using metres from the metric field.
  source.depth={...source.depth,unit:'m',cells:source.depth.cells.map((v,i)=>v===null?null:Terrain.sample(source.elevation,(i%source.depth.cols+.5)*1000/source.depth.cols,(Math.floor(i/source.depth.cols)+.5)*700/source.depth.rows))};
  const cw=1000/source.depth.cols,ch=700/source.depth.rows,margin=.12/config.metresPerUnit;
  const rectangles=[];
  for(let row=0;row<source.depth.rows;row++)for(let col=0;col<source.depth.cols;col++)if(source.depth.cells[row*source.depth.cols+col]===null){
    const first=col;while(col+1<source.depth.cols&&source.depth.cells[row*source.depth.cols+col+1]===null)col++;
    const previous=rectangles.find(r=>r.left===first&&r.right===col+1&&r.bottom===row);
    if(previous)previous.bottom=row+1;else rectangles.push({left:first,right:col+1,top:row,bottom:row+1});
  }
  source.routingObstacles=rectangles.map(r=>[{x:r.left*cw-margin,y:r.top*ch-margin},{x:r.right*cw+margin,y:r.top*ch-margin},{x:r.right*cw+margin,y:r.bottom*ch+margin},{x:r.left*cw-margin,y:r.bottom*ch+margin}]);
  const grade=config.maxGradeDeg??10;
  if(!Number.isFinite(grade)||grade<2||grade>20)throw Error('Maximum grade must be between 2 and 20 degrees');
  route={...route,maxDepth:1000,maxSlope:Math.tan(grade*Math.PI/180)*config.metresPerUnit*Math.min(1000/source.depth.cols,700/source.depth.rows)};
  const planned=G.findPath(route.points[0],route.points.at(-1),source.boundary,source.depth,{...route,obstacles:source.routingObstacles,transportAreas:source.zones.filter(z=>z.kind==='transport').map(z=>z.points),markers:G.routingMarkers(source.boundary,source.zones)});
  if(!planned)throw Error('No terrain-safe path for the selected maximum grade');
  route.points=planned;
  source.routes=[...source.routes.filter(r=>r.id!==route.id),route];
  nav=N.create(source,config,route);
  if(!nav.stations.length)throw Error('Charging station does not fit in charging zone');
  if(nav.validate(route.points).length)throw Error(nav.validate(route.points).join('; '));
  return {source,route,stations:nav.stations,config};
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  try{const m=JSON.parse(line);let result;
    if(m.op==='init')result=initialize(m);
    else if(m.op==='charge')result=nav.chargeRoute(m.start,m.soc);
    else if(m.op==='work')result=nav.workRoute(m.start,m.kind);
    else throw Error('Unknown operation');
    console.log(JSON.stringify({ok:true,result}));
  }catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}
});
