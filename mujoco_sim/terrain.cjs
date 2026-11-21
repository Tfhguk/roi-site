// Separate metric elevations: never reinterpret the legacy conditional depths.
(function(root){
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
function generate(source,scale,relief=.75,seed=0){
 if(!Number.isFinite(relief)||relief<0||relief>1.5)throw Error('Перепад рельефа должен быть от 0 до 1,5 м');
 if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw Error('Некорректный seed рельефа');
 const G=root.SetupGeometry,cols=101,rows=71;
 // Keep a fixed shape while scaling: every height difference and grade grows
 // proportionally with the slider. Only regeneration changes the landscape.
 let state=seed;const random=()=>{state=(state+0x6D2B79F5)|0;let n=state;n=Math.imul(n^(n>>>15),n|1);n^=n+Math.imul(n^(n>>>7),n|61);return ((n^(n>>>14))>>>0)/4294967296;};
 const angle=random()*Math.PI*2,phase=random()*Math.PI*2,phase2=random()*Math.PI*2,frequency=1.5+random()*1.5;
 const base=(x,y)=>{
  if(seed===0)return relief*(.5+.33*Math.tanh((x/1000-.5)*4)+.12*Math.sin(x/1000*Math.PI)*Math.cos(y/700*Math.PI));
  const u=(x/1000-.5)*Math.cos(angle)+(y/700-.5)*Math.sin(angle),v=-(x/1000-.5)*Math.sin(angle)+(y/700-.5)*Math.cos(angle);
  return relief*(.5+.25*Math.tanh(u*4)+.15*Math.sin(u*Math.PI*frequency+phase)*Math.cos(v*Math.PI*1.5+phase2)+.08*Math.sin(v*Math.PI*3+phase));
 };
 const pads=source.zones.filter(z=>z.kind!=='transport').map(z=>{const centre=z.points.reduce((a,p)=>({x:a.x+p.x/z.points.length,y:a.y+p.y/z.points.length}),{x:0,y:0});return {points:z.points,height:base(centre.x,centre.y)};});
 const cells=[];
 for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
  const p={x:c*1000/(cols-1),y:r*700/(rows-1)};let height=base(p.x,p.y);
  for(const pad of pads){const d=G.inside(p,pad.points)?0:Math.min(...pad.points.map((a,i)=>G.nearSegment(p,a,pad.points[(i+1)%pad.points.length]).distance))*scale;const w=1-smooth((d-.08)/.7);height=height*(1-w)+pad.height*w;}
  cells.push(height);
 }
 return {version:1,unit:'m',width:1000,height:700,cols,rows,cells,source:'synthetic',reliefM:relief,seed};
}
function sample(map,x,y){
 const u=Math.max(0,Math.min(map.cols-1,x/1000*(map.cols-1))),v=Math.max(0,Math.min(map.rows-1,y/700*(map.rows-1))),c=Math.min(map.cols-2,Math.floor(u)),r=Math.min(map.rows-2,Math.floor(v)),a=u-c,b=v-r;
 return (1-b)*((1-a)*map.cells[r*map.cols+c]+a*map.cells[r*map.cols+c+1])+b*((1-a)*map.cells[(r+1)*map.cols+c]+a*map.cells[(r+1)*map.cols+c+1]);
}
const api={generate,sample};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MetricTerrain=api;
})(globalThis);
