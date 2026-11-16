import {element as el} from './api.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const precise = value => finite(value) ? String(Number(value.toPrecision(7))) : '—';
const svg = (tag, attrs = {}, text) => {
 const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
 for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
 if (text !== undefined) node.textContent = text;
 return node;
};
export function axisTicks(lo, hi, count = 5) {
 if (!finite(lo) || !finite(hi) || hi <= lo) return [];
 const rough = (hi-lo)/count, power = 10**Math.floor(Math.log10(rough)), ratio = rough/power;
 const step = (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 2.5 ? 2.5 : ratio <= 5 ? 5 : 10)*power;
 const ticks = [];
 for (let n=Math.ceil(lo/step); n*step <= hi+step*1e-9 && ticks.length<20; n++) ticks.push(Number((n*step).toPrecision(12)));
 return ticks;
}
export function nearestFrame(frames, time) {
 let lo=0, hi=frames.length;
 while(lo<hi){const mid=(lo+hi)>>>1;if(frames[mid].time<time)lo=mid+1;else hi=mid;}
 if(!lo)return frames[0];if(lo===frames.length)return frames.at(-1);
 return time-frames[lo-1].time<=frames[lo].time-time?frames[lo-1]:frames[lo];
}
export class TimeViewport {
 constructor(){this.reset();}
 reset(){this.follow=true;this.span=30;this.fixed=null;}
 range(frames){const end=frames.at(-1)?.time??Date.now()/1000;return this.follow?[end-this.span,end]:this.fixed||[end-this.span,end];}
 zoom(frames,factor,anchor=.5){const [start,end]=this.range(frames),span=clamp((end-start)*factor,.1,120),time=start+(end-start)*anchor;this.fixed=[time-span*anchor,time+span*(1-anchor)];this.follow=false;}
 pan(frames,seconds){const [start,end]=this.range(frames);this.fixed=[start+seconds,end+seconds];this.follow=false;}
}

