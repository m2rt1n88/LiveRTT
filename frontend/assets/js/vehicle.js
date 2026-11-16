import {solveGimbal, slots} from './mechanisms.js';
// Planar chassis plus a configured gimbal mechanism. Radians, seconds, SI speeds.
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const wrap=value=>Math.atan2(Math.sin(value),Math.cos(value));
const direction=(yaw,pitch)=>finite(yaw)&&finite(pitch)?[Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),Math.sin(pitch)]:null;

export class HeadingIntegrator {
 constructor(){this.reset();}
 reset(){this.value=null;this.time=null;this.rate=null;this.broken=false;}
 interrupt(){if(this.time!==null)this.broken=true;}
 update(time,rate,origin=0){
  if(this.broken)return null;
  if(!finite(time)||!finite(rate)){this.interrupt();return null;}
  if(this.time===null){if(!finite(origin))return null;this.value=origin;this.time=time;this.rate=rate;return this.value;}
  const dt=time-this.time;
  if(dt<0||dt>1){this.broken=true;return null;}
  if(dt>0){this.value+=.5*(this.rate+rate)*dt;this.time=time;this.rate=rate;}
  return this.value;
 }
}

export class VehicleHeading {
 constructor(){this.feedback=new HeadingIntegrator();this.target=new HeadingIntegrator();}
 reset(){this.feedback.reset();this.target.reset();}
 interrupt(){this.feedback.interrupt();this.target.interrupt();}
 update(time,chassis,{measured=false,targetBound=false,targetValue=null}={}){
  // Repository vt is clockwise; headings and calibrated gimbal yaw are CCW.
  const ccw=value=>finite(value)?-value:null;
  const heading=measured?(finite(chassis.heading)?chassis.heading:null):this.feedback.update(time,ccw(chassis.body.omega));
  // Both tracks begin at the same sampled orientation. No assumed target when missing.
  const headingTarget=targetBound?(finite(targetValue)?targetValue:null):this.target.update(time,ccw(chassis.target.omega),heading);
  return {heading,headingTarget,measured,targetBound,broken:!measured&&this.feedback.broken,targetBroken:!targetBound&&this.target.broken};
 }
}

export function composeVehiclePose(gimbal,chassis,config,headings){
 if(gimbal.config)return composeMechanismPose(gimbal,chassis,config,headings);
 const usable=axis=>axis.source==='变量反馈'||axis.motor?.status==='online';
 const yaw=usable(gimbal.yaw)?gimbal.yaw.angle:null,pitch=usable(gimbal.pitch)?gimbal.pitch.angle:null;
 const yawRate=usable(gimbal.yaw)?gimbal.yaw.speed:null;
 const world=config.gimbalFrame==='world',h=headings.heading,ht=headings.headingTarget;
 const worldYaw=world?yaw:finite(h)&&finite(yaw)?h+yaw:null;
 const worldTarget=world?gimbal.yaw.target:finite(ht)&&finite(gimbal.yaw.target)?ht+gimbal.yaw.target:null;
 const relativeYaw=world?(finite(h)&&finite(yaw)?yaw-h:null):yaw;
 const relativeTarget=world?(finite(ht)&&finite(gimbal.yaw.target)?gimbal.yaw.target-ht:null):gimbal.yaw.target;
 const chassisRate=finite(chassis.body.omega)?-chassis.body.omega:null;
 const relativeRate=world?(finite(yawRate)&&finite(chassisRate)?yawRate-chassisRate:null):yawRate;
 const worldRate=world?yawRate:finite(yawRate)&&finite(chassisRate)?yawRate+chassisRate:null;
 const feedbackDirection=direction(worldYaw,pitch),targetDirection=direction(worldTarget,gimbal.pitch.target);
 const dot=feedbackDirection&&targetDirection?feedbackDirection.reduce((sum,v,i)=>sum+v*targetDirection[i],0):null;
 return {...headings,worldYaw,worldTarget,relativeYaw,relativeTarget,pitch,pitchTarget:gimbal.pitch.target,chassisRate,relativeRate,worldRate,
  yawError:finite(worldYaw)&&finite(worldTarget)?wrap(worldTarget-worldYaw):null,
  pitchError:finite(pitch)&&finite(gimbal.pitch.target)?gimbal.pitch.target-pitch:null,
  pointingError:finite(dot)?Math.acos(Math.max(-1,Math.min(1,dot))):null,
  headingError:finite(h)&&finite(ht)?wrap(ht-h):null,feedbackDirection,targetDirection};
}

function composeMechanismPose(gimbal,chassis,config,headings){
 const cfg=gimbal.config,world=config.gimbalFrame==='world',h=headings.heading,ht=headings.headingTarget;
 const feedbackScene=solveGimbal(cfg,gimbal,'angle',{heading:world?0:h}),targetScene=solveGimbal(cfg,gimbal,'target',{heading:world?0:ht});
 const referenceScene=solveGimbal(cfg,gimbal,'angle',{heading:finite(h)?h:0,reference:true});
 const local=solveGimbal(cfg,gimbal),localTarget=solveGimbal(cfg,gimbal,'target');
 const worldYaw=feedbackScene.yaw,worldTarget=targetScene.yaw;
 const relativeYaw=world?(finite(worldYaw)&&finite(h)?wrap(worldYaw-h):null):local.yaw;
 const relativeTarget=world?(finite(worldTarget)&&finite(ht)?wrap(worldTarget-ht):null):localTarget.yaw;
 const chassisRate=finite(chassis.body.omega)?-chassis.body.omega:null;
 let rate=null;
 if(local.complete&&slots(cfg,'gimbal').every(j=>finite(gimbal[j.id]?.speed))){
  const dt=.00001,next=Object.fromEntries(slots(cfg,'gimbal').map(j=>[j.id,{...gimbal[j.id],angle:gimbal[j.id].angle+gimbal[j.id].speed*dt}]));
  const after=solveGimbal(cfg,next);if(Math.hypot(...local.direction.slice(0,2))>.000001&&after.complete)rate=wrap(after.yaw-local.yaw)/dt;
 }
 const relativeRate=world?(finite(rate)&&finite(chassisRate)?rate-chassisRate:null):rate;
 const worldRate=world?rate:finite(rate)&&finite(chassisRate)?rate+chassisRate:null;
 const feedbackDirection=feedbackScene.direction,targetDirection=targetScene.direction;
 const dot=feedbackDirection&&targetDirection?feedbackDirection.reduce((s,v,i)=>s+v*targetDirection[i],0):null;
 return {...headings,feedbackScene,targetScene,referenceScene,worldYaw,worldTarget,relativeYaw,relativeTarget,
  pitch:feedbackScene.pitch,pitchTarget:targetScene.pitch,chassisRate,relativeRate,worldRate,
  yawError:finite(worldYaw)&&finite(worldTarget)?wrap(worldTarget-worldYaw):null,
  pitchError:finite(feedbackScene.pitch)&&finite(targetScene.pitch)?targetScene.pitch-feedbackScene.pitch:null,
  pointingError:finite(dot)?Math.acos(Math.max(-1,Math.min(1,dot))):null,
  headingError:finite(h)&&finite(ht)?wrap(ht-h):null,feedbackDirection,targetDirection};
}
