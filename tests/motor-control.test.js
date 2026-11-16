import test from 'node:test';
import assert from 'node:assert/strict';
import {dialRadians,unwrapTarget,LatestTargetWriter,MotorControl} from '../frontend/assets/js/motor-control.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('dial uses clockwise output coordinates and unwraps across the zero mark',()=>{
 const rect={left:10,top:20,width:200,height:200};
 assert.equal(dialRadians(110,20,rect),0);
 assert.equal(dialRadians(210,120,rect),Math.PI/2);
 const rad=deg=>deg*Math.PI/180;
 assert.ok(Math.abs(unwrapTarget(rad(359),rad(1))-rad(361))<1e-12);
 assert.ok(Math.abs(unwrapTarget(rad(1),rad(359))-rad(-1))<1e-12);
 assert.ok(Math.abs(unwrapTarget(rad(359),rad(1),true)-rad(1))<1e-12);
 assert.ok(Math.abs(unwrapTarget(rad(1080),rad(10))-rad(1090))<1e-12);
});

test('slow writes coalesce movement and send the final target without a command backlog',async()=>{
 const sent=[];let release;
 const writer=new LatestTargetWriter(async value=>{sent.push(value);if(sent.length===1)await new Promise(resolve=>{release=resolve;});},()=>true,0);
 writer.enqueue(1);writer.enqueue(2);writer.enqueue(3);
 assert.deepEqual(sent,[1]);release();await tick();await tick();
 assert.deepEqual(sent,[1,3]);assert.equal(writer.busy,false);
});

test('cancelling or losing a valid control session discards unsent movement',async()=>{
 let valid=true,release;const sent=[];
 const writer=new LatestTargetWriter(async value=>{sent.push(value);await new Promise(resolve=>{release=resolve;});},()=>valid,0);
 writer.enqueue(1);writer.enqueue(2);valid=false;writer.cancel();release();await tick();
 assert.deepEqual(sent,[1]);writer.enqueue(3);assert.deepEqual(sent,[1]);assert.equal(writer.pending,null);
});

class Node {
 constructor(tag,doc){this.tagName=tag;this.doc=doc;this.children=[];this.attrs={};this.events={};this.style={};this.className='';this.value='';this.captures=new Set();
  const set=(name,on)=>{const values=new Set(this.className.split(' ').filter(Boolean));if(on)values.add(name);else values.delete(name);this.className=[...values].join(' ');};
  this.classList={toggle:set,add:name=>set(name,true),remove:name=>set(name,false)};
 }
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 set textContent(value){this.text=String(value);this.children=[];}
 get textContent(){return (this.text||'')+this.children.map(node=>node.textContent).join('');}
 setAttribute(key,value){this.attrs[key]=String(value);}
 addEventListener(name,handler){this.events[name]=handler;}
 after(node){const index=this.parent.children.indexOf(this);node.parent=this.parent;this.parent.children.splice(index+1,0,node);}
 setPointerCapture(id){this.captures.add(id);}
 releasePointerCapture(id){this.captures.delete(id);}
 hasPointerCapture(id){return this.captures.has(id);}
 getBoundingClientRect(){return {left:0,top:0,width:240,height:240};}
 reportValidity(){return this.value!==''&&Number.isFinite(Number(this.value))&&(this.min===undefined||Number(this.value)>=this.min)&&(this.max===undefined||Number(this.value)<=this.max);}
}
async function fixture(run){
 const previousDocument=globalThis.document,previousWindow=globalThis.window;
 const doc={hidden:false,createElement:tag=>new Node(tag,doc),createElementNS:(_,tag)=>new Node(tag,doc),addEventListener:()=>{}};
 globalThis.document=doc;globalThis.window={addEventListener:()=>{}};
 const state={sha:'elf-one',generation:1,connected:true,running:true,busy:false,page:'motors',modules:{motors:{enabled:true}}};
 const descriptors=[{field:'omega_pid_.kp_',label:'Kp',group:'速度环 PID',unit:'',min:null,max:null},
                    {field:'state_.target',label:'角度目标',group:'控制目标',unit:'rad',min:null,max:null}];
 const motor={path:'motor1',address:'0x20010000',time:Date.now()/1000,family:'DJI',online:true,
  fields:{'state_.enable':true,'state_.mode':6,'state_.output_shaft_theta':0,'state_.target':0,'omega_pid_.kp_':12},
  control:{fields:descriptors,mode:6,enable:{supported:true,reason:'软件使能'},angle:{field:'state_.target',feedback:'state_.output_shaft_theta',absolute:false}}};
 const sent=[],enables=[],control=new MotorControl(doc.createElement('main'),state,{write:async request=>{sent.push(request);return {complete:true,time:Date.now()/1000,results:request.updates.map(item=>({...item,requested:item.value,before:0,readback:item.value,matched:true}))};},
  enable:async request=>{enables.push(request);return {complete:true,time:Date.now()/1000,motor:{...motor,fields:{...motor.fields,'state_.enable':request.enabled}}};},
  enableChanged:result=>{if(result?.motor)control.update({...result.motor,time:result.time});}});
 control.queue.interval=0;control.update(motor);
 try{await run({state,motor,control,sent,enables,doc});}finally{control.reset();globalThis.document=previousDocument;globalThis.window=previousWindow;}
}

