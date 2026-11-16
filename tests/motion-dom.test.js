import test from 'node:test';
import assert from 'node:assert/strict';
import {MotionDashboard} from '../frontend/assets/js/motion.js';
import {emptyModules} from '../frontend/assets/js/profiles.js';
import {mechanismLibrary,selectMechanism,slots} from '../frontend/assets/js/mechanisms.js';

// Minimal DOM fixture for rendering and delegated handlers; no probe or browser.
class Node {
 constructor(tag,doc){this.tagName=tag;this.doc=doc;this.children=[];this.attrs={};this.dataset={};this.style={};this.className='';this._text='';this.scrollTop=0;this.offsetWidth=310;this.offsetHeight=480;
  this.classList={toggle:(name,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));if(on)names.add(name);else names.delete(name);this.className=[...names].join(' ');}};}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 setAttribute(key,value){this.attrs[key]=String(value);if(key==='class')this.className=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5)]=String(value);}
 removeAttribute(key){delete this.attrs[key];}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const node of this.children)node.parent=null;this.children=[];this._text='';this.append(...nodes);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
 matches(selector){if(selector.startsWith('.'))return this.className.split(' ').includes(selector.slice(1));if(selector==='[data-motor]')return !!this.dataset.motor;if(selector.startsWith('[data-motor='))return this.dataset.motor===selector.slice(13,-2);return this.tagName===selector;}
 querySelectorAll(selector){const selectors=selector.split(',');return this.children.flatMap(c=>[...(selectors.some(s=>c.matches(s))?[c]:[]),...c.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)||null;}
 contains(node){return node===this||this.children.some(c=>c.contains(node));}
 getBoundingClientRect(){return {right:200,top:150};}
 focus(){this.doc.activeElement=this;let node=this;while(node){node.onfocusin?.({target:this});node=node.parent;}}
}

function fixture(page,run){
 const oldDocument=globalThis.document,oldWindow=globalThis.window;
 const doc={createElement:tag=>new Node(tag,doc),createElementNS:(_,tag)=>new Node(tag,doc),createTextNode:text=>{const n=new Node('#text',doc);n.textContent=text;return n;}};
 doc.activeElement=doc.createElement('body');globalThis.document=doc;globalThis.window={innerWidth:1000,innerHeight:800};
 try{
  const modules=emptyModules(),latest=new Map();
  if(page==='vehicle')modules.vehicle.enabled=true;else for(const name of ['gimbal','chassis'])modules[name].enabled=true;
  for(const key of ['fl','fr','bl','br','yaw','pitch']){
   const slot=key==='yaw'||key==='pitch'?modules.gimbal.axes[key]:modules.chassis.wheels[key];slot.motor=key;
   latest.set(key,{path:key,family:'DJI',status:'online',time:Date.now()/1000,fields:{'state_.mode':2,'state_.output_shaft_theta':.1,'state_.output_shaft_omega':2,'state_.target':3,'output_':100}});
  }
  const state={page,modules,watches:[],running:true,sha:'fixture'},root=doc.createElement('main');
  const dashboard=new MotionDashboard(root,state,{latest,catalog:[]},{changed(){},controls(){},scan(){}});
  const time=Date.now()/1000;for(const motor of latest.values())motor.time=time;
  dashboard.ingest(time);dashboard.configure(page);run({dashboard,root,state,latest,doc});
 }finally{globalThis.document=oldDocument;globalThis.window=oldWindow;}
}

test('gimbal renders one combined pose and keeps missing feedback explicit',()=>fixture('gimbal',({dashboard,root,state})=>{
 assert.equal(root.querySelectorAll('.gimbal-view').length,1);
 assert.equal(root.querySelector('.gimbal-view').children.filter(node=>node.tagName==='svg').length,1);
 assert.equal(root.querySelectorAll('.yaw-compass').length,1);
 assert.equal(root.querySelectorAll('.gimbal-axis-reading').length,2);
 state.watches=[{path:'missing',valid:true,value:null,lastTime:1,scale:1}];
 state.modules.gimbal.bindings.pitch='missing';dashboard.reset('gimbal');dashboard.render();
 assert.ok(root.textContent.includes('Pitch 无反馈'));
}));

