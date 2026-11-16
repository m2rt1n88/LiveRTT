import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMotorAiBundle,motorAiPrompt,describeMotorMode,MotorAiPanel} from '../frontend/assets/js/motor-ai.js';

function fixture(){
 const motor={path:'private.symbol',address:'0x20010000',time:100,family:'DJI',online:true,fields:{
  'state_.mode':6,'state_.enable':true,'state_.target':1,'state_.output_shaft_theta':.5,'state_.output_shaft_omega':2,
  'omega_pid_.kp_':12,'omega_pid_.mode_':65,'omega_pid_.Derivative_Filtering_Coefficient':.5,
  'callback_':536900000,'can_':536880000},
  control:{fields:[{field:'omega_pid_.kp_',label:'Kp',unit:'',min:null,max:null},{field:'callback_',label:'bad'}]}};
 return {motor,sha:'a'.repeat(64),goal:'减少跟踪偏差',context:'空载、人工拖动目标',now:101,seconds:30,
  frames:[{time:60,motors:[motor]},{time:90,motors:[{...motor,time:90,fields:{...motor.fields,'omega_pid_.kp_':10}}]},{time:100,motors:[motor]}],
  events:[{path:motor.path,time:100,text:'secret token and local path'}]};
}

test('AI brief uses only the focused window, strips private data, and includes PID feature and parameter changes',()=>{
 const input=fixture();input.elfPath='C:/private/build.elf';input.token='secret';
 const bundle=buildMotorAiBundle(input),text=JSON.stringify(bundle);
 assert.equal(bundle.quality.sample_count,2);assert.equal(bundle.quality.available_span_s,10);
 assert.equal(bundle.quality.downsampling,'none; all retained samples in selected window');
 assert.equal(bundle.motor.mode,'THETA + OMEGA cascade');
 assert.deepEqual(bundle.motor.pid_features.omega_pid_.enabled_features,['Integral_Limit','DerivativeFilter']);
 assert.deepEqual(bundle.observed_parameter_changes.items,[{field:'omega_pid_.kp_',before:10,after:12,host_window_s:[90,100],source:'observed_change_unknown_writer'}]);
 assert.equal(bundle.current_snapshot.values['omega_pid_.kp_'],12);
 assert.deepEqual(bundle.writable_fields.map(item=>item.field),['omega_pid_.kp_']);
 for(const secret of [input.motor.path,input.motor.address,'C:/private','secret','callback_','can_'])assert.ok(!text.includes(secret),secret);
 assert.equal(bundle.writable_fields[0].engineering_bounds,null);
 assert.equal(bundle.firmware.source_matches_elf,'unknown');
 assert.equal(bundle.quality.firmware_sample_loss,null);
 assert.ok(motorAiPrompt(bundle).includes('具体数值留空'));
 assert.deepEqual(JSON.parse(motorAiPrompt(bundle).split(String.fromCharCode(10,10)).at(-1)),bundle);
});

test('missing, nonfinite and failed fields remain distinct from zero, and a one-sample history has no fabricated rate',()=>{
 const input=fixture();input.motor.fields['omega_pid_.kd_']=NaN;input.motor.fields['omega_pid_.ki_']=0;
 input.motor.fieldErrors={'omega_pid_.kd_':'private error path'};input.frames=[{time:100,motors:[input.motor]}];
 const bundle=buildMotorAiBundle(input),f=bundle.current_snapshot;
 assert.equal(f.values['omega_pid_.kd_'],null);assert.equal(f.values['omega_pid_.ki_'],0);
 assert.ok(f.missing_fields.includes('theta_pid_.kp_'));assert.ok(f.failed_fields.includes('omega_pid_.kd_'));
 assert.equal(bundle.quality.missing_count_by_field['omega_pid_.kd_'],1);
 assert.equal(bundle.quality.observed_batch_hz,null);assert.equal(bundle.quality.available_span_s,0);
 assert.ok(!JSON.stringify(bundle).includes('private error'));
 assert.doesNotThrow(()=>JSON.parse(JSON.stringify(bundle)));
});

