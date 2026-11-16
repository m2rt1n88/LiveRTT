import {element as el} from './api.js';
import {motorFields, motorState, motorPlotRange} from './motors.js';
import {VehicleHeading, composeVehiclePose} from './vehicle.js';
import {moduleDefinitions} from './profiles.js';
import {mechanismLibrary, mechanism, supportsWorldGimbal, slots, slotLabel, ensureSlots, selectMechanism, bindingFields, validateMechanism, solveGimbal, estimateChassis, commandChassis, wheelGeometry} from './mechanisms.js';
import {drawMechanism} from './mechanism-view.js';

const finite=v=>typeof v==='number'&&Number.isFinite(v);
const fmt=(v,d=2)=>finite(v)?v.toLocaleString('en-US',{maximumFractionDigits:d,useGrouping:false}):'—';
const deg=v=>finite(v)?v*180/Math.PI:null, rad=v=>v*Math.PI/180;
const green='#287963', amber='#d39547', blue='#568eae';
export const wheelNames={fl:'左前 FL',fr:'右前 FR',bl:'左后 BL',br:'右后 BR'};
export const wrapAngle=v=>Math.atan2(Math.sin(v),Math.cos(v));
// +X forward, +Y left, +Z up; pitch is positive when raising the barrel.
export function gimbalDirection(yaw,pitch) {
 if(!finite(yaw)||!finite(pitch))return null;
 return [Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),Math.sin(pitch)];
}
const projectGimbal=([x,y,z])=>[300+.88*x-.68*y,285-.34*x-.44*y-.95*z];
export function wheelMotorDetails(wheel) {
 const m=wheel?.motor;if(!m)return [];
 const f=motorFields(m),s=motorState(m),theta=f[m.family==='DJI'?'state_.output_shaft_theta':'state_.theta'];
 return [
  ['在线状态',({online:'在线',offline:'反馈超时',waiting:'尚无反馈',unknown:'时钟未知',error:'读取失败'})[m.status]||'未知'],
  ['控制模式',s.mode],['软件使能',f['state_.enable']==null?'未知':f['state_.enable']?'使能':'失能'],
  ['输出轴 θ',fmt(theta)+' rad / '+fmt(deg(theta))+'°'],
  ['轮轴 ω / 目标',fmt(wheel.speed)+' / '+fmt(wheel.target)+' rad/s'],
  ['角度目标',fmt(s.thetaTarget)+' rad'],
  ['output',fmt(f.output_)+' raw'],['电流',fmt(f['state_.current'])+' A'],
  ['力矩反馈',fmt(f['state_.torque'])+' N·m'],['温度',fmt(f['state_.raw_temperature'])+' °C'],
  ['反馈间隔',fmt(m.feedbackAgeMs)+' ms'],['故障',s.fault||'未报告']
 ];
}
export function angleRadians(value,unit) {return finite(value)?value*(String(unit).toLowerCase().startsWith('deg')||String(unit).startsWith('°')?Math.PI/180:1):null;}
export function axisState(config,motor,values={},wrap=false) {
 const f=motor?motorFields(motor):{},control=motor?motorState(motor):{},shaft=motor?.family==='DJI'?'state_.output_shaft_':'state_.';
 const convert=v=>finite(v)?config.sign*v/config.ratio-rad(config.zero):null;
 const rawAngle=f[shaft+'theta'],rawSpeed=f[shaft+'omega'];
 const angle=values.angleBound?values.angle:convert(rawAngle),target=values.targetBound?values.target:values.angleBound?null:convert(control.thetaTarget);
 const speed=values.speedBound?values.speed:!values.angleBound&&finite(rawSpeed)?config.sign*rawSpeed/config.ratio:null;
 const error=finite(angle)&&finite(target)?(wrap?wrapAngle(target-angle):target-angle):null;
 const position=finite(angle)?(wrap?wrapAngle(angle):angle):null;
 return {angle,target,speed,error,position,source:values.angleBound?'变量反馈':'电机输出轴反馈',
  outside:finite(position)&&(position<rad(config.min)||position>rad(config.max)),motor,control};
}

// UICRM Chassis::SetSpeed: +vx right, +vy forward, +vt clockwise.
// Raw motor order/signs: FL=y+x+t(1-o), FR=-y+x+t(1-o),
// BL=y-x+t(1+o), BR=-y-x+t(1+o). Geometry converts wheel rad/s to SI.
// Compatibility helpers; production dashboards resolve the selected descriptor.
export function wheelKinematics(layout,wheels,radius,halfLength,halfWidth,offset=0) {
 return estimateChassis({layout,radius,halfLength,halfWidth,offset},wheels);
}
export function wheelCommands(layout,vx,vy,omega,radius,halfLength,halfWidth,offset=0) {
 return commandChassis({layout,radius,halfLength,halfWidth,offset},{vx,vy,omega});
}
export function setSpeedToBody(values,cfg){
 const model=mechanism(cfg,'chassis'),a=model.factor||1;if(model.adapter!=='uicrm-four')return {vx:null,vy:null,omega:null};
 return {vx:finite(values.vx)?values.vx*cfg.radius/a:null,vy:finite(values.vy)?values.vy*cfg.radius/a:null,omega:finite(values.omega)?values.omega*cfg.radius/((cfg.halfLength+cfg.halfWidth)*a):null};
}
// Rendering uses forward/left in a counterclockwise plane. Both pages share this layout.
export function chassisWheelGeometry(layout){return wheelGeometry({layout});}
export const chassisVector=values=>finite(values.vx)&&finite(values.vy)?[values.vy,-values.vx]:null;
export function motionMotorPaths(modules,catalog) {
 const paths=[];
 for(const name of ['gimbal','chassis'])if(modules[name].enabled||modules.vehicle?.enabled)for(const spec of slots(modules[name],name))for(const cfg of [modules[name][name==='gimbal'?'axes':'wheels'][spec.id]])if(cfg.motor&&catalog.some(m=>m.path===cfg.motor))paths.push(cfg.motor);
 return [...new Set(paths)];
}
function svg(tag,attrs={},text) {const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n;}
function label(g,x,y,text,attrs={}){g.append(svg('text',{x,y,fill:'#73877d','font-size':12,...attrs},text));}
function line(g,x,y,xx,yy,color=green,width=3,dashed=false){g.append(svg('line',{x1:x,y1:y,x2:xx,y2:yy,stroke:color,'stroke-width':width,'stroke-linecap':'round',...(dashed?{'stroke-dasharray':'7 5'}:{})}));}
function arrow(g,x,y,xx,yy,color=green,dashed=false) {
 if(Math.hypot(xx-x,yy-y)<.1)return;line(g,x,y,xx,yy,color,3,dashed);const a=Math.atan2(yy-y,xx-x);
 g.append(svg('path',{d:`M${xx-10*Math.cos(a-.45)},${yy-10*Math.sin(a-.45)} L${xx},${yy} L${xx-10*Math.cos(a+.45)},${yy-10*Math.sin(a+.45)}`,fill:'none',stroke:color,'stroke-width':3}));
}
function heading(title,caption){const h=el('div','panel-heading'),group=el('div');group.append(el('h2','',title));h.append(group,el('span','caption',caption));return h;}
function panel(title,caption=''){const p=el('article','panel');p.append(heading(title,caption));return p;}
function note(parent,text,bad=false){parent.append(el('p',bad?'error':'',text));}
function yawOverview(parent,transform,heading,yaw,target,relative){
 const g=svg('g',{class:'yaw-overview',transform,role:'img','aria-label':'Yaw 俯视方向盘：蓝色车头、绿色反馈、橙色目标'}),cx=112,cy=105,r=63;
 g.append(svg('rect',{x:0,y:0,width:224,height:220,rx:12,fill:'#fff','fill-opacity':.96,stroke:'#dce8df'}));
 label(g,112,23,'YAW 俯视 · 车头与瞄向',{'text-anchor':'middle','font-size':13,'font-weight':600,fill:green});
 g.append(svg('circle',{cx,cy,r,fill:'#f5f9f6',stroke:'#d8e5dc'}));
 label(g,cx,cy-r-6,'参考 0°',{'text-anchor':'middle','font-size':10});
 label(g,18,cy+4,'左',{'font-size':10});label(g,196,cy+4,'右',{'font-size':10});
 for(const [role,value,color,length,dash]of [['body',heading,blue,43,false],['target',target,amber,61,true],['feedback',yaw,green,56,false]])if(finite(value)){
  const pointer=svg('g',{'data-yaw-role':role,'data-angle':value});
  arrow(pointer,cx,cy,cx-length*Math.sin(value),cy-length*Math.cos(value),color,dash);g.append(pointer);
 }
 g.append(svg('circle',{cx,cy,r:4,fill:green}));
 label(g,112,188,finite(relative)?'相对车头 '+(Math.abs(wrapAngle(relative))<.001?'正前方':wrapAngle(relative)>0?'左转 ':'右转 ')+fmt(Math.abs(deg(wrapAngle(relative))))+'°':'相对车头：反馈缺失',{'text-anchor':'middle','font-size':12,fill:green});
 label(g,112,207,'蓝：车头   绿：瞄向   橙：目标',{'text-anchor':'middle','font-size':10});parent.append(g);
}
function seriesPlot(title,unit,frames,series){
 const box=el('article','motor-plot');box.append(el('h3','',title+' · '+unit));
 const valid=series.filter(s=>frames.some(r=>finite(s.read(r)))),points=frames.flatMap(r=>valid.map(s=>s.read(r)).filter(finite));
 if(!points.length){box.append(el('div','empty','等待有效采样 · 缺失值保留断点'));return box;}
 const [lo,hi]=motorPlotRange(points,unit),end=frames.at(-1).time,start=Math.max(end-30,frames[0].time),span=Math.max(1,end-start),g=svg('svg',{viewBox:'0 0 600 155',role:'img','aria-label':title+'趋势'});
 for(const y of [18,73,128])line(g,48,y,590,y,'#e3ebe5',1);label(g,0,20,fmt(hi),{'font-size':10});label(g,0,130,fmt(lo),{'font-size':10});
 for(const s of valid){let d='',active=false;for(const row of frames){if(row.time<start)continue;const v=s.read(row);if(!finite(v)){active=false;continue;}d+=(active?'L':'M')+(48+(row.time-start)/span*542).toFixed(1)+','+(128-(v-lo)/(hi-lo)*110).toFixed(1);active=true;}g.append(svg('path',{d,fill:'none',stroke:s.color,'stroke-width':2,...(s.dash?{'stroke-dasharray':'6 4'}:{})}));}
 label(g,48,150,'最近 '+Math.min(30,span).toFixed(1)+' s → 当前',{'font-size':10});box.append(g);const legend=el('div','motor-plot-legend');for(const s of valid){const n=el('span','',s.name);n.style.color=s.color;legend.append(n);}box.append(legend);return box;
}