test('wheel hover survives frame replacement, supports pin, focus and Escape, and marks history',()=>fixture('chassis',({dashboard,root,state,latest,doc})=>{
 const visual=dashboard.visual;let wheel=visual.querySelector('[data-motor="fl"]');
 assert.equal(visual.querySelectorAll('[data-motor]').length,4);
 visual.onpointermove({target:wheel,clientX:980,clientY:780});
 let tip=root.querySelector('.wheel-tooltip');assert.ok(tip.textContent.includes('左前 FL'));assert.ok(tip.textContent.includes('100 raw'));
 assert.ok(parseFloat(tip.style.left)+tip.offsetWidth<=992);assert.ok(parseFloat(tip.style.top)+tip.offsetHeight<=792);
 latest.get('fl').fields.output_=321;const time=Date.now()/1000;for(const motor of latest.values())motor.time=time;dashboard.ingest(time);dashboard.render();
 tip=root.querySelector('.wheel-tooltip');assert.ok(tip.textContent.includes('321 raw'));
 wheel=visual.querySelector('[data-motor="fl"]');visual.onclick({target:wheel});visual.onpointerleave();
 visual.onpointermove({target:visual,clientX:20,clientY:20});assert.ok(root.querySelector('.wheel-tooltip').textContent.includes('已固定'));
 state.running=false;dashboard.render();assert.ok(root.querySelector('.wheel-tooltip').textContent.includes('历史值'));
 visual.onkeydown({target:visual,key:'Escape',preventDefault(){}});assert.equal(root.querySelector('.wheel-tooltip'),null);
 wheel=visual.querySelector('[data-motor="fr"]');wheel.focus();dashboard.render();
 assert.equal(doc.activeElement.dataset.motor,'fr');assert.ok(root.querySelector('.wheel-tooltip').textContent.includes('右前 FR'));
 state.modules.chassis.wheels.fr.motor='';dashboard.reset('chassis');dashboard.render();
 visual.onpointermove({target:visual.querySelector('[data-motor="fr"]'),clientX:100,clientY:100});
 assert.ok(root.querySelector('.wheel-tooltip').textContent.includes('请在构型设置中绑定'));
}));

test('both gimbal motor hotspots show live fields, preserve keyboard focus and report missing bindings',()=>fixture('gimbal',({dashboard,root,state,latest,doc})=>{
 const visual=dashboard.visual;assert.equal(visual.querySelectorAll('[data-motor]').length,2);
 for(const key of ['yaw','pitch']){const axis=visual.querySelector('[data-motor="'+key+'"]');visual.onpointermove({target:axis,clientX:200,clientY:200});const tip=root.querySelector('.wheel-tooltip');
  assert.ok(tip.textContent.includes((key==='yaw'?'Yaw':'Pitch')+' · 电机数据'));assert.ok(tip.textContent.includes('输出轴 ω'));assert.ok(tip.textContent.includes('姿态反馈 / 目标'));}
 latest.get('pitch').fields.output_=456;const time=Date.now()/1000;for(const motor of latest.values())motor.time=time;dashboard.ingest(time);dashboard.render();
 assert.ok(root.querySelector('.wheel-tooltip').textContent.includes('456 raw'));
 visual.querySelector('[data-motor="yaw"]').focus();dashboard.render();assert.equal(doc.activeElement.dataset.motor,'yaw');
 state.modules.gimbal.axes.yaw.motor='';dashboard.reset('gimbal');dashboard.render();
 visual.onpointermove({target:visual.querySelector('[data-motor="yaw"]'),clientX:200,clientY:200});assert.ok(root.querySelector('.wheel-tooltip').textContent.includes('绑定此轴电机'));
}));

test('Omni wheel positions and drive axes match in top and whole-vehicle views, with legible yaw reference',()=>{
 const results={};
 for(const page of ['chassis','vehicle'])fixture(page,({dashboard,root,state})=>{
  state.modules.chassis.layout='omni';dashboard.reset(page);dashboard.render();results[page]={};
  for(const [key,angle]of Object.entries({fl:-Math.PI/4,fr:Math.PI/4,bl:Math.PI/4,br:-Math.PI/4})){
   const wheel=root.querySelector('[data-motor="'+(page==='vehicle'?'chassis:':'')+key+'"]');
   assert.equal(Number(wheel.attrs['data-wheel-angle']),angle);
   results[page][key]=[wheel.attrs['data-wheel-x'],wheel.attrs['data-wheel-y'],wheel.attrs['data-wheel-angle']];
   assert.ok(wheel.attrs['aria-label'].includes(key.toUpperCase()));
  }
  assert.ok(!root.textContent.includes('左后 RL'));assert.ok(!root.textContent.includes('右后 RR'));
  if(page==='vehicle'){assert.equal(root.querySelectorAll('.yaw-overview').length,1);assert.equal(root.querySelectorAll('.yaw-bearing').length,1);assert.ok(root.textContent.includes('蓝：车头'));}
 });
 assert.deepEqual(results.chassis,results.vehicle);
});

