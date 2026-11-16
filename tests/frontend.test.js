import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCsv} from '../frontend/assets/js/charts.js';
import {ProfilePersistence, normalizePath, emptyModules, snapshotProfile} from '../frontend/assets/js/profiles.js';

test('CSV preserves exact integer strings, missing samples and display scaling',()=>{
  const watches=[{path:'counter',label:'=unsafe',unit:'deg',scale:2}];
  const exact=String(2n**60n+1n);
  const csv=buildCsv(watches,[{time:100,raw:{counter:exact}},{time:101,raw:{counter:null}}]);
  assert.ok(csv.includes(exact));
  assert.ok(csv.includes(String(Number(exact)*2)));
  assert.ok(csv.includes('"\'=unsafe [deg]"'));
  assert.ok(csv.endsWith('"101","1","",""'));
});

test('per-ELF snapshot stores paths, plot choice and module bindings, never target addresses',()=>{
  const state={profileId:'one',profileName:'name',elfPath:'C:/firmware/app.elf',rate:5,window:'120',modules:emptyModules(),watches:[{path:'a',label:'A',unit:'rad',scale:1,plot:false,address:'old',value:1}]};
  state.modules.gimbal.enabled=true;state.modules.gimbal.bindings.yaw='a';
  const snapshot=snapshotProfile(state,{port:6666,rttPort:8888});
  assert.equal(snapshot.watches[0].plot,false);
  assert.equal(snapshot.modules.gimbal.bindings.yaw,'a');
  assert.equal('address' in snapshot.watches[0],false);
  state.modules.gimbal.bindings.yaw='different';
  assert.equal(snapshot.modules.gimbal.bindings.yaw,'a');
  assert.equal(normalizePath('C:\\Firmware\\APP.elf'),normalizePath('c:/firmware/app.elf'));
});

test('queued autosaves keep edits made while the first save is in flight',async()=>{
  let release;
  let value='first';const saved=[],acknowledged=[];
  const api={request:async(path,body)=>{saved.push(body.value);if(saved.length===1)await new Promise(resolve=>{release=resolve;});return body;}};
  const persistence=new ProfilePersistence(api,()=>({elfPath:'app.elf',value}),(_,latest)=>acknowledged.push(latest),()=>{});
  persistence.changed();const first=persistence.flush();
  await new Promise(resolve=>setImmediate(resolve));
  value='second';persistence.changed();const second=persistence.flush();
  release();await Promise.all([first,second]);
  assert.deepEqual(saved,['first','second']);
  assert.deepEqual(acknowledged,[false,true]);assert.equal(persistence.dirty,false);
});

test('failed save remains dirty and can be retried without losing the snapshot',async()=>{
  let failing=true;const results=[];
  const persistence=new ProfilePersistence({request:async(_,body)=>{if(failing)throw Error('disk error');return body;}},()=>({elfPath:'a.elf'}),body=>results.push(body),()=>{});
  persistence.changed();await assert.rejects(persistence.flush(),/disk error/);assert.equal(persistence.dirty,true);
  failing=false;await persistence.flush();assert.equal(persistence.dirty,false);assert.equal(results.length,1);
});

import {motorState, motorFields, motorPlotRange, motorSpeedPidField, motorRawGroups} from '../frontend/assets/js/motors.js';
import {moduleDefinitions} from '../frontend/assets/js/profiles.js';
import {normalizeModules} from '../frontend/assets/js/profiles.js';
import {axisState, angleRadians, wheelKinematics, wheelCommands, motionMotorPaths, MotionDashboard, gimbalDirection, wheelMotorDetails, setSpeedToBody, chassisWheelGeometry, chassisVector} from '../frontend/assets/js/motion.js';
import {HeadingIntegrator, VehicleHeading, composeVehiclePose} from '../frontend/assets/js/vehicle.js';

