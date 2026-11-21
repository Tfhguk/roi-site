// Separate metric elevations: never reinterpret the legacy conditional depths.
(function(root){
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
function generate(source,scale,relief=.75){
 if(!Number.isFinite(relief)||relief<0||relief>1.5)throw Error('Перепад рельефа должен быть от 0 до 1,5 м');
 const G=root.SetupGeometry,cols=101,rows=71;
 const base=(x,y)=>relief*(.5+.33*Math.tanh((x/1000-.5)*4)+.12*Math.sin(x/1000*Math.PI)*Math.cos(y/700*Math.PI));
 const pads=source.zones.filter(z=>z.kind!=='transport').map(z=>{const centre=z.points.reduce((a,p)=>({x:a.x+p.x/z.points.length,y:a.y+p.y/z.points.length}),{x:0,y:0});return {points:z.points,height:base(centre.x,centre.y)};});
 const cells=[];
 for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
  const p={x:c*1000/(cols-1),y:r*700/(rows-1)};let height=base(p.x,p.y);
  for(const pad of pads){const d=G.inside(p,pad.points)?0:Math.min(...pad.points.map((a,i)=>G.nearSegment(p,a,pad.points[(i+1)%pad.points.length]).distance))*scale;const w=1-smooth((d-.08)/.7);height=height*(1-w)+pad.height*w;}
  cells.push(height);
 }
 return {version:1,unit:'m',width:1000,height:700,cols,rows,cells,source:'synthetic',reliefM:relief};
}
function sample(map,x,y){
 const u=Math.max(0,Math.min(map.cols-1,x/1000*(map.cols-1))),v=Math.max(0,Math.min(map.rows-1,y/700*(map.rows-1))),c=Math.min(map.cols-2,Math.floor(u)),r=Math.min(map.rows-2,Math.floor(v)),a=u-c,b=v-r;
 return (1-b)*((1-a)*map.cells[r*map.cols+c]+a*map.cells[r*map.cols+c+1])+b*((1-a)*map.cells[(r+1)*map.cols+c]+a*map.cells[(r+1)*map.cols+c+1]);
}
const api={generate,sample};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MetricTerrain=api;
})(globalThis);
