(function(root){
 'use strict';
 function build(p){
  const c=p.config,s=c.metresPerUnit,e=p.source.elevation,scale=c.metresPerUnit,heights=e.cells,lo=Math.min(...heights),hi=Math.max(...heights);
  const height=(x,y)=>root.MetricTerrain.sample(e,x/scale,y/scale);
  const pos=p.route.points[0],spawn=[pos.x*s,pos.y*s];let xml='';
  const tag=(name,attrs,body='')=>'<'+name+' '+Object.entries(attrs).map(([k,v])=>k+'="'+v+'"').join(' ')+(body?'>'+body+'</'+name+'>':'/>');
  const geom=(attrs)=>tag('geom',attrs);
  const joint=(name,type,axis,more={})=>tag('joint',{name,type,axis,...more});
  let truck=joint('x','slide','1 0 0')+joint('y','slide','0 1 0')+joint('z','slide','0 0 1',{damping:'.1'})+joint('yaw','hinge','0 0 1',{damping:'.002'})+joint('pitch','hinge','0 1 0',{damping:'.02'})+joint('roll','hinge','1 0 0',{damping:'.02'});
  truck+=geom({name:'chassis',type:'box',size:'.085 .043 .019',mass:c.massKg*.65,rgba:'.95 .65 .07 1'});
  truck+=geom({type:'box',pos:'.056 0 .034',size:'.027 .037 .023',mass:'.08',rgba:'.12 .3 .45 1'});
  truck+=geom({type:'box',pos:'.083 0 .035',size:'.002 .03 .015',mass:'.005',rgba:'.55 .85 1 1'});
  for(const side of [-1,1])for(const x of [-.058,0,.058]){
   const at=`${x} ${side*c.trackWidth/2} -.022`;
   truck+=geom({type:'sphere',pos:at,size:'.02',mass:'.001',rgba:'0 0 0 0',friction:'.002 .001 .0001'});
   truck+=tag('body',{pos:at},joint('wheel_'+side+'_'+x,'hinge','0 1 0',{damping:'.001'})+geom({type:'cylinder',size:'.02 .009',quat:'.70710678 .70710678 0 0',mass:'.01',rgba:'.06 .08 .1 1',contype:0,conaffinity:0}));
  }
  let bed=joint('tip','hinge','0 -1 0',{range:'0 1.05',damping:'.05'})+geom({type:'box',pos:'.043 0 .003',size:'.06 .04 .004',mass:'.12',rgba:'.95 .48 .06 1'});
  for(const side of [-1,1])bed+=geom({type:'box',pos:`.043 ${side*.041} .018`,size:'.06 .003 .018',mass:'.015',rgba:'1 .65 .08 1'});
  bed+=geom({name:'cargo',type:'ellipsoid',pos:'.04 0 .022',size:'.048 .032 .015',mass:'.001',rgba:'.38 .25 .12 0',contype:0,conaffinity:0});
  truck+=tag('body',{name:'bed',pos:'-.068 0 .027'},bed);
  xml+=tag('body',{name:'truck',pos:`${spawn[0]} ${spawn[1]} ${height(...spawn)+.045}`},truck);
  let actuators=tag('position',{name:'tip_servo',joint:'tip',kp:3,kv:'.2',forcerange:'-1 1'});
  for(const axis of ['pitch','roll'])actuators+=tag('position',{name:axis+'_support',joint:axis,kp:5,kv:'.4',forcerange:'-.5 .5'});
  p.stations.forEach((station,i)=>{
   const x=station.centre.x*s,y=station.centre.y*s;
   let wrist=joint('wrist_'+i,'hinge','1 0 0',{range:'-.8 .8',damping:'.02'})+geom({type:'capsule',fromto:'0 -.025 0 0 .025 0',size:'.006',mass:'.02',rgba:'.9 .85 .4 1',contype:0,conaffinity:0});
   let lift=joint('arm_z_'+i,'slide','0 0 1',{range:'.02 .16',damping:2})+geom({type:'box',size:'.018 .025 .012',mass:'.1',rgba:'.9 .7 .15 1',contype:0,conaffinity:0})+tag('body',{gravcomp:1},wrist);
   let arm=joint('arm_x_'+i,'slide','1 0 0',{range:'0 .24',damping:2})+geom({type:'box',pos:'0 0 .11',size:'.012 .016 .11',mass:'.15',rgba:'.6 .65 .7 1',contype:0,conaffinity:0})+tag('body',{gravcomp:1},lift);
   xml+=tag('body',{pos:`${x} ${y} ${height(x,y)}`,euler:`0 0 ${station.heading}`},geom({type:'box',pos:'0 0 .035',size:`${c.stationLengthM/2} ${c.stationWidthM/2} .035`,rgba:'.18 .3 .42 1'})+geom({type:'box',pos:'-.08 0 .12',size:'.03 .06 .08',rgba:'.2 .75 .45 1'})+tag('body',{pos:`${c.stationLengthM/2} 0 0`},arm));
   for(const [axis,kp,kv]of [['arm_x',80,10],['arm_z',150,12],['wrist',3,.2]])actuators+=tag('position',{name:axis+'_'+i,joint:axis+'_'+i,kp,kv,forcerange:'-8 8'});
  });
  const depth=p.source.depth,cw=1000*s/depth.cols,ch=700*s/depth.rows;
  depth.cells.forEach((v,i)=>{if(v!==null)return;const x=(i%depth.cols+.5)*cw,y=(Math.floor(i/depth.cols)+.5)*ch;xml+=geom({type:'box',pos:`${x} ${y} ${height(x,y)+.08}`,size:`${cw/2} ${ch/2} .08`,rgba:'.7 .12 .15 1'});});
  const rows=[];for(let r=e.rows-1;r>=0;r--)rows.push(...heights.slice(r*e.cols,(r+1)*e.cols));
  const field=tag('hfield',{name:'elevation',nrow:e.rows,ncol:e.cols,size:`${500*s} ${350*s} ${Math.max(.001,hi-lo)} .1`,elevation:rows.join(' ')});
  const ground=geom({name:'terrain',type:'hfield',hfield:'elevation',pos:`${500*s} ${350*s} ${lo}`,rgba:'.25 .5 .3 1',friction:'.002 .001 .0001'});
  return {xml:'<mujoco><compiler angle="radian" autolimits="true"/><option timestep=".004" integrator="implicitfast"/><default><geom friction=".7 .005 .0001" solref=".012 1"/></default><asset>'+field+'</asset><worldbody>'+ground+xml+'</worldbody><actuator>'+actuators+'</actuator></mujoco>',spawn,height,minimum:lo,maximum:hi};
 }
 root.MujocoScene={build};if(typeof module!=='undefined'&&module.exports)module.exports=root.MujocoScene;
})(globalThis);
