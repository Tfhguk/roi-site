(function(root){
 'use strict';
 function prepare(input,work,settings){
  const G=root.SetupGeometry,T=root.MetricTerrain,N=root.TruckNavigation;
  const source=structuredClone(input),config={terrainReliefM:.75,maxGradeDeg:18,...settings};let route=structuredClone(work);
  source.elevation=T.generate(source,config.metresPerUnit,config.terrainReliefM);
  source.depth={...source.depth,unit:'m',cells:source.depth.cells.map((v,i)=>v===null?null:T.sample(source.elevation,(i%source.depth.cols+.5)*1000/source.depth.cols,(Math.floor(i/source.depth.cols)+.5)*700/source.depth.rows))};
  const cw=1000/source.depth.cols,ch=700/source.depth.rows,margin=.12/config.metresPerUnit,rectangles=[];
  for(let row=0;row<source.depth.rows;row++)for(let col=0;col<source.depth.cols;col++)if(source.depth.cells[row*source.depth.cols+col]===null){
   const first=col;while(col+1<source.depth.cols&&source.depth.cells[row*source.depth.cols+col+1]===null)col++;
   const previous=rectangles.find(r=>r.left===first&&r.right===col+1&&r.bottom===row);
   if(previous)previous.bottom=row+1;else rectangles.push({left:first,right:col+1,top:row,bottom:row+1});
  }
  source.routingObstacles=rectangles.map(r=>[{x:r.left*cw-margin,y:r.top*ch-margin},{x:r.right*cw+margin,y:r.top*ch-margin},{x:r.right*cw+margin,y:r.bottom*ch+margin},{x:r.left*cw-margin,y:r.bottom*ch+margin}]);
  const grade=config.maxGradeDeg;if(!Number.isFinite(grade)||grade<2||grade>25)throw Error('Допустимый уклон: от 2 до 25°');
  route={...route,maxDepth:1000,maxSlope:Math.tan(grade*Math.PI/180)*config.metresPerUnit*Math.min(cw,ch)};
  const options={...route,obstacles:source.routingObstacles,transportAreas:source.zones.filter(z=>z.kind==='transport').map(z=>z.points),markers:G.routingMarkers(source.boundary,source.zones)};
  const points=G.findPath(route.points[0],route.points.at(-1),source.boundary,source.depth,options);
  if(!points)throw Error('Нет безопасного пути по рельефу. Уменьшите перепад или измените зоны.');
  route.points=points;source.routes=[...source.routes.filter(r=>r.id!==route.id),route];
  const navigation=N.create(source,config,route);
  if(!navigation.stations.length)throw Error('Зарядная станция не помещается в зоне с безопасным подъездом.');
  const errors=navigation.validate(points);if(errors.length)throw Error(errors.join('; '));
  return {source,route,config,navigation,stations:navigation.stations};
 }
 const api={prepare};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MujocoPlanning=api;
})(globalThis);
