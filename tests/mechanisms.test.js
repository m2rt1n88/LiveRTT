import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyModules,normalizeModules} from '../frontend/assets/js/profiles.js';
import {mechanismLibrary,selectMechanism,solveGimbal,validateMechanism,estimateChassis,commandChassis,slots} from '../frontend/assets/js/mechanisms.js';
import {composeVehiclePose} from '../frontend/assets/js/vehicle.js';
import {motionMotorPaths} from '../frontend/assets/js/motion.js';
const close=(actual,expected)=>{assert.ok(actual);actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-8,actual+' != '+expected));};
const states=cfg=>Object.fromEntries(slots(cfg,'gimbal').map(j=>[j.id,{angle:0,target:0,speed:0,source:'变量反馈'}]));

test('every bundled model is valid; every zero gimbal points to chassis front',()=>{
 for(const kind of ['gimbal','chassis'])for(const model of mechanismLibrary[kind])assert.deepEqual(validateMechanism(model,kind),model);
 for(const model of mechanismLibrary.gimbal){const cfg=emptyModules().gimbal;selectMechanism(cfg,'gimbal',model);close(solveGimbal(cfg,states(cfg)).direction,[1,0,0]);}
});

test('dual yaw pivots remain coaxial and stacked while a single pitch aims the head',()=>{
 assert.deepEqual(mechanismLibrary.gimbal.map(m=>m.id),['yaw-pitch','dual-yaw','folding']);
 const cfg=emptyModules().gimbal;selectMechanism(cfg,'gimbal',mechanismLibrary.gimbal.find(m=>m.id==='dual-yaw'));
 const s=states(cfg);s.yaw.angle=.8;s.smallYaw.angle=-.3;s.pitch.angle=.2;
 const pose=solveGimbal(cfg,s),[big,small,pitch]=pose.joints;
 close(big.position.slice(0,2),small.position.slice(0,2));close(big.axis,small.axis);
 assert.ok(small.position[2]>big.position[2]);assert.equal(pitch.parent,'smallYaw');
 close(pose.direction,[Math.cos(.5)*Math.cos(.2),Math.sin(.5)*Math.cos(.2),Math.sin(.2)]);
});

test('two-pitch folding lifts the head with compensation and retains independent upper pitch',()=>{
 const cfg=emptyModules().gimbal;selectMechanism(cfg,'gimbal',mechanismLibrary.gimbal.find(m=>m.id==='folding'));
 assert.deepEqual(slots(cfg,'gimbal').map(j=>[j.id,j.parent]),[['yaw',null],['pitch','yaw'],['fold','pitch']]);
 const s=states(cfg),zero=solveGimbal(cfg,s);s.pitch.angle=Math.PI/3;s.fold.angle=-Math.PI/3;
 const lifted=solveGimbal(cfg,s);close(lifted.direction,[1,0,0]);
 assert.ok(lifted.tool[2]>zero.tool[2]);assert.ok(lifted.tool[0]<zero.tool[0]);
 close(lifted.joints[2].position,[29,0,47+58*Math.sqrt(3)/2]);
 s.fold.angle+=.2;close(solveGimbal(cfg,s).direction,[Math.cos(.2),0,Math.sin(.2)]);
 s.pitch.angle=null;assert.equal(solveGimbal(cfg,s).direction,null);assert.ok(solveGimbal(cfg,s,'target').complete);
});

test('old shipped snapshots migrate without swapping bindings; customized geometry stays intact',()=>{
 for(const {from,to}of mechanismLibrary.gimbalMigrations){
  const saved=emptyModules();saved.gimbal.mechanism=structuredClone(from);
  saved.gimbal.axes.pitch={...saved.gimbal.axes.pitch,motor:'lower',zero:17};
  saved.gimbal.axes.fold={...saved.gimbal.axes.pitch,motor:'upper',zero:-23};
  saved.gimbal.bindings.foldTarget='upperTarget';
  const restored=normalizeModules(saved);
  assert.equal(restored.gimbal.axes.pitch.motor,'lower');assert.equal(restored.gimbal.axes.fold.motor,'upper');
  assert.equal(restored.gimbal.axes.fold.zero,-23);assert.equal(restored.gimbal.bindings.foldTarget,'upperTarget');
  if(to)assert.deepEqual(restored.gimbal.mechanism,mechanismLibrary.gimbal.find(m=>m.id===to));
  else{assert.equal(restored.gimbal.mechanism.id,'legacy-four-axis');assert.deepEqual(restored.gimbal.mechanism.joints,from.joints);}
  assert.deepEqual(normalizeModules(restored),restored);
  saved.gimbal.mechanism.joints[1].origin[0]+=3;
  assert.deepEqual(normalizeModules(saved).gimbal.mechanism,saved.gimbal.mechanism);
 }
});

