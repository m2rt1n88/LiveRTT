import {element as el, download} from './api.js';

export const linkNames={can_bridge:'CAN Bridge',chassis_bridge:'底盘 CAN Bridge',referee_legacy:'裁判系统 · 旧版',referee_new:'裁判系统 · 赛季版'};
export const frameId=id=>'0x'+Number(id).toString(16).toUpperCase().padStart(4,'0');
export function filterFrames(frames, config){
 const q=(config.filter||'').trim().toLowerCase();
 return frames.filter(f=>(config.direction==='all'||f.direction===config.direction)&&(!q||[frameId(f.id),f.command,f.hex,JSON.stringify(f.decoded)].join(' ').toLowerCase().includes(q)));
}

export class CommunicationDashboard {
 constructor(root,state,callbacks){
  this.root=root;this.state=state;this.callbacks=callbacks;this.catalog=[];this.streams=new Map();this.build();
 }
 get config(){return this.state.modules.communications;}
 stream(path=this.config.selected){if(!this.streams.has(path))this.streams.set(path,{frames:[],cursor:0,dropped:0,latest:null,time:0});return this.streams.get(path);}
 reset(){this.catalog=[];this.streams.clear();this.render();}
 request(){return this.config.enabled&&this.catalog.some(i=>i.path===this.config.selected)?{path:this.config.selected,after:this.stream().cursor}:null;}
 setCatalog(data){this.catalog=data.items;this.note.textContent=data.note;this.configure();}
 build(){
  const panel=el('article','panel'),heading=el('div','panel-heading'),title=el('div');title.append(el('h2','','通信链路'),el('span','caption','按当前 ELF 自动识别'));
  const scan=el('button','button','扫描链路');scan.onclick=()=>this.callbacks.scan();heading.append(title,scan);
  const body=el('div','panel-body'),row=el('div','communication-toolbar');
  const label=el('label','','查看链路');this.select=el('select');this.select.setAttribute('aria-label','查看通信链路');
  this.select.onchange=()=>{this.config.selected=this.select.value;this.callbacks.changed();this.render();this.callbacks.controls();};label.append(this.select);
  const direction=el('label','','收发方向');this.direction=el('select');this.direction.setAttribute('aria-label','通信收发方向');
  for(const [value,text] of [['all','全部方向'],['RX','RX 接收'],['TX','TX 发送']]){const o=el('option','',text);o.value=value;this.direction.append(o);}
  this.direction.onchange=()=>{this.config.direction=this.direction.value;this.callbacks.changed();this.render();};direction.append(this.direction);
  const filter=el('label','','筛选帧');this.filter=el('input');this.filter.type='search';this.filter.placeholder='ID / 命令 / 内容';this.filter.maxLength=100;this.filter.setAttribute('aria-label','筛选通信帧');
  this.filter.oninput=()=>{this.config.filter=this.filter.value;this.callbacks.changed();this.render();};filter.append(this.filter);
  row.append(label,direction,filter);this.note=el('p','hint','加载 ELF 后扫描链路，再选择任意一路开始采集。');this.status=el('p','communication-status');this.metadata=el('p','hint');
  body.append(row,this.note,this.status,this.metadata);panel.append(heading,body);
  const frames=el('article','panel'),fh=el('div','panel-heading'),actions=el('div','inline-actions');fh.append(el('h2','','收发帧记录'));
  const clear=el('button','text-button','清空记录'),exportButton=el('button','text-button','导出 JSON');
  clear.onclick=()=>{const s=this.stream();s.frames=[];s.dropped=0;this.render();};
  exportButton.onclick=()=>{const s=this.stream();download(JSON.stringify({elfPath:this.state.elfPath,sha:this.state.sha,path:this.config.selected,dropped:s.dropped,frames:s.frames,latest:s.latest},null,2),'communication-'+Date.now()+'.json','application/json');};
  actions.append(exportButton,clear);fh.append(actions);this.frameBody=el('tbody');const table=el('table'),thead=el('thead'),tr=el('tr');
  for(const text of ['序号 / 板端 ms','方向','ID / 命令','字节','解析内容'])tr.append(el('th','',text));thead.append(tr);table.append(thead,this.frameBody);
  const scroll=el('div','table-scroll communication-frames');scroll.append(table);frames.append(fh,scroll,el('div','panel-foot','保留最近 2,000 帧 · TX 表示驱动接受发送请求，不代表对端已收到 · 高速链路可能覆盖板端缓冲'));
  const fields=el('article','panel'),fieldHead=el('div','panel-heading');fieldHead.append(el('h2','','当前解析字段'),el('span','caption','SWD 内存快照 · 不代表每个字段刚刚收到'));
  this.fieldBody=el('div','communication-fields');fields.append(fieldHead,this.fieldBody);this.root.append(panel,frames,fields);
 }
 configure(){
  this.select.replaceChildren();const empty=el('option','','请选择通信链路');empty.value='';this.select.append(empty);
  for(const item of this.catalog){const option=el('option','',item.path+' · '+(linkNames[item.family]||item.family)+(item.capture?' · 帧记录':' · 字段快照'));option.value=item.path;this.select.append(option);}
  if(this.config.selected&&!this.catalog.some(i=>i.path===this.config.selected)){const missing=el('option','','已保存链路未找到 · '+this.config.selected);missing.value=this.config.selected;this.select.append(missing);}
  this.select.value=this.config.selected;this.direction.value=this.config.direction;this.filter.value=this.config.filter;this.render();
 }
 ingest(data,time){
  if(!data)return;const s=this.stream(data.path);if(data.reset){s.frames=[];s.dropped=0;}
  s.latest=data;s.time=time;s.cursor=data.cursor??s.cursor;s.dropped+=data.dropped||0;
  s.frames.push(...(data.frames||[]));s.frames=s.frames.slice(-2000);
 }
 render(){
  if(!this.status)return;
  const s=this.stream(),data=s.latest,item=this.catalog.find(i=>i.path===this.config.selected),historical=!this.state.running||!this.state.connected||Date.now()/1000-s.time>2;
  this.status.textContent=!item?'请选择链路；重新编译后可扫描更新列表。':data?.error?'本轮读取失败：'+data.error:!data?'等待开始采集':(historical?'历史快照 · ':'正在采集 · ')+(data.capture?'帧记录已接入':'仅字段快照 · 此固件未接入帧记录');
  this.status.classList.toggle('error',Boolean(data?.error));this.status.classList.toggle('stale',historical);
  this.metadata.textContent=item?item.type+' · '+(data?.address||item.address||'离线扫描')+' · 已保留 '+s.frames.length+' 帧 · 板端缓冲覆盖 '+s.dropped+' 帧':'';
  this.frameBody.replaceChildren();
  const frames=filterFrames(s.frames,this.config).slice(-200).reverse();
  if(!frames.length){const row=el('tr'),cell=el('td','empty',data?.capture?'尚无匹配的收发帧。':'接入固件帧记录后，此处显示收发方向、时间与原始数据。');cell.colSpan=5;row.append(cell);this.frameBody.append(row);}
  for(const f of frames){const row=el('tr'),bytes=el('td','communication-hex',f.hex),decoded=el('td');decoded.append(el('pre','communication-decoded',f.decodeError||JSON.stringify(f.decoded||{},null,2)));
   row.append(el('td','',f.sequence+' / '+f.timeMs),el('td',f.direction==='RX'?'communication-rx':'communication-tx',f.direction),el('td','',frameId(f.id)+(f.command?' · '+f.command:'')),bytes,decoded);this.frameBody.append(row);}
  this.fieldBody.replaceChildren();const entries=Object.entries(data?.fields||{});
  if(!entries.length)this.fieldBody.append(el('p','empty','尚无有效字段。'));
  for(const [key,value]of entries){const row=el('div','communication-field');row.append(el('code','',key),el('span','',value===null?'读取无效':String(value)));this.fieldBody.append(row);}
 }
}