test('motor modes keep angle, speed, raw current targets and DM faults distinct',()=>{
  const motor=(family,mode,target)=>({family,fields:{'state_.mode':mode,'state_.target':target,'state_.tx.p_des':1,'state_.tx.v_des':2,'state_.rx.status':11}});
  const velocity=motorState(motor('DJI',0x82,9));
  assert.equal(velocity.omegaTarget,9);assert.equal(velocity.thetaTarget,null);assert.match(velocity.mode,/ABSOLUTE/);
  const cascaded=motorState(motor('DJI',6,3));assert.equal(cascaded.thetaTarget,3);assert.equal(cascaded.omegaTarget,null);
  const current=motorState(motor('DJI',1,1000));assert.equal(current.rawTarget,1000);assert.equal(current.omegaTarget,null);
  const bypass=motorState(motor('DJI',7,1000));assert.equal(bypass.rawTarget,1000);assert.equal(bypass.thetaTarget,null);
  const dm=motorState(motor('DM',512,99));assert.equal(dm.thetaTarget,null);assert.equal(dm.omegaTarget,2);assert.equal(dm.fault,'MOS 过温');
  const blocked=motorState({family:'DJI',fields:{'omega_pid_.PID_ErrorHandler.error_type':1}});assert.match(blocked.fault,/固件 PID/);
  const cyber={family:'CyberGear',fields:{theta_:1,omega_:2,temperature_:38,mode_:3,status_:2,error_code_:4}};
  assert.equal(motorFields(cyber)['state_.raw_temperature'],38);
  assert.equal(motorState(cyber).rawTarget,null);assert.match(motorState(cyber).fault,/0x4/);
});

test('near-zero motor noise does not make zero target and feedback look far apart',()=>{
  const [lo,hi]=motorPlotRange([0,-1e-40],'rad/s');
  assert.ok(lo<0&&hi>0);assert.ok(hi-lo>=.2);
  const current=motorPlotRange([0,.002],'A');assert.ok(current[1]-current[0]>=.02);
});

test('speed PID history hides retained values in bypassed, disabled and unknown states',()=>{
 const motor={family:'DJI',fields:{'state_.mode':6,'state_.enable':true,'omega_pid_.pout_':12,'omega_pid_.target_':0}};
 assert.equal(motorSpeedPidField(motor,'pout_'),12);assert.equal(motorSpeedPidField(motor,'target_'),0);
 for(const mode of [0,1,4,7,undefined])assert.equal(motorSpeedPidField({...motor,fields:{...motor.fields,'state_.mode':mode}},'pout_'),null);
 for(const enable of [false,undefined])assert.equal(motorSpeedPidField({...motor,fields:{...motor.fields,'state_.enable':enable}},'pout_'),null);
 assert.equal(motorSpeedPidField({...motor,family:'DM'},'pout_'),null);
 // A later disabled sample must not erase the earlier active sample's meaning.
 const history=[motor,{...motor,fields:{...motor.fields,'state_.enable':false}}];assert.deepEqual(history.map(m=>motorSpeedPidField(m,'pout_')),[12,null]);
});

test('raw field groups retain tiny values, zeros, booleans, unknown fields and read errors',()=>{
 const motor={fields:{'state_.current':1e-40,'state_.target':0,'state_.enable':false,'omega_pid_.kp_':1.234567890123,'theta_pid_.kp_':2,unknown:'original',broken:null,missing:null},fieldErrors:{broken:'读取失败'}};
 const groups=motorRawGroups(motor),rows=groups.flatMap(g=>g.rows),values=Object.fromEntries(rows.map(r=>[r.key,r.value]));
 assert.equal(groups.length,5);assert.equal(rows.length,8);assert.equal(values['state_.current'],'1e-40');assert.equal(values['state_.target'],'0');assert.equal(values['state_.enable'],'false');assert.equal(values['omega_pid_.kp_'],'1.234567890123');assert.equal(values.unknown,'original');assert.equal(values.missing,'—');assert.equal(values.broken,'读取失败');assert.equal(rows.find(r=>r.key==='broken').error,true);
});

test('motor monitor leads navigation and snapshots its own selection without watches',()=>{
  assert.equal(Object.keys(moduleDefinitions)[0],'motors');
  const state={elfPath:'a.elf',modules:emptyModules(),watches:[]};
  state.modules.motors={...state.modules.motors,enabled:true,selected:['motor1'],focus:'motor1',bus:'CAN1'};
  const snapshot=snapshotProfile(state,{});state.modules.motors.selected.push('other');
  assert.deepEqual(snapshot.modules.motors.selected,['motor1']);assert.equal(snapshot.watches.length,0);
});