let nextId=0;
class MotorChart {
 constructor(owner,definition){
  this.owner=owner;this.definition=definition;this.id='motor-plot-clip-'+(++nextId);this.yRange=null;
  this.root=el('article','motor-plot motor-interactive-plot');const heading=el('div','motor-plot-heading');
  const auto=el('button','text-button','Y 自动');auto.type='button';auto.setAttribute('aria-label',definition.title+' Y 轴自动缩放');auto.onclick=()=>{this.yRange=null;this.draw();};
  const actions=el('div','motor-plot-actions');actions.append(auto);heading.append(el('h3','',definition.title+' · '+definition.unit),actions);this.root.append(heading);
  if(definition.help){const help=el('button','text-button','说明'),note=el('p','motor-plot-help',definition.help);help.type='button';help.setAttribute('aria-label',definition.title+'说明');help.setAttribute('aria-expanded','false');note.id=this.id+'-help';help.setAttribute('aria-controls',note.id);note.hidden=true;help.onclick=()=>{note.hidden=!note.hidden;help.setAttribute('aria-expanded',String(!note.hidden));};actions.append(help);this.root.append(note);}
  this.graph=svg('svg',{role:'img',tabindex:0,'aria-label':definition.title+'，滚轮缩放时间，拖动平移，Shift 操作纵轴，双击复位'});
  this.legend=el('div','motor-plot-legend');this.status=el('small','motor-plot-time');this.root.append(this.graph,this.legend,this.status);
  this.readings=definition.series.map(series=>{const node=el('span');node.style.color=series.color;this.legend.append(node);return node;});
  this.graph.addEventListener('wheel',event=>{event.preventDefault();const p=this.position(event);if(event.shiftKey||p.x<this.left){const range=this.yRange||this.autoRange(),anchor=clamp(1-(p.y-this.top)/this.height,0,1),value=range[0]+(range[1]-range[0])*anchor,span=clamp((range[1]-range[0])*Math.exp(clamp(event.deltaY,-200,200)*.004),1e-9,1e30);this.yRange=[value-span*anchor,value+span*(1-anchor)];this.draw();}else{owner.viewport.zoom(owner.frames,Math.exp(clamp(event.deltaY,-200,200)*.004),clamp((p.x-this.left)/this.width,0,1));owner.draw();}},{passive:false});
  this.graph.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();const p=this.position(event);this.drag={id:event.pointerId,x:p.x,y:p.y,xRange:owner.viewport.range(owner.frames),yRange:this.yRange||this.autoRange(),vertical:event.shiftKey||p.x<this.left};this.graph.setPointerCapture(event.pointerId);});
  this.graph.addEventListener('pointermove',event=>{const p=this.position(event);if(this.drag){if(event.pointerId!==this.drag.id)return;const d=this.drag;if(d.vertical){const offset=(p.y-d.y)/this.height*(d.yRange[1]-d.yRange[0]);this.yRange=d.yRange.map(v=>v+offset);}else{const offset=(d.x-p.x)/this.width*(d.xRange[1]-d.xRange[0]);owner.viewport.fixed=d.xRange.map(v=>v+offset);owner.viewport.follow=false;}}
   const range=owner.viewport.range(owner.frames);owner.cursor=range[0]+clamp((p.x-this.left)/this.width,0,1)*(range[1]-range[0]);owner.draw();
  });
  const finish=event=>{if(this.drag?.id!==event.pointerId)return;if(this.graph.hasPointerCapture(event.pointerId))this.graph.releasePointerCapture(event.pointerId);this.drag=null;};
  this.graph.addEventListener('pointerup',finish);this.graph.addEventListener('pointercancel',finish);this.graph.addEventListener('lostpointercapture',()=>{this.drag=null;});
  this.graph.addEventListener('pointerleave',()=>{if(!this.drag){owner.cursor=null;owner.draw();}});
  this.graph.addEventListener('dblclick',()=>{this.yRange=null;owner.viewport.reset();owner.cursor=null;owner.draw();});
  this.graph.addEventListener('keydown',event=>{const range=owner.viewport.range(owner.frames);if(['+','=','-','ArrowLeft','ArrowRight','Escape'].includes(event.key)){event.preventDefault();if(event.key==='Escape'){this.yRange=null;owner.viewport.reset();}else if(event.key.startsWith('Arrow'))owner.viewport.pan(owner.frames,(range[1]-range[0])*(event.key==='ArrowLeft'?-.1:.1));else owner.viewport.zoom(owner.frames,event.key==='-'?1.25:.8);owner.draw();}});
  if(typeof ResizeObserver!=='undefined'){this.observer=new ResizeObserver(()=>this.draw());this.observer.observe(this.graph);}
 }
 position(event){const r=this.graph.getBoundingClientRect();return {x:event.clientX-r.left,y:event.clientY-r.top};}
 visibleFrames(){const [start,end]=this.owner.viewport.range(this.owner.frames);return this.owner.frames.filter(row=>row.time>=start&&row.time<=end);}
 autoRange(){const values=this.visibleFrames().flatMap(row=>this.definition.series.map(s=>s.read(row.motor)).filter(finite));let lo=values.length?Math.min(...values):0,hi=values.length?Math.max(...values):1;const minimum=this.definition.unit==='A'?.02:this.definition.unit==='raw'?2:.2;if(hi-lo<minimum){const mid=(hi+lo)/2;lo=mid-minimum/2;hi=mid+minimum/2;}const pad=(hi-lo)*.12;return [lo-pad,hi+pad];}
 draw(){
  const graph=this.graph,rect=graph.getBoundingClientRect(),w=Math.max(240,rect.width||600),h=Math.max(120,rect.height||220);graph.setAttribute('viewBox','0 0 '+w+' '+h);graph.replaceChildren();
  this.left=68;this.top=12;this.width=w-this.left-14;this.height=h-this.top-25;
  const [start,end]=this.owner.viewport.range(this.owner.frames),[lo,hi]=this.yRange||this.autoRange(),x=time=>this.left+(time-start)/(end-start)*this.width,y=value=>this.top+this.height-(value-lo)/(hi-lo)*this.height;
  const defs=svg('defs'),clip=svg('clipPath',{id:this.id});clip.append(svg('rect',{x:this.left,y:this.top,width:this.width,height:this.height}));defs.append(clip);graph.append(defs);
  for(const value of axisTicks(lo,hi,7)){const pos=y(value);graph.append(svg('line',{x1:this.left,y1:pos,x2:w-14,y2:pos,stroke:value===0?'#aebfb6':'#e3ebe6'}),svg('text',{x:this.left-7,y:pos+3,'text-anchor':'end',fill:'#627c70','font-size':10},precise(value)));}
  for(const time of axisTicks(start,end,Math.max(2,Math.floor(this.width/95)))){const pos=x(time),date=new Date(time*1000),label=date.toLocaleTimeString('en-GB',{hour12:false})+(end-start<4?'.'+String(date.getMilliseconds()).padStart(3,'0').slice(0,1):'');graph.append(svg('line',{x1:pos,y1:this.top,x2:pos,y2:this.top+this.height,stroke:'#edf1ee'}),svg('text',{x:pos,y:h-6,'text-anchor':'middle',fill:'#738078','font-size':10},label));}
  const lines=svg('g',{'clip-path':'url(#'+this.id+')'}),frames=this.owner.frames;
  const intervals=frames.slice(1).map((row,i)=>row.time-frames[i].time).filter(v=>v>0).sort((a,b)=>a-b),gap=(intervals[Math.floor(intervals.length/2)]||1)*3;
  for(const series of this.definition.series){let d='',active=false,last=null;for(let i=0;i<frames.length;i++){const row=frames[i];if(row.time<start&&(frames[i+1]?.time??row.time)<start)continue;if(row.time>end&&(frames[i-1]?.time??row.time)>end)continue;const value=series.read(row.motor);if(!finite(value)){active=false;continue;}if(last!==null&&row.time-last>gap)active=false;d+=(active?'L':'M')+x(row.time).toFixed(2)+','+y(value).toFixed(2);active=true;last=row.time;}lines.append(svg('path',{d,fill:'none',stroke:series.color,'stroke-width':1.7,...(series.dash?{'stroke-dasharray':'5 4'}:{})}));}
  const visible=this.visibleFrames(),row=this.owner.cursor===null?visible.at(-1):nearestFrame(visible,this.owner.cursor),cursorTime=row?.time;
  if(this.owner.cursor!==null&&row&&cursorTime>=start&&cursorTime<=end){lines.append(svg('line',{x1:x(cursorTime),y1:this.top,x2:x(cursorTime),y2:this.top+this.height,stroke:'#627c70','stroke-dasharray':'3 3'}));for(const series of this.definition.series){const v=series.read(row.motor);if(finite(v))lines.append(svg('circle',{cx:x(cursorTime),cy:y(v),r:3,fill:series.color,stroke:'#fff'}));}}
  graph.append(lines);
  if(!this.visibleFrames().length)graph.append(svg('text',{x:this.left+this.width/2,y:this.top+this.height/2,'text-anchor':'middle',fill:'#91a499','font-size':12},'此时间范围没有采样'));
  this.readings.forEach((node,i)=>{const series=this.definition.series[i];node.textContent=series.name+' '+precise(row?series.read(row.motor):null);});
  this.status.textContent=row?(this.owner.cursor===null?(this.owner.viewport.follow?'最新采样 ':'窗口末采样 '):'光标最近采样 ')+new Date(row.time*1000).toLocaleTimeString('en-GB',{hour12:false})+'.'+String(Math.round(row.time*1000)%1000).padStart(3,'0')+' · '+this.definition.unit+(row.motor.online===false?' · 离线反馈':''):'当前窗口无采样';
 }
 destroy(){this.observer?.disconnect();}
}

