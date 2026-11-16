import {element as el, number} from './api.js';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const tau=2*Math.PI;
const svg=(tag,attrs={})=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attrs))n.setAttribute(key,String(value));return n;};
export function dialRadians(x,y,rect){return Math.atan2((x-rect.left)/rect.width-.5,.5-(y-rect.top)/rect.height);}
export function unwrapTarget(previous,wrapped,absolute=false){return absolute?((wrapped%tau)+tau)%tau:previous+Math.atan2(Math.sin(wrapped-previous),Math.cos(wrapped-previous));}

// A slow probe never accumulates old movement commands: only the newest unsent value survives.
export class LatestTargetWriter {
 constructor(send,valid,interval=125){this.send=send;this.valid=valid;this.interval=interval;this.pending=null;this.busy=false;this.last=0;this.epoch=0;}
 enqueue(value){this.pending=value;this.pump();}
 cancel(){this.pending=null;clearTimeout(this.timer);this.epoch++;}
 async pump(){
  clearTimeout(this.timer);
  if(!this.valid()){this.cancel();return;}
  if(this.busy||this.pending===null)return;
  const delay=this.interval-(Date.now()-this.last);
  if(delay>0){this.timer=setTimeout(()=>this.pump(),delay);return;}
  const value=this.pending;this.pending=null;this.busy=true;this.last=Date.now();
  try{await this.send(value);}catch{this.cancel();}finally{this.busy=false;if(this.pending!==null)this.pump();}
 }
}