test('old profiles discard removed target module and merge new motion defaults without losing watches',()=>{
 const old={targets:{enabled:true},gimbal:{enabled:true,bindings:{yaw:'imu.yaw'}}};
 const modules=normalizeModules(old);assert.equal('targets' in modules,false);assert.equal(modules.gimbal.bindings.yaw,'imu.yaw');
 assert.equal(modules.chassis.enabled,false);assert.equal(modules.chassis.layout,'mecanum');assert.equal(modules.gimbal.axes.pitch.min,-30);
 const restored=normalizeModules({...modules,chassis:{...modules.chassis,layout:'omni',wheels:{fl:{motor:'wheel',sign:-1,ratio:2}}}});
 assert.equal(restored.chassis.wheels.fl.ratio,2);assert.equal(restored.chassis.wheels.fr.ratio,1);
});

test('gimbal uses output shaft, calibrated targets, shortest yaw error and explicit IMU reference',()=>{
 const motor={family:'DJI',fields:{'state_.theta':99,'state_.output_shaft_theta':Math.PI*179/180,'state_.output_shaft_omega':2,'state_.mode':6,'state_.target':-Math.PI*179/180}};
 const cfg={sign:1,ratio:1,zero:0,min:-180,max:180};
 const a=axisState(cfg,motor,{},true);assert.ok(Math.abs(a.error-2*Math.PI/180)<1e-9);assert.equal(a.speed,2);assert.equal(a.outside,false);
 const calibrated=axisState({...cfg,sign:-1,ratio:2,zero:10},motor);assert.ok(Math.abs(calibrated.angle-(-179/2-10)*Math.PI/180)<1e-9);
 const imu=axisState(cfg,motor,{angleBound:true,angle:.2});assert.equal(imu.target,null);assert.equal(imu.speed,null);
 const missing=axisState(cfg,motor,{angleBound:true,angle:null,targetBound:true,target:.2});assert.equal(missing.angle,null);assert.equal(missing.error,null);
 assert.equal(angleRadians(null,'deg'),null);assert.ok(Math.abs(angleRadians(180,'deg')-Math.PI)<1e-9);
});

test('Mecanum and Omni kinematics recover pure translation, yaw and mixed motion with correct wheel order',()=>{
 for(const layout of ['mecanum','omni'])for(const [vx,vy,omega]of [[1,0,0],[0,1,0],[0,0,2],[-.2,.7,-.6]]) {
  const wheels=wheelCommands(layout,vx,vy,omega,.076,.2,.3),body=wheelKinematics(layout,wheels,.076,.2,.3);
  for(const [key,v]of Object.entries({vx,vy,omega}))assert.ok(Math.abs(body[key]-v)<1e-9,layout+' '+key);
 }
 assert.equal(wheelKinematics('mecanum',{fl:1,fr:1,bl:1,br:null},.1,.2,.2),null);
 // Known independent vectors from boards/components/src/chassis.cpp, not generated by our inverse.
 const forward=wheelKinematics('mecanum',{fl:1,fr:-1,bl:1,br:-1},.1,.2,.2);assert.equal(forward.vx,0);assert.equal(forward.vy,.1);assert.equal(forward.omega,0);
 const right=wheelKinematics('mecanum',{fl:1,fr:1,bl:-1,br:-1},.1,.2,.2);assert.equal(right.vx,.1);assert.equal(right.vy,0);assert.equal(right.omega,0);
 const rotate=wheelKinematics('mecanum',{fl:1,fr:1,bl:1,br:1},.1,.2,.2);assert.equal(rotate.vx,0);assert.equal(rotate.vy,0);assert.equal(rotate.omega,.25);
 const omni=wheelKinematics('omni',{fl:1,fr:-1,bl:1,br:-1},.1,.2,.2);assert.ok(Math.abs(omni.vy-.1*Math.SQRT2)<1e-12);
 // SetSpeed(2,3,4) with offset .25 => FL=8, FR=2, BL=6, BR=0.
 const mixed=wheelKinematics('mecanum',{fl:8,fr:2,bl:6,br:0},.1,.2,.2,.25);
 assert.ok(Math.abs(mixed.vx-.2)<1e-12);assert.ok(Math.abs(mixed.vy-.3)<1e-12);assert.equal(mixed.omega,1);
 assert.ok(wheelCommands('mecanum',0,0,1,.1,.2,.2).fl>0);
 assert.ok(wheelCommands('mecanum',0,1,0,.1,.2,.2).br<0);
});