test('family modes and address changes cannot silently masquerade as a normal cascade trial',()=>{
 const input=fixture();input.frames[1].motors[0].address='0x20020000';
 assert.equal(buildMotorAiBundle(input).quality.object_identity_changed,true);
 assert.match(describeMotorMode({...input.motor,fields:{'state_.mode':7}}),/^CURRENT/);
 assert.match(describeMotorMode({...input.motor,fields:{'state_.mode':4}}),/not a cascade/);
 assert.match(describeMotorMode({family:'DM',fields:{'state_.mode':256}}),/speed limit/);
 assert.equal(describeMotorMode({family:'DJI',fields:{}}),'unknown');
 assert.throws(()=>buildMotorAiBundle({...input,frames:[]}),/没有保留的采样/);
 assert.throws(()=>buildMotorAiBundle({...input,seconds:1000}),/数据窗口/);
 assert.throws(()=>buildMotorAiBundle({...input,frames:Array.from({length:601},()=>({time:100,motors:[input.motor]}))}),/600/);
});

class Node {
 constructor(tag,doc){this.tagName=tag;this.doc=doc;this.children=[];this.value='';this.text='';this.attrs={};}
 set textContent(value){this.text=String(value);this.children=[];}
 get textContent(){return this.text+this.children.map(n=>n.textContent).join('');}
 append(...nodes){this.children.push(...nodes);}
 setAttribute(key,value){this.attrs[key]=String(value);}
 focus(){this.doc.activeElement=this;}
 select(){this.selected=true;}
}
function panelFixture(run){
 const previousDocument=globalThis.document;
 const doc={createElement:tag=>new Node(tag,doc)};globalThis.document=doc;
 try{const input=fixture(),state={sha:input.sha,generation:1,busy:false},root=new Node('div',doc),panel=new MotorAiPanel(root,state);
  panel.update(input.motor,input.frames,input.events);return run({input,state,root,panel});
 }finally{globalThis.document=previousDocument;}
}

test('live samples preserve frozen material and pasted advice; motor/session changes clear the association',()=>panelFixture(({input,state,panel})=>{
 panel.goal.value='目标说明';panel.generate.onclick();assert.ok(panel.bundle);assert.equal(panel.bundle.user_goal,'目标说明');
 const text=panel.output.value;panel.reply.value='<script>do not execute</script>';panel.reply.oninput();
 panel.update({...input.motor,time:101,fields:{...input.motor.fields,'omega_pid_.kp_':15}},input.frames,input.events);
 assert.equal(panel.output.value,text);assert.equal(panel.reply.value,'<script>do not execute</script>');assert.equal(panel.saveReply.disabled,false);
 state.busy=true;panel.refresh();assert.equal(panel.generate.disabled,true);assert.equal(panel.copy.disabled,false);
 state.generation++;panel.refresh();assert.equal(panel.bundle,null);assert.equal(panel.reply.value,'');assert.equal(panel.copy.disabled,true);
 panel.update(input.motor,input.frames,input.events);
 state.busy=false;panel.generate.onclick();panel.update({...input.motor,path:'other'},input.frames,[]);assert.equal(panel.output.value,'');assert.equal(panel.goal.value,'');
}));

test('pausing does not require a board write to prepare advice; unavailable clipboard falls back to selectable text',async()=>{
 const previousDocument=globalThis.document,previousNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const doc={createElement:tag=>new Node(tag,doc)};globalThis.document=doc;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{throw Error('denied');}}}});
 try{const input=fixture(),state={sha:input.sha,generation:1,running:false},panel=new MotorAiPanel(new Node('div',doc),state);
  panel.update(input.motor,input.frames,[]);assert.equal(panel.generate.disabled,false);panel.generate.onclick();await panel.copy.onclick();
  assert.equal(panel.output.selected,true);assert.ok(panel.status.textContent.includes('Ctrl+C'));
 }finally{globalThis.document=previousDocument;if(previousNavigator)Object.defineProperty(globalThis,'navigator',previousNavigator);else delete globalThis.navigator;}
});