export class MotorControl {
 constructor(root,state,hooks){
  this.root=root;this.state=state;this.hooks=hooks;this.logs=[];this.inputs=new Map();this.enablePending=new Map();this.enableMessages=new Map();this.reset();
  this.queue=new LatestTargetWriter(value=>this.submit([{field:this.motor.control.angle.field,value}],true),()=>this.canTarget());
  document.addEventListener('visibilitychange',()=>{if(document.hidden)this.cancelDrag();});
  window.addEventListener('blur',()=>this.cancelDrag());
 }
 reset(){this.cancelDrag();this.motor=null;this.key='';this.inputs.clear();this.root.replaceChildren();this.root.hidden=true;this.logs=[];this.statusNode=null;this.angleInput=null;this.angleApply=null;this.gauge=null;this.enableBinding=null;this.angleDirty=false;this.previewValue=null;this.previewPending=false;this.groups=[];}
 cancelDrag(){this.drag=null;this.queue?.cancel();if(this.pointerId!=null&&this.gauge?.hasPointerCapture?.(this.pointerId))this.gauge.releasePointerCapture(this.pointerId);this.pointerId=null;this.previewPending=false;}
 enableKey(motor){return JSON.stringify([this.state.sha,this.state.generation,motor?.path,motor?.address]);}
 canSetEnabled(motor){return Boolean(motor?.control?.enable?.supported&&motor.address&&typeof motor.fields?.['state_.enable']==='boolean'&&this.state.sha&&this.state.connected&&!this.state.busy&&this.state.page==='motors'&&this.state.modules.motors.enabled&&!document.hidden&&!motor.error&&!this.enablePending.has(this.enableKey(motor)));}
 buildEnableSwitch(motor){
  const node=el('div','motor-enable'),button=el('button','motor-enable-switch'),track=el('span','motor-enable-track'),label=el('span'),status=el('small','motor-enable-status');
  button.type='button';button.setAttribute('role','switch');track.setAttribute('aria-hidden','true');button.append(track,label);status.setAttribute('role','status');node.append(button,status);
  const binding={node,button,label,status,motor};button.onclick=()=>this.setEnabled(binding.motor,!binding.motor.fields['state_.enable']);this.refreshEnableSwitch(binding,motor);return binding;
 }
 refreshEnableSwitch(binding,motor=binding.motor){
  binding.motor=motor;const enabled=motor.fields?.['state_.enable'],pending=this.enablePending.get(this.enableKey(motor)),supported=motor.control?.enable?.supported,message=this.enableMessages.get(this.enableKey(motor));
  const messageText=message?.confirmed&&message.enabled!==enabled?'板端使能状态已变化，可能被固件更新。':message?.text;
  binding.button.disabled=!this.canSetEnabled(motor);binding.button.setAttribute('aria-checked',String(enabled===true));binding.button.setAttribute('aria-busy',String(Boolean(pending)));binding.button.setAttribute('aria-label','电机使能 '+motor.path);
  binding.label.textContent='电机使能 · '+(enabled===true?'ON':enabled===false?'OFF':'未知');
  binding.status.textContent=pending?(pending.enabled?'正在开启并读回…':'正在关闭并读回…'):messageText||(!supported?motor.control?.enable?.reason||'采样后显示可用的使能控制':!this.state.connected?'连接 SWD 后可控制':!this.state.running?'采集暂停 · 操作时重新读取板端状态':'板端软件使能状态');
  binding.button.title=motor.control?.enable?.reason||binding.status.textContent;
 }
 async setEnabled(motor,enabled){
  if(!this.canSetEnabled(motor)||typeof enabled!=='boolean')return;
  const key=this.enableKey(motor),sha=this.state.sha,generation=this.state.generation,request={path:motor.path,address:motor.address,mode:motor.control.mode,sha,enabled};
  const pending={enabled};this.enablePending.set(key,pending);this.enableMessages.delete(key);
  if(this.motor?.path===motor.path&&this.motor?.address===motor.address)this.cancelDrag();
  this.refreshControls();this.hooks.enableChanged?.();
  let response;
  try{
   // A target already in flight must finish before disable; no queued target may follow it.
   try{await this.writeInFlight;}catch{}
   if(sha!==this.state.sha||generation!==this.state.generation||!this.state.connected)throw Error('连接或 ELF 已变化，使能操作已取消。');
   response=await this.hooks.enable(request);
   if(sha!==this.state.sha||generation!==this.state.generation)return;
   const text=response.complete?(enabled?'已开启使能，继续执行板端现有目标。':'已关闭软件使能；固件控制循环将归零输出。'):response.error||'使能写入未确认，可能已被固件覆盖；请查看板端状态。';
   this.enableMessages.set(key,{text,enabled,confirmed:Boolean(response.complete)});
   if(this.motor?.path===motor.path&&this.motor?.address===motor.address){
    this.logs.unshift(new Date(response.time*1000).toLocaleTimeString()+' · '+text);this.logs=this.logs.slice(0,50);this.logNode?.replaceChildren(...this.logs.map(text=>el('p','',text)));
   }
  }catch(error){
   if(sha===this.state.sha&&generation===this.state.generation){this.enableMessages.set(key,{text:'使能状态未确认：'+error.message,confirmed:false});this.hooks.error?.(error.message);}
  }finally{
   this.enablePending.delete(key);this.refreshControls();
   if(sha===this.state.sha&&generation===this.state.generation)this.hooks.enableChanged?.(response);
  }
 }
 canWrite(){const m=this.motor;return Boolean(m&&this.state.sha&&this.state.connected&&this.state.running&&!this.state.busy&&this.state.page==='motors'&&this.state.modules.motors.enabled&&!document.hidden&&m.time&&Date.now()/1000-m.time<2&&!m.error&&!this.enablePending.has(this.enableKey(m)));}
 canCommand(){const m=this.motor,f=m?.fields||{};return this.canWrite()&&m.online===true&&f['state_.enable']===true&&(m.family!=='DM'||f['state_.rx.status']===1);}
 canTarget(){const m=this.motor;return this.canCommand()&&Boolean(m.control.angle)&&finite(m.fields[m.control.angle.feedback])&&(!this.sending||this.targetSending);}
 update(motor){
  if(!motor?.control){this.reset();return;}
  const key=JSON.stringify([this.state.sha,this.state.generation,motor.path,motor.address,motor.control.mode,motor.control.fields]);
  if(key!==this.key){this.reset();this.key=key;this.motor=motor;this.build();}
  this.motor=motor;this.root.hidden=false;
  for(const [field,item]of this.inputs){const value=motor.fields[field];item.current.textContent=finite(value)?item.flags?'0x'+value.toString(16).padStart(2,'0'):number(value):'—';if(!item.dirty&&document.activeElement!==item.input){item.input.value=finite(value)?String(value):'';if(item.flags)item.expected=value;}
   if(item.flags){item.optionNode.classList.toggle('dirty',item.dirty);for(const [bit,input]of item.flags){input.checked=Boolean(Number(item.input.value)&bit);item.flagReadings.get(bit).textContent='板端 '+(value&bit?'ON':'OFF');}}
  }
  this.updateGauge();this.refreshControls();
 }
 refreshControls(){
  if(!this.motor)return;
  if(this.enableBinding)this.refreshEnableSwitch(this.enableBinding,this.motor);
  const writable=this.canWrite(),target=this.canTarget(),command=this.canCommand();
  for(const item of this.inputs.values()){const disabled=!writable||this.sending||(item.descriptor.requiresDisabled&&this.motor.fields['state_.enable']!==false);item.input.disabled=disabled;if(item.flags)for(const input of item.flags.values())input.disabled=disabled;}
  for(const group of this.groups||[])group.button.disabled=!writable||this.sending||!group.fields.some(field=>this.inputs.get(field)?.dirty)||group.fields.some(field=>{const item=this.inputs.get(field);return item?.dirty&&((item.descriptor.group==='控制目标'&&!command)||(item.descriptor.requiresDisabled&&this.motor.fields['state_.enable']!==false));});
  for(const item of this.inputs.values())if(item.descriptor.group==='控制目标')item.input.disabled=!command||this.sending;
  if(this.angleInput)this.angleInput.disabled=!target;
  if(this.angleApply)this.angleApply.disabled=!target||this.sending;
  this.gauge?.classList.toggle('controllable',target);
  this.gauge?.setAttribute('aria-disabled',String(!target));
  this.gauge?.setAttribute('tabindex',target?'0':'-1');
  if(!target)this.cancelDrag();
  if(this.readiness)this.readiness.textContent=!this.state.connected?'连接 SWD 后可写入':!this.state.running?'开始采集后可写入':!writable?'等待当前电机的新采样':this.motor.control.angle&&!target?'PID 可调；目标控制等待电机在线且已使能':'运行参数可写 · 不保存到 Flash';
 }
 build(){
  const m=this.motor,panel=el('article','panel motor-control-panel'),heading=el('div','panel-heading');
  heading.append(el('h2','','电机调参与角度控制'),el('code','',m.path));this.enableBinding=this.buildEnableSwitch(m);heading.append(this.enableBinding.node);panel.append(heading);
  this.readiness=el('p','motor-write-readiness');panel.append(this.readiness);
  panel.append(el('p','motor-enable-hint','使能开关控制电机输出；重新开启会继续执行当前目标。刷新、重连不会自动使能。'));
  const layout=el('div','motor-control-layout');this.buildGauge(layout);
  const parameters=el('div','motor-parameters');this.groups=[];
  const groups=[...new Set(m.control.fields.map(item=>item.group))];
  for(const name of groups){
   const group=el('section','motor-parameter-group'),title=el('div','motor-group-heading'),button=el('button','button subtle','应用修改');title.append(el('h3','',name),button);group.append(title);
   const table=el('table'),head=el('thead'),row=el('tr');for(const text of ['参数','板端值','待写入值'])row.append(el('th','',text));head.append(row);table.append(head);const body=el('tbody'),fields=[];
   for(const descriptor of m.control.fields.filter(item=>item.group===name)){
    const field=descriptor.field,tr=el('tr'),label=el('td'),current=el('td','motor-param-current'),cell=el('td'),input=el('input');fields.push(field);
    label.append(el('strong','',descriptor.label),el('small','',descriptor.unit||'系数'));label.title=field;
    input.type='number';input.step='any';input.setAttribute('aria-label',name+' '+descriptor.label+' 待写入值');if(descriptor.min!==null)input.min=descriptor.min;if(descriptor.max!==null)input.max=descriptor.max;
    const item={input,current,descriptor,dirty:false};this.inputs.set(field,item);
    if(descriptor.kind==='pidFlags'){
     input.type='hidden';item.flags=new Map();item.flagReadings=new Map();item.expected=m.fields[field];input.value=String(item.expected);
     const options=el('div','motor-feature-options');item.optionNode=options;
     for(const option of descriptor.options){const label=el('label'),check=el('input'),text=el('span','',option.label),reading=el('small');check.type='checkbox';check.setAttribute('aria-label',name+' '+option.label);item.flags.set(option.bit,check);item.flagReadings.set(option.bit,reading);text.append(reading);label.append(check,text);options.append(label);
      check.addEventListener('change',()=>{const value=Number(input.value);input.value=String(check.checked?value|option.bit:value&~option.bit);item.dirty=true;input.classList.add('dirty');options.classList.add('dirty');this.refreshControls();});
     }
     cell.append(options);tr.className='motor-feature-row';
    }
    input.addEventListener('input',()=>{item.dirty=true;input.classList.add('dirty');this.refreshControls();});
    input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();button.click();}});
    cell.append(input);tr.append(label,current,cell);body.append(tr);
   }
   table.append(body);group.append(table);parameters.append(group);this.groups.push({fields,button});
   if(fields.some(field=>this.inputs.get(field).flags)){
    group.append(el('p','motor-feature-note','先关闭电机使能，再修改算法 / A、B，然后应用。A > 0、B ≥ 0；|误差| ≤ B 完整积分，B～A+B 递减，超过 A+B 停止同向积分。'));
    group.append(el('p','motor-feature-note','微分先行：本固件为 +Kd × Δ测量值。滤波 α=1 直通、α=0 保持历史值，关闭请取消对应开关。比例先行未实现；故障回调开关保留板端值。切换不会清空微分 / 滤波历史。'));
   }
   button.onclick=()=>this.applyFields(fields);
  }
  if(!groups.length)parameters.append(el('p','hint',m.control.reason||'当前模式没有可写入的参数。'));
  parameters.append(el('p','hint','修改的是运行参数；各字段顺序写入并读回，整组不是原子更新。不会调用 Reinit 或重置积分。运行前馈可能被上层任务持续覆盖。'));
  layout.append(parameters);panel.append(layout);
  const history=el('details','motor-write-history');history.append(el('summary','','写入记录'));this.logNode=el('div');history.append(this.logNode);panel.append(history);this.root.append(panel);
 }
 buildGauge(parent){
  const m=this.motor,angle=m.control.angle,gauge=el('div','motor-angle-control');
  const g=svg('svg',{viewBox:'0 0 240 240',role:angle?'slider':'img','aria-label':angle?'拖动电机角度目标':'电机反馈角度','aria-valuetext':'等待采样'});this.gauge=g;
  g.append(svg('circle',{cx:120,cy:120,r:88,fill:'#f3f7f4',stroke:'#cddbd3','stroke-width':2}));
  for(let n=0;n<24;n++){const a=n*tau/24;g.append(svg('line',{x1:120+80*Math.sin(a),y1:120-80*Math.cos(a),x2:120+88*Math.sin(a),y2:120-88*Math.cos(a),stroke:'#9aafa1','stroke-width':n%2?1:2}));}
  for(const [text,x,y]of [['0°',120,18],['90°',222,124],['180°',120,232],['270°',18,124]]){const label=svg('text',{x,y,'text-anchor':'middle',fill:'#738078','font-size':11});label.textContent=text;g.append(label);}
  this.feedbackNeedle=svg('line',{x1:120,y1:120,stroke:'#287963','stroke-width':5,'stroke-linecap':'round'});
  this.targetNeedle=svg('line',{x1:120,y1:120,stroke:'#d38b39','stroke-width':3,'stroke-dasharray':'6 4'});
  this.targetHandle=svg('circle',{r:10,fill:'#d38b39',stroke:'#fff','stroke-width':3});
  g.append(this.feedbackNeedle,this.targetNeedle,this.targetHandle,svg('circle',{cx:120,cy:120,r:6,fill:'#287963'}));gauge.append(g);
  this.angleReadout=el('p','motor-angle-readout');gauge.append(this.angleReadout);
  gauge.append(el('p','motor-angle-legend','绿：实际反馈　橙：角度目标'));
  if(angle){
   const descriptor=m.control.fields.find(item=>item.field===angle.field),label=el('label','motor-angle-input','角度目标（°）'),input=el('input');this.angleInput=input;input.type='number';input.step='1';input.setAttribute('aria-label','电机角度目标（度）');
   if(descriptor.min!==null)input.min=descriptor.min*180/Math.PI;if(descriptor.max!==null)input.max=descriptor.max*180/Math.PI;
   input.oninput=()=>{this.angleDirty=true;};label.append(input);gauge.append(label);
   this.angleApply=el('button','button','写入角度目标');this.angleApply.onclick=()=>{if(input.reportValidity()&&input.value.trim())this.sendAngle(Number(input.value)*Math.PI/180);};gauge.append(this.angleApply);
   gauge.append(el('p','hint',(m.family==='DJI'?'输出轴坐标':'转子坐标')+' · '+(angle.absolute?'单圈绝对角度':'连续角度，可跨圈拖动')+'。拖动时实时发送，最高 8 次/秒；松手发送最后目标。'));
   g.addEventListener('pointerdown',event=>{if(!this.canTarget()||event.button!==0||this.drag)return;event.preventDefault();this.pointerId=event.pointerId;g.setPointerCapture(event.pointerId);this.drag={value:this.previewValue??this.motor.fields[angle.field]??0};this.movePointer(event);});
   g.addEventListener('pointermove',event=>{if(this.drag&&event.pointerId===this.pointerId)this.movePointer(event);});
   g.addEventListener('pointerup',event=>{if(!this.drag||event.pointerId!==this.pointerId)return;this.movePointer(event);this.drag=null;g.releasePointerCapture(event.pointerId);this.pointerId=null;});
   g.addEventListener('pointercancel',()=>this.cancelDrag());g.addEventListener('lostpointercapture',()=>{if(this.drag)this.cancelDrag();});
   g.addEventListener('keydown',event=>{if(event.key==='Escape'){this.cancelDrag();return;}const direction=({ArrowRight:1,ArrowUp:1,ArrowLeft:-1,ArrowDown:-1})[event.key];if(!direction||!this.canTarget())return;event.preventDefault();const value=(this.previewValue??this.motor.fields[angle.field]??0)+direction*(event.shiftKey?10:1)*Math.PI/180;this.sendAngle(angle.absolute?((value%tau)+tau)%tau:value);});
  }else gauge.append(el('p','hint',m.control.reason||'切换到角度环后可拖动目标指针；速度和电流模式只显示反馈。'));
  const disclosure=el('details','motor-angle-disclosure');disclosure.append(el('summary','','角度盘与目标控制'),gauge);parent.append(disclosure);
 }
 movePointer(event){
  if(!this.canTarget()){this.cancelDrag();return;}
  const angle=this.motor.control.angle,descriptor=this.motor.control.fields.find(item=>item.field===angle.field);
  let value=unwrapTarget(this.drag.value,dialRadians(event.clientX,event.clientY,this.gauge.getBoundingClientRect()),angle.absolute);
  if(descriptor.min!==null)value=Math.max(descriptor.min,value);if(descriptor.max!==null)value=Math.min(descriptor.max,value);
  this.drag.value=value;this.previewValue=value;this.previewPending=true;this.updateGauge();this.queue.enqueue(value);
 }
 sendAngle(value){
  if(!this.canTarget()||!finite(value))return;
  const descriptor=this.motor.control.fields.find(item=>item.field===this.motor.control.angle.field);
  if((descriptor.min!==null&&value<descriptor.min)||(descriptor.max!==null&&value>descriptor.max)){this.message('角度目标超出允许范围。',true);return;}
  this.previewValue=value;this.previewPending=true;this.angleDirty=false;this.updateGauge();this.queue.enqueue(value);
 }
 updateGauge(){
  const m=this.motor,angle=m.control.angle,feedback=m.fields[angle?.feedback||(m.family==='DJI'?'state_.output_shaft_theta':'state_.theta')];
  const sampled=angle?m.fields[angle.field]:null;
  if(!this.drag&&!this.previewPending&&finite(sampled))this.previewValue=sampled;
  const target=angle?this.previewValue:null;
  const needle=(node,value,length)=>{node.style.display=finite(value)?'':'none';if(finite(value)){node.setAttribute('x2',120+length*Math.sin(value));node.setAttribute('y2',120-length*Math.cos(value));}};
  needle(this.feedbackNeedle,feedback,67);needle(this.targetNeedle,target,84);this.targetHandle.style.display=finite(target)?'':'none';if(finite(target)){this.targetHandle.setAttribute('cx',120+84*Math.sin(target));this.targetHandle.setAttribute('cy',120-84*Math.cos(target));}
  this.angleReadout.textContent=(m.family==='DJI'?'输出轴':'转子')+'反馈 '+(finite(feedback)?number(feedback*180/Math.PI)+'°':'—')+(finite(target)?' / 目标 '+number(target*180/Math.PI)+'°':'');
  if(this.angleInput&&document.activeElement!==this.angleInput&&!this.angleDirty)this.angleInput.value=finite(target)?String(Number((target*180/Math.PI).toFixed(3))):'';
  if(angle){this.gauge.setAttribute('aria-valuenow',finite(target)?String(target*180/Math.PI):'0');this.gauge.setAttribute('aria-valuetext',this.angleReadout.textContent);const descriptor=m.control.fields.find(item=>item.field===angle.field);if(descriptor.min!==null)this.gauge.setAttribute('aria-valuemin',descriptor.min*180/Math.PI);if(descriptor.max!==null)this.gauge.setAttribute('aria-valuemax',descriptor.max*180/Math.PI);}
 }
 async applyFields(fields){
  if(!this.canWrite()||this.sending)return;
  const updates=[];
  for(const field of fields){const item=this.inputs.get(field);if(!item.dirty)continue;if(item.input.disabled){this.message('修改算法开关或 A/B 前，请先关闭电机使能。',true);return;}if(!item.input.value.trim()||!item.input.reportValidity()){this.message('请输入有效的参数值。',true);return;}updates.push({field,value:Number(item.input.value),...(item.flags?{expected:item.expected}:{})});}
  for(const field of fields){const item=this.inputs.get(field);if(!item.flags)continue;const ring=field.split('.')[0];if(!updates.some(update=>update.field.startsWith(ring+'.')))continue;
   const mode=Number(item.input.value),a=Number(this.inputs.get(ring+'.ScalarA')?.input.value),b=Number(this.inputs.get(ring+'.ScalarB')?.input.value);
   if(mode&32&&!(Math.fround(a)>0&&Math.fround(b)>=0&&Number.isFinite(Math.fround(a+b)))){this.message('变速积分需要 A > 0、B ≥ 0，且 A+B 在 float32 范围内。',true);return;}
   // Guard an A/B edit against a flag change since the latest sample.
   if(updates.some(update=>/\.Scalar[AB]$/.test(update.field))&&!updates.some(update=>update.field===field))updates.push({field,value:mode,expected:item.expected});
  }
  if(!updates.length)return;
  try{await this.submit(updates);}catch{}
 }
 message(text,error=false){this.feedbackText=text;this.feedbackError=error;if(this.statusNode){this.statusNode.textContent=text;this.statusNode.classList.toggle('error',error);}else{this.statusNode=el('p','motor-write-result'+(error?' error':''),text);this.statusNode.setAttribute('role','status');this.readiness.after(this.statusNode);}}
 async submit(updates,drag=false){
  if(!this.canWrite()||this.sending)throw Error('当前不可写入。');
  const key=this.key,m=this.motor,request={path:m.path,address:m.address,mode:m.control.mode,sha:this.state.sha,updates};
  this.sending=true;this.targetSending=drag;this.refreshControls();this.message('正在写入并读回…');
  try{
   const operation=this.hooks.write(request);this.writeInFlight=operation;
   const result=await operation;
   if(key!==this.key)return;
   for(const item of result.results){
    const input=this.inputs.get(item.field);if(item.matched&&input){input.dirty=false;input.input.classList.remove('dirty');input.optionNode?.classList.remove('dirty');if(finite(item.readback)){input.current.textContent=input.flags?'0x'+item.readback.toString(16).padStart(2,'0'):number(item.readback);if(input.flags){input.expected=item.readback;for(const [bit,reading]of input.flagReadings)reading.textContent='板端 '+(item.readback&bit?'ON':'OFF');}}}
    const text=(this.inputs.get(item.field)?.descriptor.label||item.field)+'：'+number(item.before)+' → '+number(item.requested)+(item.error?' · '+item.error:item.matched?' · 已读回确认':' · 读回 '+number(item.readback)+'，可能被固件覆盖');
    this.logs.unshift(new Date(result.time*1000).toLocaleTimeString()+' · '+text);
   }
   this.logs=this.logs.slice(0,50);this.logNode.replaceChildren(...this.logs.map(text=>el('p','',text)));
   this.message(result.complete?'已写入并读回确认；后续值以实时采样为准。':'写入未全部确认，查看记录；已写入的字段不会自动回滚。',!result.complete);
   if(!result.complete&&drag){this.queue.cancel();this.drag=null;}
  }catch(error){if(key===this.key){this.message(error.message,true);this.queue.cancel();this.drag=null;}throw error;}
  finally{this.sending=false;this.targetSending=false;if(key===this.key&&!this.drag&&this.queue.pending===null)this.previewPending=false;this.refreshControls();}
 }
}
