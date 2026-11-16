import {element as el, number, download} from './api.js';
import {MotorControl} from './motor-control.js';
import {MotorAiPanel} from './motor-ai.js';
import {MotorPlots} from './motor-plots.js';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const fmt=v=>finite(v)?number(v):typeof v==='boolean'?String(v):'—';
const hex=v=>finite(v)?'0x'+v.toString(16).toUpperCase():'—';
const labels={online:'在线',offline:'反馈超时',waiting:'尚无反馈',unknown:'时钟未知',error:'读取失败'};
const faults={2:'电机未识别',3:'输出轴未识别',5:'编码器故障',7:'编码器故障',8:'过压',9:'欠压',10:'过流',11:'MOS 过温',12:'线圈过温',13:'通讯丢失',14:'过载'};
export function motorFields(m){const f=m.fields||{};return m.family==='CyberGear'?{...f,'state_.theta':f.theta_,'state_.omega':f.omega_,'state_.torque':f.torque_,'state_.raw_temperature':f.temperature_}:f;}
export function motorState(m) {
 const f=m.fields||{},mode=f['state_.mode'];
 if(m.family==='CyberGear')return {mode:(({0:'MIT',1:'POSITION',2:'SPEED',3:'CURRENT'})[f.mode_]||'未知模式')+' · '+(({0:'RESET',1:'CALI',2:'NORMAL'})[f.status_]||'未知反馈状态'),fault:f.error_code_?'CyberGear error_code_='+hex(f.error_code_):'',thetaTarget:null,omegaTarget:null,rawTarget:null};
 if(m.family==='DM'){const status=f['state_.rx.status'];return {mode:({0:'MIT',256:'POS_VEL',512:'VEL'})[mode]??'未知模式',fault:faults[status]||(status>1?'未知故障 '+status:''),thetaTarget:[0,256].includes(mode)?f['state_.tx.p_des']:null,omegaTarget:[0,256,512].includes(mode)?f['state_.tx.v_des']:null,rawTarget:null};}
 const theta=finite(mode)&&Boolean(mode&4),omega=finite(mode)&&Boolean(mode&2),current=finite(mode)&&Boolean(mode&1);
 return {mode:finite(mode)?[current?'CURRENT':theta?'THETA':omega?'OMEGA':'NONE',mode&128?'ABSOLUTE':'',mode&64?'INVERTED':''].filter(Boolean).join(' · '):'未知模式',fault:f['omega_pid_.PID_ErrorHandler.error_type']===1||f['theta_pid_.PID_ErrorHandler.error_type']===1?'固件 PID 报告堵转':'',thetaTarget:!current&&theta?f['state_.target']:null,omegaTarget:!current&&!theta&&omega?f['state_.target']:null,rawTarget:current?f['state_.target']:null};
}
export function motorPlotRange(points,unit){let lo=Math.min(0,...points),hi=Math.max(0,...points);const minimum=unit==='A'?.02:unit==='raw'?2:.2;if(hi-lo<minimum){const middle=(lo+hi)/2;lo=middle-minimum/2;hi=middle+minimum/2;}const pad=(hi-lo)*.08;return [lo-pad,hi+pad];}
// Read mode and enable from each historical frame, never from the latest motor.
export function motorSpeedPidField(m,key){const f=m.fields||{},mode=f['state_.mode'];return m.family==='DJI'&&finite(mode)&&(mode&2)&&!(mode&1)&&f['state_.enable']===true?f['omega_pid_.'+key]:null;}
export function motorRawGroups(m){
 const groups=new Map(),labels={feedback:'运动与传感器反馈',control:'控制目标与运行状态',omega:'速度环 PID · 原始存储值',theta:'角度环 PID · 原始存储值',driver:'驱动、通讯与其他字段'};
 const add=(key,value,error=false)=>{const group=key.startsWith('omega_pid_.')?'omega':key.startsWith('theta_pid_.')?'theta':/^(state_\.(target|mode|enable|holding|.*feedforward)|output_)$/.test(key)?'control':/^(state_\.(theta|omega|current|temperature|raw_.*|torque|output_.*)|theta_|omega_|torque_|temperature_)$/.test(key)?'feedback':'driver';if(!groups.has(group))groups.set(group,[]);groups.get(group).push({key,value:error?String(value):value==null?'—':String(value),error});};
 for(const [key,value]of Object.entries(m.fields||{}))if(!Object.hasOwn(m.fieldErrors||{},key))add(key,value);
 for(const [key,error]of Object.entries(m.fieldErrors||{}))add(key,error,true);
 return ['feedback','control','omega','theta','driver'].filter(key=>groups.has(key)).map(key=>({title:labels[key],rows:groups.get(key)}));
}
export class MotorDashboard {
 constructor(root,state,hooks){this.root=root;this.state=state;this.hooks=hooks;this.reset();
  const toolbar=el('div','motor-toolbar'),scan=el('button','button','扫描 CAN 电机'),all=el('button','button subtle','全选当前总线'),none=el('button','button subtle','取消选择'),exp=el('button','button subtle','导出采样 JSON');this.prune=el('button','button subtle','移除未发现选择');this.prune.hidden=true;
  this.bus=el('select');this.bus.setAttribute('aria-label','电机 CAN 总线筛选');toolbar.append(scan,this.bus,all,none,this.prune,exp);
  this.message=el('p','hint');this.summary=el('div','motor-summary');this.table=el('div','table-scroll');this.detail=el('div','motor-detail');this.eventsNode=el('div','motor-events');
  const panel=el('article','panel'),catalog=el('details','motor-catalog'),catalogTitle=el('summary','','电机列表 / 选择采集对象');catalog.open=false;panel.append(toolbar,this.message,this.summary,this.table);catalog.append(catalogTitle,panel);
  this.workbench=el('section','motor-workbench');const bar=el('div','motor-workbench-heading'),expand=el('button','button subtle','展开工作区');expand.setAttribute('aria-expanded','false');bar.append(el('strong','','调参工作区'),el('small','','左侧独立滚动 · 四图共享时间轴'),expand);
  expand.onclick=()=>{const full=this.workbench.classList.toggle('expanded');expand.textContent=full?'退出展开':'展开工作区';expand.setAttribute('aria-expanded',String(full));};
  this.controlNode=el('div','motor-control');this.plotNode=el('div','motor-chart-area');this.plotter=new MotorPlots(this.plotNode);this.control=new MotorControl(this.controlNode,state,{...hooks,enableChanged:result=>{if(result?.motor)this.ingest([result.motor],result.time);this.render();}});this.workbench.append(bar,this.controlNode,this.plotNode);root.append(catalog,this.workbench,this.detail,this.eventsNode);
  this.aiNode=el('div','motor-ai');this.ai=new MotorAiPanel(this.aiNode,state);this.detail.after(this.aiNode);
  scan.onclick=()=>hooks.scan();this.bus.onchange=()=>{this.config.bus=this.bus.value;hooks.changed();this.render();};
  all.onclick=()=>{this.config.selected=[...new Set([...this.selected,...this.filtered().map(m=>m.path)])].slice(0,64);this.selectionChanged();};
  none.onclick=()=>{const visible=new Set(this.filtered().map(m=>m.path));this.config.selected=this.selected.filter(p=>!visible.has(p));this.selectionChanged();};
  this.prune.onclick=()=>{this.config.selected=this.selected.filter(p=>this.catalog.some(m=>m.path===p));this.selectionChanged();};
  exp.onclick=()=>download(JSON.stringify({elfPath:state.elfPath,frames:this.frames,events:this.events},null,2),'livertt-motors-'+Date.now()+'.json','application/json');
 }
 reset(){this.control?.reset();this.ai?.reset();this.plotter?.reset();this.enableBindings=[];this.catalog=[];this.latest=new Map();this.frames=[];this.events=[];this.previous=new Map();this.note='加载 ELF 后扫描；连接 SWD 后可发现运行时注册的电机。';}
 refreshControls(){this.control.refreshControls();this.ai?.refresh();for(const binding of this.enableBindings)this.control.refreshEnableSwitch(binding);}
 get config(){return this.state.modules.motors;}
 get selected(){return this.config.selected||[];}
 paths(){return this.config.enabled?this.selected.filter(p=>this.catalog.some(m=>m.path===p)):[];}
 filtered(){return this.catalog.filter(m=>!this.config.bus||!m.bus||m.bus===this.config.bus);}
 setCatalog(data){this.catalog=data.items;this.note=(data.live?'运行时扫描完成。':'离线候选；空指针与空注册槽会在连接后过滤。')+data.note;this.render();this.hooks.controls();}
 selectionChanged(){this.hooks.changed();this.hooks.controls();this.render();}
 ingest(motors,time){for(const m of motors){const d=motorState(m),signature=[m.status,m.fields['state_.enable'],d.mode,d.fault,m.error||''].join('|');if(signature!==this.previous.get(m.path)){this.events.unshift({time,path:m.path,text:[labels[m.status],m.fields['state_.enable']==null?'':m.fields['state_.enable']?'软件使能':'软件失能',d.mode,d.fault,m.error].filter(Boolean).join(' · ')});this.previous.set(m.path,signature);}this.latest.set(m.path,{...m,time});}this.frames.push({time,motors});while(this.frames.length&&(this.frames.length>600||time-this.frames[0].time>120))this.frames.shift();this.events=this.events.slice(0,150);}
 render(){if(this.state.page!=='motors'||!this.config.enabled)return;
  const focused=this.root.contains(document.activeElement)?document.activeElement:null,focusLabel=focused?.getAttribute('aria-label'),focusSummary=focused?.tagName==='SUMMARY',tableScroll=this.table.scrollLeft,eventScroll=this.eventsNode.querySelector('.motor-event-list')?.scrollTop||0;
  const buses=[...new Set(this.catalog.map(m=>m.bus).filter(Boolean))],options=['',...buses,...(this.config.bus&&!buses.includes(this.config.bus)?[this.config.bus]:[])],signature=JSON.stringify(options);if(this.busSignature!==signature){this.bus.replaceChildren();for(const v of options){const opt=el('option','',v||'全部 CAN 总线');opt.value=v;this.bus.append(opt);}this.busSignature=signature;}this.bus.value=this.config.bus||'';
  const missing=this.selected.filter(p=>!this.catalog.some(m=>m.path===p));this.prune.hidden=!missing.length;this.prune.title=missing.join('、');this.message.textContent=this.note+(missing.length?' · '+missing.length+' 个已保存电机未发现，选择仍保留。':'');
  const samples=this.paths().map(p=>this.latest.get(p)).filter(Boolean);this.summary.textContent='发现 '+this.catalog.length+' 台 · 已选 '+this.selected.length+' 台 · 最近采样在线 '+samples.filter(m=>m.online).length+'/'+samples.length+' · '+(this.state.running?'正在采集':'采集暂停 · 显示历史状态');
  this.enableBindings=[];this.table.replaceChildren();const table=el('table'),head=el('thead'),hr=el('tr');for(const title of ['采集','电机 / CAN','反馈状态','模式 / 使能','θ / ω','目标','output / 电流','温度','详情'])hr.append(el('th','',title));head.append(hr);table.append(head);const body=el('tbody');
  for(const item of this.filtered()){const m=this.latest.get(item.path)||item,f=motorFields(m),d=motorState(m),row=el('tr',item.path===this.config.focus?'motor-focused':''),cell=el('td'),check=el('input');check.type='checkbox';check.checked=this.selected.includes(item.path);check.setAttribute('aria-label','采集电机 '+item.path);check.onchange=()=>{if(check.checked&&this.selected.length>=64){check.checked=false;this.hooks.error('最多选择 64 个电机');return;}this.config.selected=check.checked?[...this.selected,item.path]:this.selected.filter(p=>p!==item.path);this.selectionChanged();};cell.append(check);row.append(cell);
   const identity=el('td');identity.append(el('strong','',item.type),el('code','',item.path),el('small','',(m.bus||'待连接')+' · RX '+hex(m.rxId)+' / TX '+hex(m.txId)));row.append(identity);
   const status=el('td');status.append(el('span','motor-badge '+(m.status==='online'?'good':m.status==='offline'||m.error?'bad':''),labels[m.status]||'等待采集'),el('small','',m.feedbackAgeMs!=null?'反馈龄 '+fmt(m.feedbackAgeMs)+' ms':''));if(!this.state.running||!m.time||Date.now()/1000-m.time>2)status.append(el('small','stale','历史状态'));if(d.fault)status.append(el('small','error',d.fault));if(m.family==='DM'&&f['state_.rx.status']===0)status.append(el('small','','DM 反馈失能'));row.append(status);
   const target=finite(d.thetaTarget)?fmt(d.thetaTarget)+' rad':finite(d.omegaTarget)?fmt(d.omegaTarget)+' rad/s':finite(d.rawTarget)?fmt(d.rawTarget)+' raw':'—';
   const modeCell=el('td','motor-data'),enableBinding=this.control.buildEnableSwitch(m);modeCell.append(el('span','',d.mode),enableBinding.node);this.enableBindings.push(enableBinding);row.append(modeCell);
   for(const text of [fmt(f['state_.theta'])+' rad\n'+fmt(f['state_.omega'])+' rad/s',target,m.family==='DJI'?fmt(f.output_)+' raw\n'+fmt(f['state_.current'])+' A':m.family==='DM'?fmt(f['state_.tx.t_ff'])+' N·m 前馈':fmt(f['state_.torque'])+' N·m 反馈',m.family==='DM'?fmt(f['state_.rx.raw_mos_temp'])+' / '+fmt(f['state_.rx.raw_rotor_temp'])+' °C':fmt(f['state_.raw_temperature'])+' °C'])row.append(el('td','motor-data',text));
   const focusCell=el('td'),focus=el('button','text-button','查看');focus.setAttribute('aria-label','查看电机 '+item.path);focus.onclick=()=>{this.config.focus=item.path;this.hooks.changed();this.render();};focusCell.append(focus);row.append(focusCell);body.append(row);
  }table.append(body);this.table.append(table);if(!this.catalog.length)this.table.append(el('div','empty','扫描后选择电机；无需逐个绑定 theta、omega 或 output。'));
  this.renderDetail();this.eventsNode.replaceChildren();const panel=el('article','panel'),heading=el('div','panel-heading');heading.append(el('h2','','状态事件'),el('span','caption','保留 150 条 / 显示最近 30 条 · 仅记录采样中观察到的变化'));panel.append(heading);const list=el('div','motor-event-list');for(const e of this.events.slice(0,30))list.append(el('div','motor-event',new Date(e.time*1000).toLocaleTimeString()+' · '+e.path+' · '+e.text));if(!this.events.length)list.append(el('p','hint','采集后记录 online、使能、控制模式和故障变化。'));panel.append(list);this.eventsNode.append(panel);
  for(const input of this.root.querySelectorAll('button, input, select'))if(!this.plotNode.contains(input)&&input!==this.workbench.querySelector('.motor-workbench-heading button'))input.disabled=this.state.busy||!this.state.sha;
  this.refreshControls();
  this.table.scrollLeft=tableScroll;list.scrollTop=eventScroll;if(focusLabel&&!focused.isConnected)[...this.root.querySelectorAll('[aria-label]')].find(node=>node.getAttribute('aria-label')===focusLabel)?.focus({preventScroll:true});if(focusSummary)this.detail.querySelector('summary')?.focus({preventScroll:true});
 }
 renderDetail(){const expanded=this.detail.querySelector('details')?.open,fieldScroll=this.detail.querySelector('.motor-fields')?.scrollTop||0;this.detail.replaceChildren();const path=(this.catalog.some(m=>m.path===this.config.focus)?this.config.focus:'')||this.paths()[0]||this.catalog[0]?.path,m=this.latest.get(path),panel=el('article','panel motor-focus-panel'),heading=el('div','panel-heading');heading.append(el('h2','','重点电机'),el('code','',path||'尚未选择'));panel.append(heading);this.detail.append(panel);
  this.control.update(m);
  this.ai.update(m,this.frames,this.events);
  if(!m){this.plotter.reset();panel.append(el('div','empty','在列表中选择电机，点击顶部「开始采集」后查看运动、输出和诊断。'));return;}
  const f=motorFields(m),d=motorState(m),stale=!this.state.running||Date.now()/1000-m.time>2,visual=el('div','motor-visual');
  // The persistent control panel above owns the interactive output-shaft gauge.
  const diagnosis=el('div','motor-diagnosis');diagnosis.append(el('h3','',stale?'采集暂停 / 数据过期':labels[m.status]||'等待数据'));
  for(const line of [m.error,d.fault,m.status==='waiting'?'尚未收到 CAN 心跳：检查电源、接线、RX ID 与初始化。':'',m.status==='offline'?'反馈超过固件 online_threshold_：检查 CAN 通讯和电机供电。':'',f['state_.enable']===false?'软件已失能：检查控制逻辑的使能条件。':'',d.mode+(finite(d.thetaTarget)&&f['state_.holding']!=null?' · '+(f['state_.holding']?'保持状态':'追踪状态'):''),m.family==='DM'&&f['state_.rx.status']===0?'DM 电机反馈失能。':''])if(line)diagnosis.append(el('p',d.fault?'error':'',line));
  const output=f.output_,limit=f.max_raw_current_;if(finite(output)&&finite(limit)&&limit>0){const meter=el('div','motor-output-meter'),bar=el('i'),width=Math.min(50,Math.abs(output)/limit*50);bar.style.width=width+'%';bar.style.left=(output<0?50-width:50)+'%';meter.append(bar);diagnosis.append(el('p','','输出 '+fmt(output)+' raw / ±'+fmt(limit)),meter);}
  const feedbackFrame=m.family==='DJI'?'输出轴':'转子',angleFeedback=f[m.family==='DJI'?'state_.output_shaft_theta':'state_.theta'],speedFeedback=f[m.family==='DJI'?'state_.output_shaft_omega':'state_.omega'];
  if(finite(d.thetaTarget)&&finite(angleFeedback)){let error=d.thetaTarget-angleFeedback;const absolute=m.family==='DJI'&&Boolean(f['state_.mode']&128);if(absolute)error=Math.atan2(Math.sin(error),Math.cos(error));diagnosis.append(el('p','','目标 − '+feedbackFrame+'角度 = '+fmt(error)+' rad'+(absolute?'（最短角差）':'')));}
  if(finite(d.omegaTarget)&&finite(speedFeedback))diagnosis.append(el('p','','速度设定 − '+feedbackFrame+'速度 = '+fmt(d.omegaTarget-speedFeedback)+' rad/s'));
  const pidLimit=f['omega_pid_.max_out_'],pidOut=motorSpeedPidField(m,'output_');if(finite(pidOut)&&finite(pidLimit)&&pidLimit>0&&Math.abs(pidOut)>=.98*pidLimit)diagnosis.append(el('p','error','速度 PID 接近输出限制；结合目标偏差、电流和负载排查。'));
  diagnosis.append(el('p','hint','趋势来自 SWD 轮询，读数可能跨越多次固件更新。'));visual.append(diagnosis);panel.append(visual);
  if(m.family==='CyberGear')diagnosis.append(el('p','hint','此驱动未保存控制目标与输出指令，显示 CAN 反馈和状态；不会从发送缓冲区推测目标。'));
  const frames=this.frames.map(r=>({time:r.time,motor:r.motors.find(v=>v.path===path&&v.address===m.address)||{fields:{}}})),field=key=>v=>motorFields(v)[key],definitions=[
   {title:'角度反馈与设定',unit:'rad',series:[{name:'转子 θ',color:'#9b84b8',read:field('state_.theta')},{name:'输出轴 θ',color:'#287963',read:field('state_.output_shaft_theta')},{name:'角度目标',color:'#df9851',dash:true,read:v=>motorState(v).thetaTarget}]},
   {title:'速度反馈与设定',unit:'rad/s',series:[{name:'转子 ω',color:'#9b84b8',read:field('state_.omega')},{name:'输出轴 ω',color:'#287963',read:field('state_.output_shaft_omega')},{name:'速度目标',color:'#df9851',dash:true,read:v=>motorState(v).omegaTarget},{name:'速度环目标',color:'#ca5e61',dash:true,read:v=>motorSpeedPidField(v,'target_')}]}
  ];
  if(m.family==='DJI')definitions.push({title:'驱动指令与速度环 PID',unit:'raw',help:'驱动指令 = output_，是驱动原始指令刻度，不是 A 或 N·m。P / I / D 来自 omega_pid_，不是角度环；失能、CURRENT 或未启用速度环时不绘制，— 表示无适用值。滤波、限幅、前馈与取整会使驱动指令不等于 P+I+D。CURRENT 直通目标仅在 CURRENT 模式绘制。SWD 轮询不是同步快照，未收到新反馈时 PID 存储值也可能保持。',series:[{name:'驱动指令',color:'#287963',read:field('output_')},{name:'速度 P',color:'#4989b0',read:v=>motorSpeedPidField(v,'pout_')},{name:'速度 I',color:'#df9851',read:v=>motorSpeedPidField(v,'iout_')},{name:'速度 D',color:'#9b84b8',read:v=>motorSpeedPidField(v,'dout_')},{name:'CURRENT 直通目标',color:'#ca5e61',dash:true,read:v=>motorState(v).rawTarget}]},{title:'电流反馈',unit:'A',series:[{name:'电流',color:'#4989b0',read:field('state_.current')}]});
  else definitions.push({title:'力矩反馈与前馈',unit:'N·m',series:[{name:'力矩反馈',color:'#287963',read:field('state_.torque')},...(m.family==='DM'?[{name:'力矩前馈（非总输出）',color:'#df9851',dash:true,read:field('state_.tx.t_ff')}]:[])]},{title:'温度反馈',unit:'°C',series:[{name:'温度',color:'#ca5e61',read:field(m.family==='DM'?'state_.rx.raw_mos_temp':'state_.raw_temperature')}]});
  this.plotter.update(JSON.stringify([this.state.sha,this.state.generation,m.path,m.address,m.family]),frames,definitions);
  const groups=motorRawGroups(m),details=el('details','motor-raw'),summary=el('summary','','全部反馈 / 目标 / PID 字段 · '+groups.reduce((n,g)=>n+g.rows.length,0)+' 项');details.open=Boolean(expanded);details.append(summary,el('p','motor-raw-note','只读原始存储值 · 保留采样数值精度，小量使用科学计数法 · PID 字段在环路停用时可能保留旧值；字段存在不代表可写或正在生效。'));
  const fields=el('div','motor-fields');
  for(const group of groups){const section=el('section','motor-field-group'),table=el('table','motor-field-table'),head=el('thead'),tr=el('tr'),body=el('tbody');section.append(el('h4','',group.title+' · '+group.rows.length));for(const title of ['原始字段','当前值']){const th=el('th','',title);th.setAttribute('scope','col');tr.append(th);}head.append(tr);table.append(head);
   for(const item of group.rows){const row=el('tr',item.error?'motor-field-error':''),key=el('th'),value=el('td',item.error?'error':'');key.setAttribute('scope','row');key.append(el('code','',item.key));value.append(el('span','',item.value));row.append(key,value);body.append(row);}table.append(body);section.append(table);fields.append(section);
  }details.append(fields);panel.append(details);fields.scrollTop=fieldScroll;
 }
}

