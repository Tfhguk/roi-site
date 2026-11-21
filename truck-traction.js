/* Simplified tracked drive: bounded motor force, rolling resistance and grip. */
(function(root){
 'use strict';
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),angle=v=>Math.atan2(Math.sin(v),Math.cos(v));
 function forces(c,mass,p,target,gradient,velocity,yawRate,manual=false){
  const [gx,gy]=gradient,normal=mass*9.81/Math.sqrt(1+gx*gx+gy*gy),grip=c.mu*normal;
  const driveLimit=Math.min(grip,2*c.torqueLimit/c.k),cs=Math.cos(p.yaw),sn=Math.sin(p.yaw);
  const moving=Math.abs(target.v)>.0001||Math.abs(target.omega)>.0001||!manual&&(Math.hypot(target.x-p.x,target.y-p.y)>.002||Math.abs(angle(target.yaw-p.yaw))>.01);
  // A released manual control is a real friction brake. There is no position
  // anchor, heading anchor or force cancelling downhill gravity in this mode.
  if(!moving)return {fx:0,fy:0,torque:0,contactFriction:c.mu,normal,driveLimit};
  const rolling=Math.min(.03,c.mu),alongSpeed=velocity[0]*cs+velocity[1]*sn,lateralSpeed=-velocity[0]*sn+velocity[1]*cs;
  let fx,fy;
  if(manual){
   const forward=mass*20*(target.v-alongSpeed)+(Math.abs(target.v)>.0001?mass*9.81*(gx*cs+gy*sn)+rolling*normal*Math.sign(target.v):0);
   const lateral=clamp(mass*9.81*(-gx*sn+gy*cs)-mass*30*lateralSpeed,-grip,grip);
   fx=forward*cs-lateral*sn;fy=forward*sn+lateral*cs;
  }else{
   fx=mass*(25*(target.x-p.x)+8*(target.v*Math.cos(target.yaw)-velocity[0]))+mass*9.81*gx;
   fy=mass*(25*(target.y-p.y)+8*(target.v*Math.sin(target.yaw)-velocity[1]))+mass*9.81*gy;
   if(Math.abs(target.v)>.0001){fx+=rolling*normal*Math.sign(target.v)*Math.cos(target.yaw);fy+=rolling*normal*Math.sign(target.v)*Math.sin(target.yaw);}
  }
  const ratio=Math.min(1,driveLimit/Math.max(1e-9,Math.hypot(fx,fy)));
  const torqueLimit=Math.min(.3,c.trackWidth*driveLimit/2);
  return {fx:fx*ratio,fy:fy*ratio,torque:clamp(.25*angle(target.yaw-p.yaw)+.12*(target.omega-yawRate),-torqueLimit,torqueLimit),contactFriction:moving?rolling:c.mu,normal,driveLimit};
 }
 const api={forces};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.TruckTraction=api;
})(globalThis);