test('motion sampling is independent of motor page and deduplicates shared bindings',()=>{
 const modules=emptyModules();modules.gimbal.enabled=true;modules.chassis.enabled=true;
 modules.gimbal.axes.yaw.motor='m';modules.chassis.wheels.fl.motor='m';modules.chassis.wheels.fr.motor='missing';
 assert.deepEqual(motionMotorPaths(modules,[{path:'m'}]),['m']);modules.gimbal.enabled=false;modules.chassis.enabled=false;
 assert.deepEqual(motionMotorPaths(modules,[{path:'m'}]),[]);
});

test('repository velocity axes, Omni geometry and legacy rear bindings remain consistent',()=>{
 assert.deepEqual(chassisVector({vx:2,vy:3}),[3,-2]);assert.equal(chassisVector({vx:null,vy:3}),null);
 const wheels=chassisWheelGeometry('omni');
 assert.equal(wheels.fl.angle,-Math.PI/4);assert.equal(wheels.fr.angle,Math.PI/4);
 assert.equal(wheels.bl.angle,Math.PI/4);assert.equal(wheels.br.angle,-Math.PI/4);
 assert.ok(wheels.fl.x>0&&wheels.fl.y>0);assert.ok(wheels.fr.x>0&&wheels.fr.y<0);
 assert.ok(wheels.bl.x<0&&wheels.bl.y>0);assert.ok(wheels.br.x<0&&wheels.br.y<0);
 const old=normalizeModules({chassis:{wheels:{rl:{motor:'left_back',sign:-1,ratio:2},rr:{motor:'right_back'}}}});
 assert.equal(old.chassis.wheels.bl.motor,'left_back');assert.equal(old.chassis.wheels.bl.sign,-1);assert.equal(old.chassis.wheels.bl.ratio,2);
 assert.equal(old.chassis.wheels.br.motor,'right_back');assert.equal('rl' in old.chassis.wheels,false);
 assert.equal(normalizeModules({chassis:{wheels:{bl:{motor:'canonical'},rl:{motor:'legacy'}}}}).chassis.wheels.bl.motor,'canonical');
});

test('SetSpeed raw command units convert independently and do not reinterpret angular units or missing values',()=>{
 const modules=emptyModules(),cfg=modules.chassis;Object.assign(cfg,{radius:.1,halfLength:.2,halfWidth:.2,commandUnits:'setSpeed',angleUnit:'deg'});
 const expected=setSpeedToBody({vx:2,vy:3,omega:4},cfg);
 assert.deepEqual(expected,{vx:.2,vy:.30000000000000004,omega:1});
 const state={modules,watches:[{path:'x',value:2,valid:true,lastTime:1,scale:1},{path:'t',value:4,valid:true,lastTime:1,scale:1,unit:'deg/s'}]};
 cfg.bindings.vxTarget='x';cfg.bindings.omegaTarget='t';
 const dashboard=new MotionDashboard(null,state,{latest:new Map(),catalog:[]},{}),snapshot=dashboard.snapshot('chassis');
 assert.equal(snapshot.target.vx,.2);assert.equal(snapshot.target.omega,1);assert.equal(snapshot.target.vy,null);
 state.watches[1].value=null;assert.equal(dashboard.snapshot('chassis').target.omega,null);
 cfg.commandUnits='si';state.watches[1].value=180;assert.equal(dashboard.snapshot('chassis').target.omega,Math.PI);
});

