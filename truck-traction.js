/* Simplified tracked drive: bounded motor force, rolling resistance and grip. */
(function(root){
 'use strict';
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),angle=v=>Math.atan2(Math.sin(v),Math.cos(v));
 function supportGradient(height,p,trackWidth){
  const cs=Math.cos(p.yaw),sn=Math.sin(p.yaw),halfLength=.078,halfWidth=trackWidth/2;
  const sample=(x,y)=>height(p.x+cs*x-sn*y,p.y+sn*x+cs*y);
  const along=(sample(halfLength,-halfWidth)+sample(halfLength,halfWidth)-sample(-halfLength,-halfWidth)-sample(-halfLength,halfWidth))/(4*halfLength);
  const across=([-halfLength,0,halfLength].reduce((sum,x)=>sum+sample(x,halfWidth)-sample(x,-halfWidth),0))/(6*halfWidth);
  return [along*cs-across*sn,along*sn+across*cs];
 }
 function createThrottle(){
  let integral=0,phase=null,heading=0;
  return {update(c,p,target,velocity,dt,key,remaining){
   if(key===null||remaining<.005){integral=0;phase=null;return 0;}
   const yaw=target.driveYaw??target.yaw;
   if(phase!==key||Math.cos(yaw-heading)<0){integral=0;phase=key;}heading=yaw;
   const cs=Math.cos(yaw),sn=Math.sin(yaw),error=(target.x-p.x)*cs+(target.y-p.y)*sn;
   const desired=clamp(target.v+2*error,0,Math.min(c.speed,c.k*c.wheelLimit)),actual=velocity[0]*cs+velocity[1]*sn;
   integral=clamp(integral+12*(desired-actual)*dt,0,Math.min(4,c.mu*9.81));
   return integral;
  }};
 }
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
   const yaw=target.driveYaw??target.yaw;
   fx=mass*(25*(target.x-p.x)+8*(target.v*Math.cos(yaw)-velocity[0]))+mass*9.81*gx;
   fy=mass*(25*(target.y-p.y)+8*(target.v*Math.sin(yaw)-velocity[1]))+mass*9.81*gy;
   if(Math.abs(target.v)>.0001){fx+=rolling*normal*Math.sign(target.v)*Math.cos(yaw);fy+=rolling*normal*Math.sign(target.v)*Math.sin(yaw);}
   fx+=mass*(target.driveBoost||0)*Math.cos(yaw);fy+=mass*(target.driveBoost||0)*Math.sin(yaw);
  }
  const ratio=Math.min(1,driveLimit/Math.max(1e-9,Math.hypot(fx,fy)));
  const torqueLimit=Math.min(.3,c.trackWidth*driveLimit/2);
  return {fx:fx*ratio,fy:fy*ratio,torque:clamp(.25*angle(target.yaw-p.yaw)+.12*(target.omega-yawRate),-torqueLimit,torqueLimit),contactFriction:moving?rolling:c.mu,normal,driveLimit};
 }
 const api={forces,supportGradient,createThrottle};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.TruckTraction=api;
})(globalThis);