export class MotorPlots {
 constructor(root){
  this.root=root;this.frames=[];this.cursor=null;this.viewport=new TimeViewport();this.charts=[];
  const toolbar=el('div','motor-plot-toolbar');this.follow=el('button','button subtle','跟随最新');const all=el('button','text-button','全部历史'),minus=el('button','text-button','−'),plus=el('button','text-button','＋');
  plus.setAttribute('aria-label','放大时间轴');minus.setAttribute('aria-label','缩小时间轴');
  this.follow.onclick=()=>{this.viewport.reset();this.cursor=null;this.draw();};all.onclick=()=>{if(this.frames.length){this.viewport.fixed=[this.frames[0].time,Math.max(this.frames[0].time+.1,this.frames.at(-1).time)];this.viewport.follow=false;this.draw();}};
  plus.onclick=()=>{this.viewport.zoom(this.frames,.8);this.draw();};minus.onclick=()=>{this.viewport.zoom(this.frames,1.25);this.draw();};
  toolbar.append(this.follow,all,minus,plus,el('small','','滚轮：缩放时间 · 拖动：平移 · Shift：纵轴 · 双击：复位 · 右下角拉高'));
  this.grid=el('div','motor-plots');root.append(toolbar,this.grid);
 }
 update(key,frames,definitions){
  if(this.key!==key){this.destroy();this.key=key;this.viewport.reset();this.cursor=null;this.grid.replaceChildren();this.charts=definitions.map(d=>new MotorChart(this,d));this.grid.append(...this.charts.map(c=>c.root));}
  this.frames=frames;this.draw();
 }
 draw(){for(const chart of this.charts)chart.draw();this.follow.textContent=this.viewport.follow?'● 跟随最新 · 30s':'恢复跟随';this.follow.setAttribute('aria-pressed',String(this.viewport.follow));}
 destroy(){for(const chart of this.charts)chart.destroy();this.charts=[];}
 reset(){this.destroy();this.key=null;this.frames=[];this.viewport.reset();this.cursor=null;this.grid.replaceChildren();}
}