test('vehicle page renders a combined car with six interactive motors while individual pages stay disabled',()=>fixture('vehicle',({dashboard,root,state,latest})=>{
 assert.equal(state.modules.gimbal.enabled,false);assert.equal(state.modules.chassis.enabled,false);
 assert.equal(dashboard.frames.vehicle.length,1);assert.equal(dashboard.frames.gimbal.length,0);
 dashboard.reset('gimbal',false);assert.equal(dashboard.frames.vehicle.length,1);
 assert.equal(root.querySelectorAll('.vehicle-view').length,1);assert.equal(root.querySelectorAll('[data-motor]').length,6);
 assert.ok(root.textContent.includes('合成瞄向'));
 for(const key of ['gimbal:yaw','gimbal:pitch','chassis:fl','chassis:fr','chassis:bl','chassis:br']){dashboard.visual.onpointermove({target:root.querySelector('[data-motor="'+key+'"]'),clientX:100,clientY:100});assert.ok(root.querySelector('.wheel-tooltip').textContent.includes('100 raw'));}
 state.modules.chassis.layout='omni';dashboard.render();assert.ok(root.textContent.includes('OMNI'));assert.equal(root.querySelectorAll('[data-motor]').length,6);
 dashboard.pause();const time=dashboard.frames.vehicle.at(-1).time+.2;for(const motor of latest.values())motor.time=time;dashboard.ingest(time);dashboard.render();
 assert.ok(root.textContent.includes('航向积分连续性中断'));assert.equal(dashboard.frames.vehicle.at(-1).pose.heading,null);
 dashboard.reset('vehicle');for(const motor of latest.values())motor.time=time+.2;dashboard.ingest(time+.2);dashboard.render();assert.equal(dashboard.frames.vehicle.at(-1).pose.heading,0);
}));

test('multi-joint configuration creates all readouts and interactive motors on both pages',()=>{
 for(const model of mechanismLibrary.gimbal.filter(m=>m.id!=='yaw-pitch'))for(const page of ['gimbal','vehicle'])fixture(page,({dashboard,root,state,latest})=>{
  selectMechanism(state.modules.gimbal,'gimbal',model);
  selectMechanism(state.modules.chassis,'chassis',mechanismLibrary.chassis[2]);
  const time=Date.now()/1000;
  for(const kind of ['gimbal','chassis'])for(const {id}of slots(state.modules[kind],kind)){
   state.modules[kind][kind==='gimbal'?'axes':'wheels'][id].motor=id;
   latest.set(id,{path:id,family:'DJI',status:'online',time,fields:{'state_.mode':kind==='gimbal'?6:2,'state_.output_shaft_theta':0,'state_.output_shaft_omega':0,'state_.target':0,'output_':123}});
  }
  dashboard.reset();dashboard.ingest(time);dashboard.configure(page);
  assert.equal(root.querySelectorAll('[data-motor]').length,page==='vehicle'?5:3);
  if(page==='gimbal')assert.equal(root.querySelectorAll('.gimbal-axis-reading').length,3);
  const axis=model.id==='dual-yaw'?'smallYaw':'fold',key=(page==='vehicle'?'gimbal:':'')+axis;
  dashboard.visual.onpointermove({target:root.querySelector('[data-motor="'+key+'"]'),clientX:100,clientY:100});
  assert.ok(root.querySelector('.wheel-tooltip').textContent.includes('123 raw'));
  assert.ok(root.querySelector('.wheel-tooltip').textContent.includes(model.joints.find(j=>j.id===axis).label+' · 电机数据'));
  assert.equal(root.querySelector('.mechanism-feedback').attrs['data-direction'],'1,0,0');
 });
});