test('body estimate stops on an offline wheel, explicit missing feedback stays missing, booleans work',()=>{
 const modules=emptyModules();modules.chassis.enabled=true;modules.gimbal.enabled=true;
 const latest=new Map();for(const key of ['fl','fr','bl','br']){modules.chassis.wheels[key].motor=key;latest.set(key,{family:'DJI',status:'online',fields:{'state_.output_shaft_omega':1,'state_.mode':2,'state_.target':2}});}
 const state={modules,watches:[]},dashboard=new MotionDashboard(null,state,{latest,catalog:[]},{});
 assert.ok(dashboard.snapshot('chassis').body.omega>0);latest.get('fl').status='offline';assert.equal(dashboard.snapshot('chassis').body.vx,null);
 state.watches=[{path:'v',valid:true,value:null,lastTime:1,scale:1},{path:'en',valid:true,value:false,lastTime:1,scale:1}];modules.chassis.bindings.vx='v';modules.chassis.bindings.enabled='en';
 latest.get('fl').status='online';const snap=dashboard.snapshot('chassis');assert.equal(snap.body.vx,null);assert.equal(snap.enabled,0);
 assert.equal(snap.sources.vx,'变量实测');assert.equal(snap.targetSources.vx,'轮目标推算');
 dashboard.ingest(10);assert.equal(dashboard.frames.chassis.length,1);dashboard.reset('gimbal');assert.equal(dashboard.frames.chassis.length,1);
 for(const motor of latest.values())motor.time=10;assert.ok(dashboard.snapshot('chassis',10).target.omega>0);
 assert.equal(dashboard.snapshot('chassis',11).target.vx,null,'old motor cache cannot be stamped as a new frame after rebinding');
});

test('combined gimbal orientation follows both axes and never substitutes missing feedback',()=>{
 const close=(actual,expected)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-12));
 close(gimbalDirection(0,0),[1,0,0]);
 close(gimbalDirection(Math.PI/2,0),[0,1,0]);
 close(gimbalDirection(0,Math.PI/2),[0,0,1]);
 const dir=gimbalDirection(Math.PI/3,Math.PI/6);
 close(dir,[Math.sqrt(3)/4,.75,.5]);assert.ok(Math.abs(Math.hypot(...dir)-1)<1e-12);
 assert.equal(gimbalDirection(null,0),null);assert.equal(gimbalDirection(0,undefined),null);
 assert.equal(gimbalDirection(NaN,0),null);
});

test('wheel details distinguish output shaft, calibrated speed, mode targets and missing telemetry',()=>{
 const wheel={speed:-2,target:-3,motor:{family:'DJI',status:'offline',feedbackAgeMs:450,fields:{
  'state_.theta':99,'state_.output_shaft_theta':1,'state_.mode':2,'state_.target':6,
  'state_.enable':false,'output_':123,'state_.current':.8,'state_.raw_temperature':38}}};
 const rows=Object.fromEntries(wheelMotorDetails(wheel));
 assert.equal(rows['在线状态'],'反馈超时');assert.equal(rows['软件使能'],'失能');
 assert.equal(rows['输出轴 θ'],'1 rad / 57.3°');assert.equal(rows['轮轴 ω / 目标'],'-2 / -3 rad/s');
 assert.equal(rows['角度目标'],'— rad');assert.equal(rows.output,'123 raw');
 assert.equal(rows['反馈间隔'],'450 ms');assert.equal(rows['力矩反馈'],'— N·m');
 const dm=Object.fromEntries(wheelMotorDetails({motor:{family:'DM',status:'online',fields:{'state_.mode':0,'state_.tx.p_des':.5,'state_.rx.status':11,'state_.torque':2}}}));
 assert.equal(dm['故障'],'MOS 过温');assert.equal(dm['软件使能'],'未知');
 assert.equal(dm['角度目标'],'0.5 rad');assert.equal(dm.output,'— raw');
 assert.deepEqual(wheelMotorDetails({}),[]);
});

test('heading integration uses sample time, breaks on gaps, loss or pause, and requires a new origin',()=>{
 const integrator=new HeadingIntegrator();
 assert.equal(integrator.update(1,null),null);assert.equal(integrator.update(2,1),0);
 assert.ok(Math.abs(integrator.update(2.2,3)-.4)<1e-12);
 assert.ok(Math.abs(integrator.update(2.2,3)-.4)<1e-12);
 assert.equal(integrator.update(4,3),null);assert.equal(integrator.update(4.2,3),null);
 integrator.reset();assert.equal(integrator.update(5,1,2),2);integrator.interrupt();assert.equal(integrator.update(5.1,1),null);
 integrator.reset();integrator.update(6,1);assert.equal(integrator.update(6.1,null),null);assert.equal(integrator.update(6.2,1),null);
 integrator.reset();integrator.update(7,1);assert.equal(integrator.update(6.9,1),null);
});