export class MotionDashboard {
 constructor(root,state,motors,hooks){this.root=root;this.state=state;this.motors=motors;this.hooks=hooks;this.reset();}
 reset(name,shared=true){this.motorInteraction=null;if(name){this.frames[name]=[];this.events[name]=[];delete this.previous[name];if(name==='vehicle'||shared){this.vehicleHeading=new VehicleHeading();this.frames.vehicle=[];this.events.vehicle=[];delete this.previous.vehicle;}}else{this.vehicleHeading=new VehicleHeading();this.frames={gimbal:[],chassis:[],vehicle:[]};this.events={gimbal:[],chassis:[],vehicle:[]};this.previous={};}}
 pause(){this.vehicleHeading.interrupt();}
 paths(){return motionMotorPaths(this.state.modules,this.motors.catalog);}
 watch(name,key){const path=this.state.modules[name].bindings[key],w=this.state.watches.find(w=>w.path===path);
  const value=w?.valid&&!w.error&&w.lastTime&&(finite(w.value)||typeof w.value==='boolean')?Number(w.value)*w.scale:null;
  return {bound:!!path,value:typeof value==='number'?value:null,unit:w?.unit||this.state.modules[name].angleUnit,path,error:w?.error||'',time:w?.lastTime||0};}
 angle(name,key){const v=this.watch(name,key);return {...v,value:angleRadians(v.value,v.unit)};}
 motor(path,time){const m=this.motors.latest.get(path);return time===undefined||m?.time===time?m:undefined;}
 snapshot(name,time){const config=this.state.modules[name];
  if(name==='vehicle')return {gimbal:this.snapshot('gimbal',time),chassis:this.snapshot('chassis',time),enabled:null};
  if(name==='gimbal'){const axes={};for(const {id:key,axis} of slots(config,'gimbal')){const a=this.angle(name,key),t=this.angle(name,key+'Target'),s=this.angle(name,key+'Speed');axes[key]=axisState(config.axes[key],this.motor(config.axes[key].motor,time),{angleBound:a.bound,angle:a.value,targetBound:t.bound,target:t.value,speedBound:s.bound,speed:s.value},Math.abs(axis[2])>.95&&config.yawWrap);}return {...axes,config,enabled:this.watch(name,'enabled').value,mode:this.watch(name,'mode').value};}
  const wheels={};for(const {id:key}of slots(config,'chassis'))for(const cfg of [config.wheels[key]]){const m=this.motor(cfg.motor,time),f=m?motorFields(m):{},s=m?motorState(m):{},speed=f[m?.family==='DJI'?'state_.output_shaft_omega':'state_.omega'];wheels[key]={motor:m,speed:finite(speed)?cfg.sign*speed/cfg.ratio:null,target:finite(s.omegaTarget)?cfg.sign*s.omegaTarget/cfg.ratio:null};}
  // An offline wheel is not evidence of body motion. Never extrapolate missing wheels.
  const estimate=estimateChassis(config,Object.fromEntries(Object.entries(wheels).map(([k,v])=>[k,v.motor?.status==='online'?v.speed:null])));
  const targetEstimate=estimateChassis(config,Object.fromEntries(Object.entries(wheels).map(([k,v])=>[k,v.target])));
  const body={},target={},sources={},targetSources={};for(const key of ['vx','vy','omega']){const v=key==='omega'?this.angle(name,key):this.watch(name,key),t=key==='omega'&&config.commandUnits!=='setSpeed'?this.angle(name,key+'Target'):this.watch(name,key+'Target');body[key]=v.bound?v.value:estimate?.[key]??null;target[key]=t.bound?t.value:targetEstimate?.[key]??null;sources[key]=v.bound?'变量实测':'轮速推算';targetSources[key]=t.bound?'变量指令':'轮目标推算';}
  if(config.commandUnits==='setSpeed'){const converted=setSpeedToBody(target,config);for(const key of ['vx','vy','omega'])if(config.bindings[key+'Target']){target[key]=converted[key];targetSources[key]='SetSpeed 指令换算';}}
  return {wheels,body,target,sources,targetSources,heading:this.angle(name,'heading').value,enabled:this.watch(name,'enabled').value};
 }
 ingest(time){for(const name of ['gimbal','chassis','vehicle']){if(!this.state.modules[name].enabled)continue;const frame={time,...this.snapshot(name,time)};
  if(name==='vehicle'){const target=this.angle('vehicle','headingTarget'),headings=this.vehicleHeading.update(time,frame.chassis,{measured:!!this.state.modules.chassis.bindings.heading,targetBound:target.bound,targetValue:target.value});frame.pose=composeVehiclePose(frame.gimbal,frame.chassis,this.state.modules.vehicle,headings);}
  this.frames[name].push(frame);while(this.frames[name].length&&(this.frames[name].length>600||time-this.frames[name][0].time>60))this.frames[name].shift();
  const cfg=this.state.modules[name],messages=[];if(frame.enabled!==null)messages.push(frame.enabled?'控制使能':'控制失能');
  if(name==='vehicle'){if(frame.pose.broken||frame.pose.targetBroken)messages.push('相对航向连续性中断，请重置');if(!frame.pose.feedbackDirection)messages.push('反馈姿态不完整');if(!frame.pose.targetDirection)messages.push('目标姿态不完整');if(finite(frame.pose.pointingError)&&deg(frame.pose.pointingError)>this.state.modules.gimbal.tolerance)messages.push('合成瞄向偏差超过阈值');}
  if(name==='gimbal'){if(frame.mode!==null)messages.push('模式 '+frame.mode);for(const {id:key}of slots(cfg,'gimbal')){const a=frame[key];if(a.outside)messages.push(key+' 超出配置限位');if(finite(a.error)&&Math.abs(deg(a.error))>cfg.tolerance)messages.push(key+' 跟踪偏差超过 '+cfg.tolerance+'°');}}
  for(const [key,slot]of Object.entries(this.motorSlots(name))){const m=this.motorSample(frame,name,key)?.motor;if(!slot.motor)continue;messages.push(key+': '+(m?({online:'在线',offline:'反馈超时',waiting:'无心跳',unknown:'时钟未知',error:'读取失败'}[m.status]||'未知'):'等待采集'));const f=m?motorState(m):{};if(f.fault)messages.push(key+': '+f.fault);if(m&&motorFields(m)['state_.enable']===false)messages.push(key+': 电机失能');}
  const signature=messages.join(' · ')||'等待完整绑定';if(signature!==this.previous[name]){this.events[name].unshift({time,text:signature});this.events[name]=this.events[name].slice(0,80);this.previous[name]=signature;}
 }}
 activeSlots(name){const cfg=this.state.modules[name];return Object.fromEntries(slots(cfg,name).map(s=>[s.id,cfg[name==='gimbal'?'axes':'wheels'][s.id]]));}
 motorSlots(name){return name==='vehicle'?Object.fromEntries([...Object.entries(this.activeSlots('gimbal')).map(([k,v])=>['gimbal:'+k,v]),...Object.entries(this.activeSlots('chassis')).map(([k,v])=>['chassis:'+k,v])]):this.activeSlots(name);}
 motorKey(key,kind){return this.name==='vehicle'?kind+':'+key:key;}
 motorSample(data,name,key){if(name==='vehicle'){const [kind,id]=key.split(':');return kind==='gimbal'?data.gimbal[id]:data.chassis.wheels[id];}return name==='gimbal'?data[key]:data.wheels[key];}
 buildSettings(name){const config=this.state.modules[name],settings=el('details','motion-settings');settings.append(el('summary','',(name==='gimbal'?'云台': '底盘')+'构型、电机映射与坐标标定'));const grid=el('div','motion-config-grid');settings.append(grid);
  const change=(target,key,value)=>{target[key]=value;const frameChanged=name==='gimbal'&&!supportsWorldGimbal(config)&&this.state.modules.vehicle.gimbalFrame==='world';if(frameChanged)this.state.modules.vehicle.gimbalFrame='body';this.reset(name);this.hooks.changed();this.hooks.controls();if(frameChanged){this.configure(this.name);this.hooks.reconfigure?.();}else this.render();};
  const select=(parent,title,target,key,options)=>{const l=el('label','',title),s=el('select');s.setAttribute('aria-label',title);for(const [v,title]of options){const o=el('option','',title);o.value=v;s.append(o);}s.value=target[key];s.onchange=()=>change(target,key,s.value);l.append(s);parent.append(l);return s;};
  const numeric=(parent,title,target,key,min,max,step='any')=>{const l=el('label','',title),input=el('input');input.type='number';Object.assign(input,{min,max,step,value:target[key]});input.setAttribute('aria-label',title);input.onchange=()=>{const v=Number(input.value);if(!input.value||!Number.isFinite(v)||v<min||v>max||(key==='min'&&v>=target.max)||(key==='max'&&v<=target.min)){input.value=target[key];this.hooks.error('请输入有效范围内的数值；角度下限必须小于上限。');return;}change(target,key,v);};l.append(input);parent.append(l);};
  select(grid,'自定义角度 / 角速度默认单位',config,'angleUnit',[['rad','rad / rad/s'],['deg','deg / deg/s']]);
  ensureSlots(config,name);const chosen=mechanism(config,name),builtin=mechanismLibrary[name].find(m=>JSON.stringify(m)===JSON.stringify(chosen));
  const modelSelect=select(grid,name==='gimbal'?'云台构型':'底盘构型',{model:builtin?.id||'current-custom'},'model',[
   ...mechanismLibrary[name].map(m=>[m.id,m.name]),...(!builtin?[['current-custom','自定义 · '+chosen.name]]:[])]);
  const applyModel=model=>{selectMechanism(config,name,model);if(name==='chassis'&&model.adapter!=='uicrm-four')config.commandUnits='si';if(name==='gimbal'&&!supportsWorldGimbal(config))this.state.modules.vehicle.gimbalFrame='body';this.reset(name);this.hooks.changed();this.configure(this.name);this.hooks.reconfigure?.();};
  modelSelect.onchange=()=>{const model=mechanismLibrary[name].find(m=>m.id===modelSelect.value);if(model)applyModel(model);};
  const editor=el('details','mechanism-editor');editor.append(el('summary','','编辑 / 复用构型 JSON'));
  const json=el('textarea','mechanism-json');json.value=JSON.stringify(chosen,null,2);json.setAttribute('aria-label',(name==='gimbal'?'云台':'底盘')+'构型 JSON');json.rows=14;
  const apply=el('button','button','应用构型 JSON');apply.onclick=()=>{try{applyModel(validateMechanism(JSON.parse(json.value),name));}catch(error){this.hooks.error(error.message);}};
  editor.append(el('p','hint','模板只定义机构与解算方式；电机、变量和标定单独保存。通用模板尺寸需按实物调整。复制 JSON 可复用到其他 ELF；导出配置会包含当前构型。'),json,apply);settings.append(editor);
  if(name==='gimbal')for(const [group,title,limit]of [['position','安装位置 mm',100000],['rotation','安装旋转 °',36000]])for(const [i,axis]of ['X 前','Y 左','Z 上'].entries())numeric(grid,title+' / '+axis,config.mount[group],i,-limit,limit);
  if(name==='gimbal'){numeric(grid,'跟踪偏差提示阈值 °',config,'tolerance',.01,180);const l=el('label','check'),check=el('input');check.type='checkbox';check.checked=config.yawWrap;check.setAttribute('aria-label','Yaw 使用最短角差');check.onchange=()=>change(config,'yawWrap',check.checked);l.append(check,document.createTextNode('Yaw 使用最短角差（可跨 ±180°）'));grid.append(l);}
  else{numeric(grid,'轮半径 m',config,'radius',.001,2);numeric(grid,'半轴距 m',config,'halfLength',.001,5);numeric(grid,'半轮距 / matrix 旋转基准 m',config,'halfWidth',.001,5);numeric(grid,'速度箭头满量程 m/s',config,'vectorScale',.01,100);if(chosen.adapter==='uicrm-four')numeric(grid,'旋转中心偏移 chassis.offset',config,'offset',-1,1);select(grid,'自定义指令单位',config,'commandUnits',[['si','物理量 m/s、rad/s'],...(chosen.adapter==='uicrm-four'?[['setSpeed','仓库 Chassis::SetSpeed 原始量']]:[])]);}
  const scan=el('button','button','扫描 / 刷新电机');scan.onclick=()=>this.hooks.scan();settings.append(scan);
  const rows=el('div','motion-mappings');for(const [key,slot]of Object.entries(this.activeSlots(name))){const row=el('div','motion-mapping');row.append(el('h3','',slotLabel(config,name,key)));const fields=el('div','motion-config-grid');const options=[['','不绑定电机，仅使用变量'],...this.motors.catalog.map(m=>[m.path,(m.bus?m.bus+' · ':'')+m.path])];if(slot.motor&&!options.some(([v])=>v===slot.motor))options.push([slot.motor,slot.motor+'（未发现）']);
   const s=select(fields,(slotLabel(config,name,key))+' 电机',slot,'motor',options);s.onchange=()=>{if(name==='chassis'&&s.value&&Object.values(this.activeSlots('chassis')).some(v=>v!==slot&&v.motor===s.value)){s.value=slot.motor;this.hooks.error('同一个电机不能重复绑定到多个车轮。');return;}change(slot,'motor',s.value);};
   const direction=select(fields,(slotLabel(config,name,key))+' 电机正方向',slot,'sign',[['1','同向 +1'],['-1','反向 −1']]);direction.onchange=()=>change(slot,'sign',Number(direction.value));numeric(fields,key+' 额外减速比',slot,'ratio',.0001,100000);
   if(name==='gimbal'){numeric(fields,key+' 电机零点 °',slot,'zero',-360000,360000);numeric(fields,key+' 物理下限 °',slot,'min',-360000,360000);numeric(fields,key+' 物理上限 °',slot,'max',-360000,360000);}
   row.append(fields);rows.append(row);
  }settings.append(rows,el('p','hint',name==='gimbal'?'电机姿态 = 正方向 × 输出轴角度 ÷ 额外减速比 − 零点。目标同样变换。自定义变量优先，使用已选变量的倍率 / 单位；它们应已标定到同一参考系，不再套电机零点。IMU 反馈应绑定对应 IMU 目标；不会自动把编码器目标当作 IMU 目标。':'仓库坐标：+vx 向右、+vy 向前、+vt 俯视顺时针。matrix 模板按 drive 矩阵推算，缺少可观测分量时保留空值。四轮仓库模板 FL / FR / BL / BR 对应 front_left / front_right / back_left / back_right。正方向默认保留仓库电机原始正负号；DJI 输出轴速度已包含驱动减速比。使用仓库四轮模板且绑定 chassis_vx / vy / vt 时选择 SetSpeed 原始量，它们是限幅前的轮速混合量，不能直接标成 m/s。Omni 为四角切向布局；航向角仍为逆时针正，用于和云台合成。'));
  if(this.name==='vehicle'){const fields=el('div','motion-config-grid');for(const [field,title]of Object.entries(bindingFields(config,name,moduleDefinitions[name].fields))){const l=el('label','',title),s=el('select');s.setAttribute('aria-label','整车 '+name+' '+field+'绑定');for(const [value,text]of [['','自动使用绑定电机 / 未绑定'],...this.state.watches.map(w=>[w.path,w.label+' · '+w.path])]){const o=el('option','',text);o.value=value;s.append(o);}s.value=config.bindings[field];s.onchange=()=>change(config.bindings,field,s.value);l.append(s);fields.append(l);}settings.append(el('h3','','自定义变量（共享原模块绑定）'),fields);}
  return settings;
 }
 configure(name){this.name=name;this.root.replaceChildren();
  if(name==='vehicle'){
   const settings=el('details','motion-settings');settings.open=true;settings.append(el('summary','','整车参考系与相对航向'));const field=el('label','field-label','云台 Yaw 反馈与目标的参考系'),select=el('select');select.setAttribute('aria-label','整车云台参考系');
   for(const [value,text]of [['body','相对底盘（关节角）'],...(supportsWorldGimbal(this.state.modules.gimbal)?[['world','常规双轴世界坐标（IMU，同一航向零点）']]:[])]){const o=el('option','',text);o.value=value;select.append(o);}select.value=this.state.modules.vehicle.gimbalFrame;select.onchange=()=>{this.state.modules.vehicle.gimbalFrame=select.value;this.reset('vehicle');this.hooks.changed();this.render();};field.append(select);settings.append(field,el('p','hint','有底盘 heading 绑定时使用实测航向；否则积分角速度为从 0 开始的相对航向。云台和底盘设置在各页共享，开关相互独立。'));
   const unitLabel=el('label','field-label','底盘目标航向默认单位（变量未填单位时）'),unit=el('select');unit.setAttribute('aria-label','整车目标航向默认单位');for(const value of ['rad','deg']){const o=el('option','',value);o.value=value;unit.append(o);}unit.value=this.state.modules.vehicle.angleUnit;unit.onchange=()=>{this.state.modules.vehicle.angleUnit=unit.value;this.reset('vehicle');this.hooks.changed();this.render();};unitLabel.append(unit);settings.append(unitLabel);
   const reset=el('button','button subtle','重置相对航向 / 开始新的对照');reset.onclick=()=>{this.reset('vehicle');this.render();};settings.append(reset);this.root.append(settings,this.buildSettings('gimbal'),this.buildSettings('chassis'));
  }else this.root.append(this.buildSettings(name));
  this.visual=el('div','motion-content');this.root.append(this.visual);this.motorInteraction=null;
  const wheelAt=event=>event.target.closest?.('[data-motor]');
  this.visual.onpointermove=event=>{if(this.motorInteraction?.mode==='pinned')return;const wheel=wheelAt(event);
   if(wheel)this.motorInteraction={key:wheel.dataset.motor,mode:'pointer',x:event.clientX,y:event.clientY};
   else if(this.motorInteraction?.mode==='pointer')this.motorInteraction=null;this.updateMotorTooltip();};
  this.visual.onpointerleave=()=>{if(this.motorInteraction?.mode==='pointer'){this.motorInteraction=null;this.updateMotorTooltip();}};
  this.visual.onfocusin=event=>{if(this.rendering||this.motorInteraction?.mode==='pinned')return;const wheel=wheelAt(event);if(wheel){this.motorInteraction={key:wheel.dataset.motor,mode:'focus'};this.updateMotorTooltip();}};
  this.visual.onfocusout=()=>{if(!this.rendering&&this.motorInteraction?.mode==='focus'){this.motorInteraction=null;this.updateMotorTooltip();}};
  const toggle=wheel=>{this.motorInteraction=this.motorInteraction?.key===wheel.dataset.motor&&this.motorInteraction.mode==='pinned'?null:{key:wheel.dataset.motor,mode:'pinned'};this.updateMotorTooltip();};
  this.visual.onclick=event=>{const wheel=wheelAt(event);if(wheel)toggle(wheel);else if(this.motorInteraction?.mode==='pinned'){this.motorInteraction=null;this.updateMotorTooltip();}};
  this.visual.onkeydown=event=>{const wheel=wheelAt(event);if(event.key==='Escape'){event.preventDefault();this.motorInteraction=null;this.updateMotorTooltip();}else if(wheel&&['Enter',' '].includes(event.key)){event.preventDefault();toggle(wheel);}};
  this.render();
 }
 render(){const name=this.state.page;if(!['gimbal','chassis','vehicle'].includes(name)||!this.state.modules[name].enabled||!this.visual)return;const cfg=this.state.modules[name],frames=this.frames[name],sample=frames.at(-1),data=sample||this.snapshot(name),stale=!this.state.running||!sample||Date.now()/1000-sample.time>2;
  if(name==='vehicle'&&!data.pose)data.pose=composeVehiclePose(data.gimbal,data.chassis,cfg,{heading:null,headingTarget:null,measured:!!this.state.modules.chassis.bindings.heading,targetBound:!!cfg.bindings.headingTarget});
  const focusedMotor=this.visual.contains(document.activeElement)?document.activeElement.dataset?.motor:null;this.rendering=true;
  this.motorFrame={data,stale,time:sample?.time};
  const scroll=this.visual.querySelector('.motion-event-list')?.scrollTop||0;this.visual.replaceChildren();const banner=el('div','motion-status'+(stale?' stale':''),(sample?(stale?'历史状态 / 暂停或超过 2 秒未更新':'真实采样 · '+new Date(sample.time*1000).toLocaleTimeString()):'等待采集 · 图形仅显示参考坐标')+' · '+(name==='vehicle'?'整车联合采样':data.enabled===null?'控制使能未绑定':data.enabled?'控制已使能':'控制已失能'));this.visual.append(banner);
  if(name==='gimbal')this.renderGimbal(data,cfg,frames);else if(name==='vehicle')this.renderVehicle(data,cfg,frames);else this.renderChassis(data,cfg,frames);
  const issues=panel('状态检查与事件','记录采样中观察到的变化，不替代固件故障检测'),diagnosis=el('div','motion-diagnosis');if(stale)note(diagnosis,'当前显示历史值，姿态与运动方向已冻结。');
  for(const [key,slot]of Object.entries(this.motorSlots(name))){if(!slot.motor){note(diagnosis,key+' 未绑定电机：在线、使能、输出与故障状态不可用。');continue;}const m=this.motorSample(data,name,key)?.motor;if(!m){note(diagnosis,key+'：'+slot.motor+' 尚无采样。');continue;}const d=motorState(m),f=motorFields(m);if(m.status!=='online')note(diagnosis,key+'：'+(m.error||m.status)+' · 检查电源 / CAN / 心跳。',true);if(d.fault)note(diagnosis,key+'：'+d.fault,true);if(f['state_.enable']===false)note(diagnosis,key+'：电机软件失能。',true);const out=f.output_,limit=f.max_raw_current_;if(finite(out)&&finite(limit)&&limit>0&&Math.abs(out)>=.98*limit)note(diagnosis,key+'：输出接近固件电流限制，结合目标误差与负载检查。',true);}
  for(const source of name==='vehicle'?['gimbal','chassis','vehicle']:[name])for(const [key,path]of Object.entries(this.state.modules[source].bindings))if(path){const w=this.watch(source,key);if(w.error||w.value===null)note(diagnosis,source+'.'+key+'：'+(w.error||'绑定字段无有效采样')+' · '+path,true);}
  if(name==='gimbal'){if(data.mode!==null)note(diagnosis,'控制模式（原始枚举）= '+data.mode);for(const {id:key}of slots(cfg,'gimbal')){const a=data[key];if(a.outside)note(diagnosis,key+' 超出配置物理限位 ['+cfg.axes[key].min+', '+cfg.axes[key].max+']°。',true);if(finite(a.error)&&Math.abs(deg(a.error))>cfg.tolerance)note(diagnosis,key+' 跟踪偏差 '+fmt(deg(a.error))+'° 超过提示阈值；对照趋势、电机模式与输出排查。',true);}}
  else if(name==='chassis'){note(diagnosis,'轮速推算基于所选构型的理想无滑移模型，不能判断打滑或位移；缺轮或离线时停止推算。chassis_vx / vy / vt 是限幅前控制指令，四轮仓库模板可绑定到指令栏并选择 SetSpeed 原始量，其他构型请先换算为物理量。限幅 / 功率限制可能使轮目标与原始指令不同。');for(const key of Object.keys(data.wheels)){const w=data.wheels[key];if(finite(w.speed)&&finite(w.target)&&Math.abs(w.speed-w.target)>Math.max(1,Math.abs(w.target)*.2))note(diagnosis,slotLabel(cfg,'chassis',key)+' 速度偏差较大：'+fmt(w.target-w.speed)+' rad/s，检查轮序、方向、控制模式与输出。',true);}}
  else{const pose=data.pose;note(diagnosis,'模型：水平底盘 + '+mechanism(this.state.modules.gimbal,'gimbal').name+'。电机可还原关节姿态和理想轮速，无法测出真实侧倾、底盘俯仰、打滑或绝对位置。');
   if(pose.broken||pose.targetBroken)note(diagnosis,'航向积分连续性中断（暂停、缺失数据或采样间隔超过 1 秒），请重置相对航向后重新对照。',true);
   if(!pose.feedbackDirection)note(diagnosis,'反馈姿态不完整：检查底盘航向、云台所有关节反馈与在线状态。',true);
   if(!pose.targetDirection)note(diagnosis,'目标姿态不完整：角度目标须处于角度控制模式，或显式绑定同参考系目标。');
   if(finite(pose.pointingError)&&deg(pose.pointingError)>this.state.modules.gimbal.tolerance)note(diagnosis,'合成瞄向偏差 '+fmt(deg(pose.pointingError))+'°，超过云台阈值；结合底盘航向误差与各关节误差定位。',true);
   if(cfg.gimbalFrame==='world'&&!pose.measured)note(diagnosis,'世界坐标云台需要与底盘同一航向零点；当前底盘为相对推算，请绑定同参考系实测 heading。',true);
  }
  issues.append(diagnosis);const list=el('div','motion-event-list');for(const e of this.events[name].slice(0,25))list.append(el('div','motor-event',new Date(e.time*1000).toLocaleTimeString()+' · '+e.text));if(!list.children.length)list.append(el('p','hint','采集后记录状态变化。'));issues.append(list);this.visual.append(issues);list.scrollTop=scroll;
  for(const n of this.root.querySelectorAll('input,select,button,textarea'))n.disabled=this.state.busy||!this.state.sha;
  if(focusedMotor)this.visual.querySelector('[data-motor="'+focusedMotor+'"]')?.focus({preventScroll:true});
  this.rendering=false;this.updateMotorTooltip();
 }
 updateMotorTooltip(){
  if(!this.visual)return;let tip=this.visual.querySelector('.wheel-tooltip');
  for(const node of this.visual.querySelectorAll('[data-motor]')){const active=node.dataset.motor===this.motorInteraction?.key;node.classList.toggle('wheel-active',active);if(active)node.setAttribute('aria-describedby','motion-motor-tooltip');else node.removeAttribute('aria-describedby');}
  if(!['gimbal','chassis','vehicle'].includes(this.state.page)||!this.motorInteraction||!this.motorFrame){tip?.remove();return;}
  const {key,mode}=this.motorInteraction,name=this.state.page,wheel=this.motorSample(this.motorFrame.data,name,key),cfg=this.motorSlots(name)[key],isAxis=name==='gimbal'||name==='vehicle'&&key.startsWith('gimbal:'),id=name==='vehicle'?key.split(':')[1]:key,kind=isAxis?'gimbal':'chassis';
  if(!wheel)return;if(!tip){tip=el('aside','wheel-tooltip');tip.id='motion-motor-tooltip';tip.setAttribute('role','tooltip');this.visual.append(tip);}tip.replaceChildren();
  tip.append(el('strong','wheel-tooltip-title',slotLabel(this.state.modules[isAxis?'gimbal':'chassis'],isAxis?'gimbal':'chassis',id)+' · 电机数据'),el('code','wheel-tooltip-path',cfg.motor||'未绑定电机'));
  const {stale,time}=this.motorFrame;tip.append(el('div','wheel-tooltip-sample'+(stale?' stale':''),time?(stale?'历史值 / 暂停或超时 · ':'实时采样 · ')+new Date(time*1000).toLocaleTimeString():'等待采集'));
  if(!cfg.motor)tip.append(el('p','hint',isAxis?'请在构型设置中绑定此轴电机。':'请在构型设置中绑定此轮电机。'));
  else if(!wheel.motor)tip.append(el('p','hint','尚无本帧电机数据。'));
  else{const m=wheel.motor;tip.append(el('div','wheel-tooltip-meta',[m.family,m.bus,m.rxId==null?'':'RX 0x'+m.rxId.toString(16).toUpperCase()].filter(Boolean).join(' · ')));
   const list=el('dl','wheel-tooltip-values'),rows=wheelMotorDetails(wheel);
   if(isAxis){const f=motorFields(m),rawSpeed=f[m.family==='DJI'?'state_.output_shaft_omega':'state_.omega'];rows[4]=['输出轴 ω',fmt(rawSpeed)+' rad/s'];rows.splice(5,0,['姿态反馈 / 目标',fmt(deg(wheel.angle))+' / '+fmt(deg(wheel.target))+'°'],['跟踪误差',fmt(deg(wheel.error))+'°']);tip.append(el('p','hint',wheel.source+' · '+(this.state.modules.gimbal.bindings[id]||cfg.motor)));}
   for(const [title,value]of rows)list.append(el('dt','',title),el('dd','',value));tip.append(list);
   if(m.error)tip.append(el('p','error',m.error));if(Object.keys(m.fieldErrors||{}).length)tip.append(el('p','error','部分字段读取失败：'+Object.keys(m.fieldErrors).join('、')));
  }
  tip.append(el('div','wheel-tooltip-help',mode==='pinned'?'已固定 · 再次点击或 Esc 关闭':'悬停查看 · 点击固定 · Esc 关闭'));
  const target=this.visual.querySelector('[data-motor="'+key+'"]'),rect=target?.getBoundingClientRect();
  const x=mode==='pointer'?this.motorInteraction.x:rect?.right??16,y=mode==='pointer'?this.motorInteraction.y:rect?.top??16;
  const width=tip.offsetWidth,height=tip.offsetHeight;tip.style.left=Math.max(8,Math.min(x+16,window.innerWidth-width-8))+'px';tip.style.top=Math.max(8,Math.min(y+12,window.innerHeight-height-8))+'px';
 }
 renderGimbal(data,cfg,frames){
  const model=mechanism(cfg,'gimbal'),feedback=solveGimbal(cfg,data),target=solveGimbal(cfg,data,'target'),reference=solveGimbal(cfg,data,'angle',{reference:true});
  const p=panel('云台姿态 / '+model.name,'绿色：反馈 · 橙色：目标 · 灰色虚线：零姿态 / 车头'),layout=el('div','gimbal-view');
  const g=svg('svg',{viewBox:'0 0 600 420',role:'group','aria-label':'云台关节联合姿态图，悬停关节查看电机'}),point=(x,y,z=0)=>projectGimbal([x,y,z]);
  for(let n=-160;n<=160;n+=40){line(g,...point(n,-160),...point(n,160),'#edf2ee',1);line(g,...point(-160,n),...point(160,n),'#edf2ee',1);}
  g.append(svg('polygon',{points:[[-70,-65],[70,-65],[70,65],[-70,65]].map(([x,y])=>point(x,y).join(',')).join(' '),fill:'#eaf2ed',stroke:'#b5cbbb'}));
  arrow(g,...point(0,0),...point(174,0),blue);const front=point(174,0);label(g,front[0]-50,front[1]-12,'车头 / +vy / 零朝向',{'font-size':11,fill:blue});
  line(g,...point(0,0),...point(0,0,56),'#afc7b7',18);
  drawMechanism(g,{feedback,target,reference,states:data,project:projectGimbal});
  label(g,28,30,model.name,{'font-size':14,'font-weight':600,fill:green});
  label(g,28,53,'零姿态朝车头 · +Yaw 左转 · +Pitch 抬头 · 悬停任意关节查看电机',{'font-size':11});
  const missing=slots(cfg,'gimbal').filter(j=>!finite(data[j.id]?.angle)).map(j=>j.label+' 无反馈');
  label(g,28,389,feedback.complete?'按关节层级合成最终瞄向；灰色为零姿态参考':'姿态不完整：'+(missing.join(' · ')||'电机反馈离线'),{'font-size':12,fill:feedback.complete?green:'#ad7d68'});
  layout.append(g);const readings=el('div','gimbal-readouts');
  const compass=svg('svg',{class:'yaw-compass',viewBox:'0 0 224 220'});yawOverview(compass,'',0,feedback.yaw,target.yaw,feedback.yaw);readings.append(compass);
  for(const {id:key,label:title,axis}of slots(cfg,'gimbal')){const a=data[key],card=el('div','gimbal-axis-reading');card.append(el('h3','',title));
   const wrap=cfg.yawWrap&&Math.abs(axis[2])>.95,display=v=>wrap&&finite(v)?wrapAngle(v):v;
   const readout=el('div','pose-readout');readout.append(el('strong','',fmt(deg(display(a.angle)))+'°'),el('span','','目标 '+fmt(deg(display(a.target)))+'° · 误差 '+fmt(deg(a.error))+'°'));card.append(readout);
   if(wrap)card.append(el('p','hint','方位显示 ±180°；累计角 '+fmt(deg(a.angle))+'°，原始值保留在曲线和电机窗。'));
   card.append(el('p','axis-motion',finite(a.speed)?(Math.abs(a.speed)<.01?'近静止':a.speed>0?'沿配置轴正转':'沿配置轴反转')+' · '+fmt(deg(a.speed))+' °/s':'转速未绑定'));
   card.append(el('p','hint',a.source+' · '+(cfg.bindings[key]||cfg.axes[key].motor||'未绑定')),el('p','hint','限位 '+cfg.axes[key].min+'° ~ '+cfg.axes[key].max+'°'));
   if(a.outside)card.append(el('p','error','超出配置限位'));
   if(a.motor){const f=motorFields(a.motor),status=el('div','axis-status');status.append(el('span','motor-badge '+(a.motor.status==='online'?'good':'bad'),a.motor.status==='online'?'CAN 在线':a.motor.status),el('span','',a.control.mode+' · '+(f['state_.enable']==null?'使能未知':f['state_.enable']?'电机使能':'电机失能')));if(finite(f.output_))status.append(el('span','','output '+fmt(f.output_)+' raw'));card.append(status);}readings.append(card);
  }
  layout.append(readings);p.append(layout);this.visual.append(p);const plots=el('div','motion-plots');for(const {id:key,label:title}of slots(cfg,'gimbal'))plots.append(seriesPlot(title+' 目标与反馈','deg',frames,[{name:'反馈',color:green,read:r=>deg(r[key].angle)},{name:'目标',color:amber,dash:true,read:r=>deg(r[key].target)}]),seriesPlot(title+' 跟踪误差','deg',frames,[{name:'目标 − 反馈',color:blue,read:r=>deg(r[key].error)}]));this.visual.append(plots);
 }
 renderVehicle(data,cfg,frames){
  const {pose,gimbal,chassis}=data,aligned=cfg.gimbalFrame==='body'||pose.measured;
  const h=aligned?pose.heading:null,ht=aligned?pose.headingTarget:null;
  const p=panel('整车姿态 / 底盘 × 云台','绿色实线：反馈 · 橙色虚线：目标 · 悬停关节 / 车轮查看电机'),layout=el('div','vehicle-view');
  const g=svg('svg',{viewBox:'0 0 700 500',role:'group','aria-label':'云台与底盘整车姿态图，所有电机可悬停查看数据'});
  const yawZ=146;
  const project=([x,y,z=0])=>[350+.95*x-.78*y,335-.34*x-.42*y-.95*z];
  const world=(x,y,z=0,heading=0)=>project([x*Math.cos(heading)-y*Math.sin(heading),x*Math.sin(heading)+y*Math.cos(heading),z]);
  const segment=(a,b,color=green,width=2,dash=false)=>line(g,...a,...b,color,width,dash);
  const polygon=(parent,points,fill,stroke,width=2,dash=false)=>parent.append(svg('polygon',{points:points.map(v=>v.join(',')).join(' '),fill,stroke,'stroke-width':width,...(dash?{'stroke-dasharray':'7 5'}:{})}));
  for(let n=-160;n<=160;n+=40){segment(world(n,-160),world(n,160),'#edf2ee',1);segment(world(-160,n),world(160,n),'#edf2ee',1);}
  for(const [x,y,text]of [[215,0,'参考前 +Y₀'],[0,-215,'参考右 +X₀']]){arrow(g,...world(0,0),...world(x,y),'#afc5b7');const [tx,ty]=world(x,y);label(g,tx-24,ty-10,text,{'font-size':11});}
  const corners=mechanism(this.state.modules.chassis,'chassis').outline||[[-100,-76],[100,-76],[100,76],[-100,76]];
  if(finite(ht))polygon(g,corners.map(([x,y])=>world(x,y,36,ht)),'none',amber,3,true);
  const bodyHeading=finite(h)?h:0,bodyColor=finite(h)?green:'#aab9af';
  for(const side of corners.map((_,i)=>[i,(i+1)%corners.length])){const a=corners[side[0]],b=corners[side[1]];polygon(g,[world(...a,8,bodyHeading),world(...b,8,bodyHeading),world(...b,35,bodyHeading),world(...a,35,bodyHeading)],'#e0ebe3','#c1d4c7',1);}
  polygon(g,corners.map(([x,y])=>world(x,y,35,bodyHeading)),finite(h)?'#eaf2ed':'#f0f2f0',bodyColor);
  const wheels=wheelGeometry(this.state.modules.chassis);
  for(const [key,{x,y,angle:rotate,roller}]of Object.entries(wheels)){
   const w=chassis.wheels[key],motor=w.motor,color=motor?.status==='online'?green:motor?.status==='offline'?'#bf6b5a':'#a9b9ae';
   const wheel=svg('g',{class:'chassis-wheel','data-motor':this.motorKey(key,'chassis'),tabindex:0,role:'button','aria-label':slotLabel(this.state.modules.chassis,'chassis',key)+' 电机数据，点击或按回车固定'});
   const wp=(dx,dy,z)=>world(x+dx*Math.cos(rotate)-dy*Math.sin(rotate),y+dx*Math.sin(rotate)+dy*Math.cos(rotate),z,bodyHeading);
   const center=wp(0,0,18);wheel.append(svg('rect',{x:center[0]-32,y:center[1]-30,width:64,height:60,rx:10,fill:'transparent',class:'wheel-hitbox'}));
   polygon(wheel,[wp(-31,-13,5),wp(31,-13,5),wp(31,-13,28),wp(-31,-13,28)],'#dce9e0',color);
   polygon(wheel,[wp(-31,-13,28),wp(31,-13,28),wp(31,13,28),wp(-31,13,28)],'#fff',color);
   for(let n=-20;n<=20;n+=10){const slant=roller*6;line(wheel,...wp(n-slant,-10,29),...wp(n+slant,10,29),color,1);}
   wheel.setAttribute('data-wheel-angle',rotate);wheel.setAttribute('data-wheel-x',x);wheel.setAttribute('data-wheel-y',y);
   label(wheel,center[0]-9,center[1]+32,key.toUpperCase(),{'font-size':11,fill:color,'font-weight':600});g.append(wheel);
  }
  arrow(g,...world(0,0,38,bodyHeading),...world(92,0,38,bodyHeading),bodyColor);
  const front=world(105,0,42,bodyHeading);label(g,front[0]-12,front[1]-8,'车头 +vy',{'font-size':11,fill:blue});
  segment(world(0,0,35),world(0,0,yawZ-3),'#afc7b7',20);
  const rendered=svg('g');
  drawMechanism(rendered,{feedback:pose.feedbackScene,target:pose.targetScene,reference:pose.referenceScene,states:gimbal,project,baseHeight:yawZ});
  for(const node of rendered.querySelectorAll('[data-motor]'))node.setAttribute('data-motor',this.motorKey(node.dataset.motor,'gimbal'));
  g.append(rendered);
  const vector=(values,heading,color,dash)=>{const v=chassisVector(values);if(!finite(heading)||!v)return;const scale=95/Math.max(this.state.modules.chassis.vectorScale,Math.hypot(...v));arrow(g,...world(0,0,2),...world(v[0]*scale,v[1]*scale,2,heading),color,dash);};
  vector(chassis.target,ht,amber,true);vector(chassis.body,h,green,false);
  label(g,28,30,'整车联合姿态 / '+mechanism(this.state.modules.chassis,'chassis').name,{'font-size':14,'font-weight':600,fill:green});
  label(g,28,53,pose.measured?'航向来源：已绑定实测 heading':'航向来源：角速度积分 / 相对起始零点',{'font-size':11,fill:pose.measured?green:'#a07546'});
  label(g,28,471,!finite(h)?'底盘航向缺失或参考系未对齐：灰色底盘仅表示参考结构':'车头 +vy · 右 +vx；云台零姿态朝车头，各关节按层级合成',{'font-size':11,fill:!finite(h)?'#a07546':green});
  layout.append(g);const readings=el('div','vehicle-readouts');
  const compass=svg('svg',{class:'yaw-compass',viewBox:'0 0 224 220'});yawOverview(compass,'',h,pose.worldYaw,pose.worldTarget,finite(h)?pose.relativeYaw:null);readings.append(compass);
  const reading=(title,value,target,detail)=>{const row=el('div','body-reading');row.append(el('span','',title),el('strong','',value),el('small','','目标 '+target),el('p','hint',detail));readings.append(row);};
  reading('底盘航向 · '+(pose.measured?'变量实测':'相对推算'),fmt(finite(pose.heading)?deg(wrapAngle(pose.heading)):null)+'°',fmt(finite(pose.headingTarget)?deg(wrapAngle(pose.headingTarget)):null)+'°','目标来源：'+(pose.targetBound?'已绑定目标航向':'指令角速度积分')+' · 误差 '+fmt(deg(pose.headingError))+'°');
  reading('最终瞄向 Yaw · '+(cfg.gimbalFrame==='world'?'世界坐标':'起始参考系'),fmt(finite(pose.worldYaw)?deg(wrapAngle(pose.worldYaw)):null)+'°',fmt(finite(pose.worldTarget)?deg(wrapAngle(pose.worldTarget)):null)+'°','云台相对底盘 '+fmt(finite(pose.relativeYaw)?deg(wrapAngle(pose.relativeYaw)):null)+'° · 最短误差 '+fmt(deg(pose.yawError))+'°');
  reading('Pitch / 瞄向夹角误差',fmt(deg(pose.pitch))+'° / '+fmt(deg(pose.pointingError))+'°',fmt(deg(pose.pitchTarget))+'°','Pitch 误差 '+fmt(deg(pose.pitchError))+'° · 夹角由完整关节链计算');
  const rates=el('div','vehicle-compensation');rates.append(el('h3','','旋转补偿对照 · 统一逆时针为正'),el('p','','底盘 '+fmt(deg(pose.chassisRate))+' °/s'),el('p','','云台相对底盘 '+fmt(deg(pose.relativeRate))+' °/s'),el('strong','','合成瞄向 '+fmt(deg(pose.worldRate))+' °/s'),el('p','hint','仓库 vt 顺时针为正，此处先取负转成航向角速度。合成瞄向 = −vt + 云台最终瞄向相对转速（由全部关节速度计算）。目标瞄向固定时观察补偿残差；目标运动时不应要求为零。'));readings.append(rates);
  layout.append(readings);p.append(layout);this.visual.append(p);
  const plots=el('div','motion-plots');
  plots.append(seriesPlot('底盘航向 / 输入与积分角','deg',frames,[{name:'反馈 / 相对推算',color:green,read:r=>deg(r.pose.heading)},{name:'目标 / 指令推算',color:amber,dash:true,read:r=>deg(r.pose.headingTarget)}]),
   seriesPlot('最终瞄向 Yaw / ±180° 方位','deg',frames,[{name:'反馈合成',color:green,read:r=>deg(r.pose.worldYaw)},{name:'目标合成',color:amber,dash:true,read:r=>deg(r.pose.worldTarget)}]),
   seriesPlot('瞄向误差','deg',frames,[{name:'Yaw 最短误差',color:blue,read:r=>deg(r.pose.yawError)},{name:'Pitch 误差',color:green,read:r=>deg(r.pose.pitchError)},{name:'瞄向夹角',color:amber,read:r=>deg(r.pose.pointingError)}]),
   seriesPlot('旋转补偿 / 逆时针角速度','deg/s',frames,[{name:'底盘 −vt',color:blue,read:r=>deg(r.pose.chassisRate)},{name:'云台相对',color:amber,read:r=>deg(r.pose.relativeRate)},{name:'合成瞄向',color:green,read:r=>deg(r.pose.worldRate)}]));this.visual.append(plots);
 }
 renderChassis(data,cfg,frames){
  const p=panel('底盘运动 / '+mechanism(cfg,'chassis').name,'悬停车轮查看电机 · 仓库坐标：右 +vx / 前 +vy / 顺时针 +vt'),layout=el('div','chassis-view');
  const g=svg('svg',{viewBox:'0 0 600 450',role:'group','aria-label':mechanism(cfg,'chassis').name+'运动图'});
  for(let x=60;x<=540;x+=40)line(g,x,40,x,405,'#edf2ee',1);for(let y=30;y<=405;y+=40)line(g,40,y,560,y,'#edf2ee',1);
  const cx=300,cy=220;
  const outline=mechanism(cfg,'chassis').outline||[[-100,-76],[100,-76],[100,76],[-100,76]];g.append(svg('polygon',{points:outline.map(([x,y])=>[cx-y,cy-x].join(',')).join(' '),fill:'#eaf2ed',stroke:'#b5cbbb','stroke-width':2}));
  arrow(g,cx,cy,cx,145,blue);label(g,274,69,'车头 +vy',{'font-size':13,fill:blue});label(g,438,cy+5,'右 +vx');
  for(const [key,{x:forward,y:left,angle,roller,rollingSign}]of Object.entries(wheelGeometry(cfg))){
   const x=cx-left,y=cy-forward,w=data.wheels[key],color=w.motor?.status==='online'?green:w.motor?.status==='offline'?'#bf6b5a':'#a9b9ae';
   const group=svg('g',{transform:'translate('+x+' '+y+') rotate('+(-deg(angle))+')',class:'chassis-wheel','data-motor':key,'data-wheel-angle':angle,'data-wheel-x':forward,'data-wheel-y':left,tabindex:0,role:'button','aria-label':slotLabel(this.state.modules.chassis,'chassis',key)+' 电机数据，点击或按回车固定'});
   group.append(svg('rect',{x:-24,y:-48,width:48,height:96,rx:12,fill:'transparent',class:'wheel-hitbox'}),svg('rect',{x:-14,y:-35,width:28,height:70,rx:7,fill:'#fff',stroke:color,'stroke-width':3}));
   const slant=roller*5;
   for(let n=-24;n<=24;n+=12)line(group,-9,n-slant,9,n+slant,roller?'#8aa997':'#bccfc2',2);
   // Right motors have the opposite forward rolling sense in Chassis::SetSpeed.
   if(finite(w.speed)&&Math.abs(w.speed)>.01){const forwardSpeed=w.speed*rollingSign;arrow(group,0,0,0,forwardSpeed>0?-48:48,color);}
   g.append(group);const lx=x<cx?58:443;label(g,lx,y-12,slotLabel(cfg,'chassis',key),{fill:color,'font-weight':600});label(g,lx,y+8,fmt(w.speed)+' rad/s',{'font-size':11});label(g,lx,y+26,'设定 '+fmt(w.target),{'font-size':10,fill:amber});
  }
  const vector=(v,color,dash)=>{if(!chassisVector(v))return;const factor=95/Math.max(cfg.vectorScale,Math.hypot(v.vx,v.vy));arrow(g,cx,cy,cx+v.vx*factor,cy-v.vy*factor,color,dash);};
  vector(data.target,amber,true);vector(data.body,green,false);g.append(svg('circle',{cx,cy,r:6,fill:green}));
  if(finite(data.body.omega)&&Math.abs(data.body.omega)>.01){const cw=data.body.omega>0;g.append(svg('path',{d:cw?'M346 174 A65 65 0 0 1 346 266':'M346 266 A65 65 0 0 0 346 174',fill:'none',stroke:blue,'stroke-width':3}));arrow(g,351,cw?260:180,342,cw?268:172,blue);}
  label(g,178,395,'vt '+fmt(data.body.omega)+' rad/s · '+(finite(data.body.omega)?Math.abs(data.body.omega)<.01?'近静止':data.body.omega>0?'↷ 顺时针':'↶ 逆时针':'无反馈'),{fill:blue});
  label(g,104,432,'箭头长度限幅 · 绿色反馈 / 橙色目标 · 不积分位移',{'font-size':11});layout.append(g);
  const readout=el('div','chassis-readout');readout.append(el('h3','','反馈与指令'));
  for(const [key,title]of [['vx','右向 vx'],['vy','前向 vy'],['omega','顺时针 vt']]){
   const row=el('div','body-reading');row.append(el('span','',title+' · '+data.sources[key]),el('strong','',fmt(data.body[key])+(key==='omega'?' rad/s':' m/s')),el('small','',data.targetSources[key]+' '+fmt(data.target[key])+' · 误差 '+fmt(finite(data.body[key])&&finite(data.target[key])?data.target[key]-data.body[key]:null)));readout.append(row);
  }
  const compass=svg('svg',{viewBox:'0 0 170 125',role:'img','aria-label':'底盘实测朝向，逆时针为正'});compass.append(svg('circle',{cx:85,cy:58,r:41,fill:'#f5f8f5',stroke:'#d8e4dc'}));label(compass,81,12,'0');
  if(finite(data.heading))arrow(compass,85,58,85-32*Math.sin(data.heading),58-32*Math.cos(data.heading));else label(compass,54,61,'未绑定朝向',{'font-size':11});label(compass,22,121,'航向（逆时针）'+fmt(finite(data.heading)?deg(data.heading):null)+'°');
  readout.append(compass,el('p','hint','绿色实线 = 反馈 / 轮速推算；橙色虚线 = 指令。推算需要构型所需轮组在线、轮序 / 方向 / 减速比和几何尺寸正确。'));layout.append(readout);p.append(layout);this.visual.append(p);
  const table=el('div','table-scroll motion-wheel-table'),t=el('table'),head=el('tr');for(const title of ['轮位 / 电机','在线 / 模式','输出轴反馈 / 设定','output / 状态'])head.append(el('th','',title));const thead=el('thead');thead.append(head);t.append(thead);const tbody=el('tbody');
  for(const [key,w]of Object.entries(data.wheels)){const m=w.motor,f=m?motorFields(m):{},d=m?motorState(m):{},r=el('tr');for(const text of [slotLabel(cfg,'chassis',key)+' · '+(cfg.wheels[key].motor||'未绑定'),m?(m.status+' / '+d.mode):'等待绑定或采样',fmt(w.speed)+' / '+fmt(w.target)+' rad/s',m?(fmt(f.output_)+' raw · '+(f['state_.enable']==null?'使能未知':f['state_.enable']?'使能':'失能')+(d.fault?' · '+d.fault:'')):'—'])r.append(el('td','',text));tbody.append(r);}
  t.append(tbody);table.append(t);p.append(table);
  const plots=el('div','motion-plots');for(const [key,title,unit]of [['vx','右向速度 vx','m/s'],['vy','前向速度 vy','m/s'],['omega','顺时针角速度 vt','rad/s']])plots.append(seriesPlot(title,unit,frames,[{name:'反馈 / 推算',color:green,read:r=>r.body[key]},{name:'指令',color:amber,dash:true,read:r=>r.target[key]}]));
  plots.append(seriesPlot('轮组反馈','rad/s',frames,slots(cfg,'chassis').map(({id:key,label},i)=>({name:label,color:[green,blue,amber,'#9b84b8'][i%4],read:r=>r.wheels[key].speed}))));this.visual.append(plots);
 }
}
