import test from 'node:test';
import assert from 'node:assert/strict';
import {axisTicks,nearestFrame,TimeViewport,MotorPlots} from '../frontend/assets/js/motor-plots.js';

test('axes provide several readable ticks at tiny, signed and epoch scales',()=>{
 for(const [lo,hi] of [[-.11,.14],[.00001,.00008],[-2000,7000],[1794800000,1794800030]]){
  const ticks=axisTicks(lo,hi);assert.ok(ticks.length>=3&&ticks.length<=10);
  assert.ok(ticks.every((value,i)=>value>=lo&&value<=hi&&(!i||value>ticks[i-1])));
 }
 assert.deepEqual(axisTicks(1,1),[]);
});
test('time zoom anchors the pointer, pans absolute history, and resumes live data only explicitly',()=>{
 const view=new TimeViewport(),frames=[{time:100},{time:140}];
 assert.deepEqual(view.range(frames),[110,140]);view.zoom(frames,.5,.25);
 assert.deepEqual(view.range(frames),[113.75,128.75]);assert.equal(view.follow,false);
 frames.push({time:145});assert.deepEqual(view.range(frames),[113.75,128.75]);
 view.pan(frames,-5);assert.deepEqual(view.range(frames),[108.75,123.75]);view.reset();assert.deepEqual(view.range(frames),[115,145]);
});
test('cursor chooses an actual sample, including boundaries and missing histories',()=>{
 const frames=[{time:1},{time:2},{time:5}];assert.equal(nearestFrame(frames,3),frames[1]);assert.equal(nearestFrame(frames,-1),frames[0]);assert.equal(nearestFrame(frames,10),frames[2]);assert.equal(nearestFrame([],2),undefined);
});

class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.events={};this.style={};this.captures=new Set();}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
 setAttribute(key,value){this.attrs[key]=String(value);}
 addEventListener(name,handler){this.events[name]=handler;}
 getBoundingClientRect(){return {left:0,top:0,width:600,height:230};}
 setPointerCapture(id){this.captures.add(id);}
 hasPointerCapture(id){return this.captures.has(id);}
 releasePointerCapture(id){this.captures.delete(id);}
}
function fixture(run){const previous=globalThis.document;globalThis.document={createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag)};
 try{const plots=new MotorPlots(new Node('div')),frames=[{time:100,motor:{value:0}},{time:101,motor:{}},{time:102,motor:{value:1}},{time:103,motor:{value:2}}],definitions=Array.from({length:4},(_,i)=>({title:'图 '+i,unit:'A',series:[{name:'反馈',color:'#287963',read:m=>m.value}]}));plots.update('one',frames,definitions);run({plots,frames,definitions});plots.destroy();}finally{globalThis.document=previous;}}
test('four persistent charts preserve zoom, vertical range and cursor through streaming; missing values break lines',()=>fixture(({plots,frames,definitions})=>{
 assert.equal(plots.charts.length,4);const chart=plots.charts[0],graph=chart.graph;
 const group=graph.children.find(n=>n.tagName==='g');assert.equal((group.children[0].attrs.d.match(/M/g)||[]).length,2);
 assert.ok(graph.children.filter(n=>n.tagName==='text').length>=5);
 graph.events.wheel({preventDefault(){},clientX:585,clientY:50,deltaY:-100,shiftKey:false});
 const range=[...plots.viewport.fixed];chart.yRange=[-2,3];plots.cursor=102;
 frames.push({time:104,motor:{value:3}});plots.update('one',frames,definitions);
 assert.equal(plots.charts[0].graph,graph);assert.deepEqual(plots.viewport.fixed,range);assert.deepEqual(chart.yRange,[-2,3]);assert.equal(plots.cursor,102);
 assert.equal(chart.readings[0].textContent,'反馈 1');
 plots.update('two',frames,definitions);assert.notEqual(plots.charts[0].graph,graph);assert.equal(plots.viewport.follow,true);assert.equal(plots.cursor,null);
}));
test('pointer drag pans all four charts, Shift pans only one Y axis, and reset returns to follow',()=>fixture(({plots})=>{
 const chart=plots.charts[0],graph=chart.graph;
 graph.events.pointerdown({button:0,preventDefault(){},pointerId:1,clientX:300,clientY:50,shiftKey:false});
 graph.events.pointermove({pointerId:1,clientX:350,clientY:50});assert.equal(plots.viewport.follow,false);assert.ok(plots.viewport.fixed[1]<103);
 graph.events.pointerup({pointerId:1});assert.equal(chart.drag,null);
 const range=[...plots.viewport.fixed];graph.events.pointerdown({button:0,preventDefault(){},pointerId:2,clientX:300,clientY:50,shiftKey:true});graph.events.pointermove({pointerId:2,clientX:300,clientY:80});graph.events.pointerup({pointerId:2});
 assert.deepEqual(plots.viewport.fixed,range);assert.ok(chart.yRange);assert.equal(plots.charts[1].yRange,null);
 graph.events.dblclick();assert.equal(plots.viewport.follow,true);assert.equal(chart.yRange,null);
}));
test('an empty panned window never presents an out-of-window sample as a cursor value',()=>fixture(({plots})=>{
 plots.viewport.fixed=[200,210];plots.viewport.follow=false;plots.cursor=205;plots.draw();
 assert.equal(plots.charts[0].readings[0].textContent,'反馈 —');assert.equal(plots.charts[0].status.textContent,'当前窗口无采样');
}));