test('live samples preserve a PID draft, then apply only edited fields with identity guards',()=>fixture(async({motor,control,sent})=>{
 const item=control.inputs.get('omega_pid_.kp_'),input=item.input;input.value='15.5';input.events.input();
 motor.fields['omega_pid_.kp_']=13;control.update({...motor,time:Date.now()/1000});
 assert.equal(control.inputs.get('omega_pid_.kp_').input,input);assert.equal(input.value,'15.5');assert.equal(item.current.textContent,'13');
 await control.applyFields(['omega_pid_.kp_']);
 assert.deepEqual(sent[0].updates,[{field:'omega_pid_.kp_',value:15.5}]);
 assert.equal(sent[0].address,'0x20010000');assert.equal(sent[0].mode,6);assert.equal(sent[0].sha,'elf-one');assert.equal(item.dirty,false);
}));

test('advanced switches require disable, preserve drafts, and submit a mask with its original value',()=>fixture(async({motor,control,sent})=>{
 const ring='omega_pid_',group='速度环 PID';
 motor.control.fields.push(...['ScalarA','ScalarB'].map(key=>({field:ring+'.'+key,label:key,group,unit:'rad/s',min:0,max:null,requiresDisabled:true})),{field:ring+'.mode_',label:'算法开关',group,unit:'bitmask',min:0,max:255,kind:'pidFlags',requiresDisabled:true,options:[{bit:32,label:'变速积分'}]});
 Object.assign(motor.fields,{'omega_pid_.ScalarA':.5,'omega_pid_.ScalarB':.1,'omega_pid_.mode_':0x88});control.update(motor);
 let flag=control.inputs.get(ring+'.mode_');assert.equal(flag.flags.get(32).disabled,true);
 motor.fields['state_.enable']=false;control.update(motor);assert.equal(flag.flags.get(32).disabled,false);
 flag.flags.get(32).checked=true;flag.flags.get(32).events.change();
 motor.fields[ring+'.mode_']=0x98;control.update({...motor,time:Date.now()/1000});
 assert.equal(control.inputs.get(ring+'.mode_'),flag);assert.equal(Number(flag.input.value),0xa8);assert.equal(flag.expected,0x88);
 await control.applyFields([ring+'.mode_']);assert.deepEqual(sent[0].updates,[{field:ring+'.mode_',value:0xa8,expected:0x88}]);
}));

test('invalid changing-integral A/B cannot be submitted from the form',()=>fixture(async({motor,control,sent})=>{
 motor.fields['state_.enable']=false;
 for(const [key,value]of [['ScalarA',0],['ScalarB',.1]]){motor.fields['omega_pid_.'+key]=value;motor.control.fields.push({field:'omega_pid_.'+key,label:key,group:'速度环 PID',min:0,max:null,requiresDisabled:true});}
 motor.fields['omega_pid_.mode_']=0;motor.control.fields.push({field:'omega_pid_.mode_',label:'算法开关',group:'速度环 PID',min:0,max:255,kind:'pidFlags',requiresDisabled:true,options:[{bit:32,label:'变速积分'}]});control.update(motor);
 const item=control.inputs.get('omega_pid_.mode_');item.flags.get(32).checked=true;item.flags.get(32).events.change();
 await control.applyFields(['omega_pid_.mode_']);assert.equal(sent.length,0);assert.match(control.feedbackText,/A > 0/);
}));

test('drag writes output-shaft targets, keeps continuous turns and stops queued commands on pause',()=>fixture(async({motor,control,state,sent})=>{
 motor.fields['state_.target']=359*Math.PI/180;control.update(motor);
 const event=(x,y)=>({clientX:x,clientY:y,button:0,pointerId:1,preventDefault(){}});
 control.gauge.events.pointerdown(event(118,32));
 control.gauge.events.pointermove(event(122,32));
 assert.ok(control.drag.value>2*Math.PI);
 state.running=false;control.refreshControls();await tick();
 assert.equal(sent.length,1);assert.equal(sent[0].updates[0].field,'state_.target');assert.equal(control.drag,null);assert.equal(control.queue.pending,null);
 assert.equal(control.angleApply.disabled,true);
}));

