import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunicationDashboard,filterFrames} from '../frontend/assets/js/communications.js';
import {emptyModules,normalizeModules,snapshotProfile} from '../frontend/assets/js/profiles.js';

class Node{
 constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.className='';this._text='';this.classList={toggle:()=>{}};}
 set textContent(text){this._text=String(text);this.children=[];}
 get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
 setAttribute(k,v){this.attrs[k]=v;}
}

function fixture(run){
 const previous=globalThis.document;globalThis.document={createElement:tag=>new Node(tag)};
 try{const state={modules:emptyModules(),page:'communications',running:true,connected:true,sha:'fixture'};
  state.modules.communications.enabled=true;
  let changes=0;const dashboard=new CommunicationDashboard(new Node('main'),state,{changed(){changes++;},controls(){},scan(){}});
  dashboard.setCatalog({items:[{path:'bridge',family:'can_bridge',capture:true,type:'communication::CanBridge'},{path:'referee',family:'referee_new',capture:false,type:'referee_comm::Referee'}],note:'合成测试'});
  dashboard.select.value='bridge';dashboard.select.onchange();run({dashboard,state,changes});
 }finally{globalThis.document=previous;}
}

test('communication link preferences restore per ELF without watches',()=>{
 const modules=normalizeModules({communications:{enabled:true,selected:'referee',direction:'TX',filter:'0201'}});
 const copy=snapshotProfile({modules,watches:[],elfPath:'a.elf'},{});
 modules.communications.selected='other';assert.equal(copy.modules.communications.selected,'referee');assert.equal(copy.modules.communications.direction,'TX');
});

test('switching links retains independent cursor and does not reuse snapshots',()=>fixture(({dashboard,state})=>{
 assert.deepEqual(dashboard.request(),{path:'bridge',after:0});
 dashboard.ingest({path:'bridge',cursor:8,capture:true,fields:{id:1},frames:[{sequence:8,timeMs:4,direction:'RX',id:0x201,hex:'01'}]},Date.now()/1000);
 dashboard.select.value='referee';dashboard.select.onchange();assert.deepEqual(dashboard.request(),{path:'referee',after:0});
 assert.ok(dashboard.status.textContent.includes('等待'));assert.equal(dashboard.stream().frames.length,0);
 dashboard.select.value='bridge';dashboard.select.onchange();assert.equal(dashboard.request().after,8);assert.equal(dashboard.stream().frames.length,1);
 state.modules.communications.enabled=false;assert.equal(dashboard.request(),null);
}));

test('pause, errors and missing saved links stay explicit; snapshots are not packets',()=>fixture(({dashboard,state})=>{
 dashboard.ingest({path:'bridge',cursor:0,capture:false,frames:[],fields:{unchanged:0}},Date.now()/1000);
 dashboard.render();assert.ok(dashboard.status.textContent.includes('仅字段快照'));assert.equal(dashboard.stream().frames.length,0);
 state.running=false;dashboard.render();assert.ok(dashboard.status.textContent.includes('历史快照'));
 dashboard.ingest({path:'bridge',cursor:0,error:'对象为空',frames:[],fields:{}},Date.now()/1000);dashboard.render();assert.ok(dashboard.status.textContent.includes('对象为空'));
 dashboard.setCatalog({items:[],note:''});assert.equal(dashboard.request(),null);assert.equal(state.modules.communications.selected,'bridge');assert.ok(dashboard.select.textContent.includes('未找到'));
}));

test('raw ID, payload, decoded values and direction filters combine',()=>{
 const frames=[{direction:'RX',id:0x201,hex:'01 FF',decoded:{robot_id:3}},{direction:'TX',id:0x201,hex:'02'}, {direction:'RX',id:0x202,command:'power_heat_data',hex:'00'}];
 assert.equal(filterFrames(frames,{direction:'RX',filter:'0201'}).length,1);
 assert.equal(filterFrames(frames,{direction:'all',filter:'ff'}).length,1);
 assert.equal(filterFrames(frames,{direction:'all',filter:'power_heat'}).length,1);
});

test('retention and firmware reset are bounded, including repeated payloads',()=>fixture(({dashboard})=>{
 const frames=Array.from({length:2100},(_,i)=>({sequence:i+1,direction:'RX',id:1,hex:'00'}));
 dashboard.ingest({path:'bridge',cursor:2100,frames,dropped:5},1);assert.equal(dashboard.stream().frames.length,2000);assert.equal(dashboard.stream().dropped,5);
 dashboard.ingest({path:'bridge',cursor:1,reset:true,frames:[frames[0]]},2);assert.equal(dashboard.stream().frames.length,1);assert.equal(dashboard.stream().dropped,0);
}));