test('custom nonparallel joints rotate in their parent frames',()=>{
 const cfg=emptyModules().gimbal,model=structuredClone(mechanismLibrary.gimbal.find(m=>m.id==='folding'));
 model.id='custom-roll';model.joints.find(j=>j.id==='fold').axis=[1,0,0];selectMechanism(cfg,'gimbal',model);
 const s=states(cfg);s.yaw.angle=Math.PI/2;s.pitch.angle=Math.PI/6;s.fold.angle=Math.PI/2;
 close(solveGimbal(cfg,s).direction,[0,Math.sqrt(3)/2,.5]);
 s.pitch.angle=null;assert.equal(solveGimbal(cfg,s).direction,null);
 s.pitch.angle=0;s.pitch.source='电机输出轴反馈';s.pitch.motor={status:'offline'};assert.equal(solveGimbal(cfg,s).direction,null);
});

test('mount orientation is independent of joint calibration and whole vehicle uses the same solver',()=>{
 const cfg=emptyModules().gimbal,s=states(cfg);cfg.mount.rotation[2]=90;
 close(solveGimbal(cfg,s).direction,[0,1,0]);
 const pose=composeVehiclePose({...s,config:cfg},{body:{omega:0}},{gimbalFrame:'body'},{heading:Math.PI/2,headingTarget:Math.PI/2});
 close(pose.feedbackDirection,[-1,0,0]);assert.ok(pose.pointingError<1e-8);
 close(pose.feedbackScene.tool,solveGimbal(cfg,s,'angle',{heading:Math.PI/2}).tool);
});

test('independent multi-axis target follows the same mechanism and missing target stays missing',()=>{
 const cfg=emptyModules().gimbal;selectMechanism(cfg,'gimbal',mechanismLibrary.gimbal.find(m=>m.id==='folding'));const s=states(cfg);s.yaw.target=.3;s.fold.target=.2;
 const pose=composeVehiclePose({...s,config:cfg},{body:{omega:0}},{gimbalFrame:'body'},{heading:0,headingTarget:0});
 close(pose.targetDirection,solveGimbal(cfg,s,'target').direction);assert.ok(pose.pointingError>.3);
 s.fold.target=null;assert.equal(composeVehiclePose({...s,config:cfg},{body:{omega:0}},{gimbalFrame:'body'},{heading:0,headingTarget:0}).targetDirection,null);
});

test('matrix chassis estimates independent wheel vectors and never invents an unobservable component',()=>{
 const cfg=emptyModules().chassis;selectMechanism(cfg,'chassis',mechanismLibrary.chassis.find(m=>m.id==='differential'));cfg.radius=.1;cfg.halfWidth=.2;
 assert.deepEqual(estimateChassis(cfg,{left:10,right:-10}),{vx:null,vy:1,omega:0});
 assert.deepEqual(estimateChassis(cfg,{left:2,right:2}),{vx:null,vy:0,omega:1});
 assert.equal(estimateChassis(cfg,{left:2,right:null}),null);
 selectMechanism(cfg,'chassis',mechanismLibrary.chassis.find(m=>m.id==='omni-three'));
 const expected={vx:.7,vy:-.4,omega:1.2};const rates=commandChassis(cfg,expected),body=estimateChassis(cfg,rates);close([body.vx,body.vy,body.omega],Object.values(expected));
 const broken=structuredClone(cfg.mechanism);broken.wheels.forEach(w=>w.drive=[1,1,1]);cfg.mechanism=broken;assert.equal(estimateChassis(cfg,rates),null);
});

test('switching models preserves calibrations and samples only active slots after profile restoration',()=>{
 const modules=emptyModules();modules.gimbal.enabled=true;modules.gimbal.axes.yaw.motor='base';modules.gimbal.axes.yaw.zero=25;
 selectMechanism(modules.gimbal,'gimbal',mechanismLibrary.gimbal[1]);modules.gimbal.axes.smallYaw.motor='small';modules.gimbal.bindings.smallYaw='imu';
 selectMechanism(modules.gimbal,'gimbal',mechanismLibrary.gimbal[0]);assert.deepEqual(motionMotorPaths(modules,[{path:'base'},{path:'small'}]),['base']);
 const restored=normalizeModules(modules);selectMechanism(restored.gimbal,'gimbal',mechanismLibrary.gimbal[1]);
 assert.equal(restored.gimbal.axes.yaw.zero,25);assert.equal(restored.gimbal.axes.smallYaw.motor,'small');assert.equal(restored.gimbal.bindings.smallYaw,'imu');
});

test('malformed hierarchies, duplicate IDs and unknown adapters fail before activation',()=>{
 const base=mechanismLibrary.gimbal[0];
 for(const mutate of [m=>m.joints[0].parent='pitch',m=>m.joints[1].id='yaw',m=>m.joints[0].axis=[0,0,0],m=>m.adapter='eval',m=>m.tool.parent='missing']){
  const model=structuredClone(base);mutate(model);assert.throws(()=>validateMechanism(model,'gimbal'));
 }
});