test('mode changes rebuild controls and discard a target drafted in the old mode',()=>fixture(async({motor,control})=>{
 control.previewValue=5;control.previewPending=true;
 control.update({...motor,control:{fields:[],mode:2,angle:null}});
 assert.equal(control.angleApply,null);assert.equal(control.previewPending,false);assert.equal(control.canTarget(),false);
}));

test('keyboard angle control converts degrees to radians and avoids feedback writes',()=>fixture(async({control,sent})=>{
 control.gauge.events.keydown({key:'ArrowRight',shiftKey:true,preventDefault(){}});await tick();
 assert.ok(Math.abs(sent[0].updates[0].value-Math.PI/18)<1e-12);
 assert.equal(sent[0].updates[0].field,'state_.target');
}));

test('enable switch works while paused, follows readback and never auto-enables on update',()=>fixture(async({control,motor,state,enables})=>{
 state.running=false;motor.time=1;control.update(motor);
 assert.equal(control.enableBinding.button.disabled,false);
 await control.setEnabled(motor,false);
 assert.deepEqual(enables[0],{path:'motor1',address:'0x20010000',mode:6,sha:'elf-one',enabled:false});
 assert.equal(control.enableBinding.button.attrs['aria-checked'],'false');
 assert.equal(control.angleApply.disabled,true);
 control.update({...control.motor,time:Date.now()/1000});assert.equal(enables.length,1);
 await control.setEnabled(control.motor,true);
 assert.equal(control.enableBinding.button.attrs['aria-checked'],'true');
 assert.equal(enables.length,2);
}));

test('disable cancels queued targets and waits for an in-flight write before switching',()=>fixture(async({control,motor,enables})=>{
 let release;const order=[];
 control.hooks.write=async()=>{order.push('target');await new Promise(resolve=>{release=resolve;});return {complete:true,time:Date.now()/1000,results:[]};};
 const enable=control.hooks.enable;control.hooks.enable=async request=>{order.push('disable');return enable(request);};
 control.sendAngle(1);control.sendAngle(2);
 const operation=control.setEnabled(motor,false);
 assert.equal(control.queue.pending,null);assert.equal(control.canTarget(),false);
 assert.equal(control.enableBinding.button.disabled,true);
 assert.equal(control.enableBinding.button.attrs['aria-checked'],'true');
 assert.equal(enables.length,0);
 await control.setEnabled(motor,true);assert.equal(enables.length,0);
 release();await operation;await tick();
 assert.deepEqual(order,['target','disable']);assert.equal(enables.length,1);
 assert.equal(control.queue.pending,null);assert.equal(control.canTarget(),false);
}));

test('failed and overridden enables stay explicit and use board state rather than requested state',()=>fixture(async({control,motor})=>{
 control.hooks.enable=async()=>({complete:false,time:Date.now()/1000,motor});
 await control.setEnabled(motor,false);
 assert.equal(control.enableBinding.button.attrs['aria-checked'],'true');
 assert.ok(control.enableBinding.status.textContent.includes('未确认'));
 control.hooks.enable=async()=>{throw Error('probe lost');};
 await control.setEnabled(motor,false);
 assert.equal(control.enableBinding.button.attrs['aria-checked'],'true');
 assert.ok(control.enableBinding.status.textContent.includes('probe lost'));
 assert.equal(control.enablePending.size,0);
}));

test('a later firmware re-enable replaces the old disable confirmation',()=>fixture(async({control,motor})=>{
 await control.setEnabled(motor,false);
 control.update({...control.motor,fields:{...control.motor.fields,'state_.enable':true}});
 assert.equal(control.enableBinding.button.attrs['aria-checked'],'true');
 assert.ok(control.enableBinding.status.textContent.includes('板端使能状态已变化'));
}));

test('unsupported or disconnected motors cannot toggle, and pending actions cannot survive ELF change',()=>fixture(async({control,motor,state,enables})=>{
 const dm={...motor,family:'DM',control:{...motor.control,enable:{supported:false,reason:'需要固件命令'}}};
 control.update(dm);assert.equal(control.enableBinding.button.disabled,true);
 await control.setEnabled(dm,false);assert.equal(enables.length,0);
 control.update(motor);state.connected=false;control.refreshControls();
 assert.equal(control.enableBinding.button.disabled,true);
 await control.setEnabled(motor,false);assert.equal(enables.length,0);
 state.connected=true;
 let release;control.writeInFlight=new Promise(resolve=>{release=resolve;});
 const action=control.setEnabled(motor,false);state.generation++;release();await action;
 assert.equal(enables.length,0);assert.equal(control.enablePending.size,0);
}));