test('vehicle heading respects measured feedback and explicit missing targets without fallback',()=>{
 const track=new VehicleHeading(),chassis={heading:2,body:{omega:1},target:{omega:1}};
 const first=track.update(1,chassis,{measured:true});assert.equal(first.heading,2);assert.equal(first.headingTarget,2);
 assert.ok(Math.abs(track.update(1.2,chassis,{measured:true}).headingTarget-1.8)<1e-12);
 const missing=track.update(1.4,{...chassis,heading:null},{measured:true,targetBound:true,targetValue:null});
 assert.equal(missing.heading,null);assert.equal(missing.headingTarget,null);
 track.interrupt();assert.equal(track.update(1.6,chassis,{measured:true,targetBound:true,targetValue:3}).headingTarget,3);
 assert.equal(track.update(1.8,chassis,{measured:true}).headingTarget,null);
});

test('vehicle composes body and gimbal orientation, exposes compensation and avoids adding chassis yaw to world IMU',()=>{
 const gimbal={yaw:{angle:-Math.PI/2,target:-Math.PI/2,speed:-1,source:'电机输出轴反馈',motor:{status:'online'}},pitch:{angle:.2,target:.2,source:'变量反馈'}};
 const chassis={body:{omega:-1}},headings={heading:Math.PI/2,headingTarget:Math.PI/2,measured:true};
 const body=composeVehiclePose(gimbal,chassis,{gimbalFrame:'body'},headings);
 assert.equal(body.worldYaw,0);assert.equal(body.worldTarget,0);assert.equal(body.worldRate,0);assert.equal(body.relativeRate,-1);assert.equal(body.pointingError,0);
 const imu=composeVehiclePose({...gimbal,yaw:{...gimbal.yaw,angle:0,target:0,speed:0,source:'变量反馈'}},chassis,{gimbalFrame:'world'},headings);
 assert.equal(imu.worldYaw,0);assert.equal(imu.relativeYaw,-Math.PI/2);assert.equal(imu.worldRate,0);assert.equal(imu.relativeRate,-1);
 const wrap=composeVehiclePose({...gimbal,yaw:{...gimbal.yaw,angle:179*Math.PI/180,target:-179*Math.PI/180}},chassis,{gimbalFrame:'world'},headings);
 assert.ok(Math.abs(wrap.yawError-2*Math.PI/180)<1e-12);
 const offline=composeVehiclePose({...gimbal,yaw:{...gimbal.yaw,motor:{status:'offline'}}},chassis,{gimbalFrame:'body'},headings);
 assert.equal(offline.feedbackDirection,null);assert.equal(offline.worldRate,null);assert.equal(offline.pointingError,null);
 const unknown=composeVehiclePose(gimbal,chassis,{gimbalFrame:'body'},{heading:null,headingTarget:null});
 assert.equal(unknown.feedbackDirection,null);assert.equal(unknown.targetDirection,null);
});

test('whole vehicle alone requests six motors, deduplicates shared bindings and persists independent settings',()=>{
 const modules=emptyModules(),catalog=[];modules.vehicle.enabled=true;modules.vehicle.gimbalFrame='world';
 for(const key of ['yaw','pitch']){modules.gimbal.axes[key].motor=key;catalog.push({path:key});}
 for(const key of Object.keys(modules.chassis.wheels)){modules.chassis.wheels[key].motor=key;catalog.push({path:key});}
 assert.equal(modules.gimbal.enabled,false);assert.equal(modules.chassis.enabled,false);
 assert.equal(motionMotorPaths(modules,catalog).length,6);
 modules.gimbal.enabled=true;modules.chassis.enabled=true;assert.equal(motionMotorPaths(modules,catalog).length,6);
 const restored=normalizeModules(snapshotProfile({modules,watches:[]},{}).modules);
 assert.equal(restored.vehicle.gimbalFrame,'world');assert.equal(restored.vehicle.enabled,true);
 assert.equal(normalizeModules({}).vehicle.enabled,false);
});

