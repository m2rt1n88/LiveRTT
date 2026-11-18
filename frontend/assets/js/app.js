import {createApi, download, element as el, number, palette} from './api.js';
import {VariableChart, buildCsv} from './charts.js';
import {ProfilePersistence, emptyModules, normalizeModules, moduleDefinitions, normalizePath, snapshotProfile} from './profiles.js';
import {MotorDashboard} from './motors.js';
import {MotionDashboard} from './motion.js';
import {bindingFields} from './mechanisms.js';
import {CommunicationDashboard} from './communications.js';

const $ = id => document.getElementById(id);
const api = createApi();
const state = {ready:false, busy:false, sha:'', elfPath:'', profileId:'', profileName:'', profiles:[], defaults:{},
  page:'workspace', connected:false, rttConnected:false, running:false, watches:[], rows:[], modules:emptyModules(), rate:10, window:'30',
  run:0, generation:0, timer:0, inFlight:false, searchId:0, offset:0, rttBusy:false, rttCursor:0, rttLines:[], rttFollow:true};
const histories = new Map();
const chart = new VariableChart($('variable-chart'), $('chart-empty'), $('chart-legend'), $('chart-tooltip'));
const notify = (text, error=false) => { $('notice').textContent=text; $('notice').hidden=!text; $('notice').classList.toggle('error', error); };
const saveError = error => { $('save-status').textContent='保存失败 · 请重试'; $('save-status').className='error'; notify(error.message,true); };
const motors = new MotorDashboard($('motor-dashboard'),state,{scan:()=>action(scanMotors),write:body=>api.request('motors/write',body),enable:body=>api.request('motors/enable',body),changed,controls,error:message=>notify(message,true)});
const motion = new MotionDashboard($('motion-dashboard'),state,motors,{scan:()=>action(scanMotors),changed,controls,reconfigure:()=>renderModules(),error:message=>notify(message,true)});
const communications = new CommunicationDashboard($('communication-dashboard'),state,{scan:()=>action(scanCommunications),changed,controls});
async function scanCommunications(){if(!state.sha)throw Error('请先加载 ELF。');communications.setCatalog(await api.request('communications/scan',{sha:state.sha}));}
const motorPaths=()=>[...new Set([...motors.paths(),...motion.paths()])];
const monitorActive=()=>['motors','gimbal','chassis','vehicle'].some(key=>state.modules[key].enabled);
async function scanMotors(){if(!state.sha)throw Error('请先加载 ELF。');motors.setCatalog(await api.request('motors/scan',{sha:state.sha}));if(['gimbal','chassis','vehicle'].includes(state.page)&&state.modules[state.page].enabled)motion.configure(state.page);}
const persistence = new ProfilePersistence(api, () => state.sha ? snapshotProfile(state, connection()) : null, (profile, latest) => {
  if (normalizePath(profile.elfPath) !== normalizePath(state.elfPath)) return;
  state.profileId=profile.id;
  state.profiles=[profile,...state.profiles.filter(p=>p.id!==profile.id)]; renderProfiles();
  $('save-status').textContent=latest?'已自动保存':'有未保存更改'; $('save-status').className=latest?'':'dirty';
}, saveError);

function changed() {
  if (!state.sha) return;
  $('save-status').textContent='正在保存…'; $('save-status').className='dirty'; persistence.changed();
}
function connection() {
  return {autoStart:$('auto-start').checked, executable:$('openocd-executable').value.trim(), config:$('openocd-config').value.trim(),
    port:Number($('tcl-port').value), rttPort:Number($('rtt-port').value)};
}
function applyConnection(value={}) {
  $('auto-start').checked=value.autoStart!==false;
  $('openocd-executable').value=value.executable??state.defaults.executable??'';
  $('openocd-config').value=value.config??state.defaults.config??'';
  $('tcl-port').value=value.port??6666; $('rtt-port').value=value.rttPort??8888;
}
function controls() {
  const usable=state.watches.some(w=>w.valid)||motorPaths().length>0||Boolean(communications.request());
  $('load-elf').disabled=!state.ready||state.busy;
  $('profile-select').disabled=!state.ready||state.busy;
  $('connect').disabled=!state.sha||!$('firmware-confirm').checked||state.busy;
  $('disconnect').disabled=!state.connected||state.busy;
  $('sample-toggle').disabled=!state.connected||!usable||state.busy;
  $('sample-toggle').textContent=state.running?'暂停采集':'开始采集';
  for (const id of ['save-profile','export-profile','profile-name','variable-search','add-variable']) $(id).disabled=!state.sha||state.busy;
  $('import-profile').disabled=state.busy||!state.ready;
  $('connection-status').textContent=state.running?'正在采集':state.connected?(state.rttConnected?'SWD + RTT 已连接':'SWD 已连接'):'硬件未连接';
  $('connection-status').classList.toggle('on',state.connected);
  $('session-status').textContent=state.running?'SWD 正在采集':state.connected?'硬件已连接 · 采集暂停':state.sha?'ELF 已加载 · 硬件未连接':'等待加载 ELF';
  $('stream-light').className='connection-light'+(state.running?' running':state.connected?' on':'');
  $('sidebar-light').className='connection-light'+(state.ready?' on':'');
  $('sidebar-state').textContent=state.ready?'本地服务已就绪':'本地服务未连接';
  $('active-profile').textContent=state.profileName||'本地工作空间';
  $('active-elf').textContent=state.elfPath?state.elfPath.split(/[\\/]/).pop():'选择 ELF 开始调试';
  $('active-elf').title=state.elfPath;
  for (const input of document.querySelectorAll('#watch-table input, #curve-channels input, #monitor-settings input, #monitor-settings select, #monitor-settings button, #monitor-enabled')) input.disabled=state.busy||!state.sha;
  for (const input of document.querySelectorAll('#motor-dashboard input, #motor-dashboard select, #motor-dashboard button')) input.disabled=state.busy||!state.sha;
  motors.refreshControls();
  for (const input of document.querySelectorAll('#communication-dashboard input, #communication-dashboard select, #communication-dashboard button')) input.disabled=state.busy||!state.sha;
  for (const input of document.querySelectorAll('#motion-dashboard input, #motion-dashboard select, #motion-dashboard button, #motion-dashboard textarea')) input.disabled=state.busy||!state.sha;
  for (const id of ['openocd-executable','openocd-config','tcl-port','rtt-port','auto-start','elf-path','firmware-confirm','sample-rate','chart-window','plot-all']) $(id).disabled=state.busy;
}
async function action(fn) {
  if(state.busy)return;
  state.busy=true; controls();
  try { await fn(); } catch(error) { notify(error.message,true); }
  finally { state.busy=false; controls(); }
}
function stop() {
  if(state.running)motion.pause();
  state.running=false; state.run++; clearTimeout(state.timer); controls(); updateValues();
}
function rememberHistory() {
  if(state.elfPath)histories.set(normalizePath(state.elfPath),{sha:state.sha,rows:state.rows,rttLines:state.rttLines});
}
function renderProfiles() {
  const select=$('profile-select'); select.replaceChildren(el('option','','选择 ELF 的上次配置')); select.options[0].value='';
  for(const profile of state.profiles) {
    const option=el('option','',profile.name+' · '+profile.elfPath); option.value=profile.id; select.append(option);
  }
  select.value=state.profileId;
}
async function loadElf(path, requestedProfile=null, imported=false) {
  if(!path.trim())throw Error('请填写 ELF 文件路径。');
  await persistence.flush(); rememberHistory(); stop(); state.generation++; state.searchId++;
  const wasConnected=state.connected;
  state.connected=false; $('firmware-confirm').checked=false; controls(); notify('正在加载 ELF 并恢复调试配置…');
  let info;
  try { info=await api.request('elf',{path:path.trim()}); }
  catch(error) { state.connected=wasConnected; throw error; }
  let profile=requestedProfile;
  if(!profile) {
    const existing=state.profiles.find(p=>normalizePath(p.elfPath)===normalizePath(info.path));
    if(existing)profile=await api.request('profile?'+new URLSearchParams({id:existing.id}));
  }
  const previous=histories.get(normalizePath(info.path));
  motors.reset();motion.reset();communications.reset();
  Object.assign(state,{sha:info.sha,elfPath:info.path,profileId:imported?'':profile?.id||'',profileName:profile?.name||info.path.split(/[\\/]/).pop().replace(/\.elf$/i,''),
    watches:[],rows:previous?.sha===info.sha?previous.rows:[],rttLines:previous?.sha===info.sha?previous.rttLines:[],rttCursor:0,
    rate:profile?.rate||10,window:profile?.window||'30',modules:normalizeModules(profile?.modules)});
  $('elf-path').value=info.path; $('profile-name').value=state.profileName;
  $('sample-rate').value=state.rate; $('chart-window').value=state.window; $('variable-search').value='';
  applyConnection(profile?.connection);
  $('elf-meta').textContent=info.variables+' 个固定地址变量 · SHA-256 '+info.sha.slice(0,12)+'… · '+info.path;
  $('rtt-log').textContent=state.rttLines.join('\n')||'等待 RTT 连接。'; $('rtt-status').textContent='等待连接';
  let missing=0;
  for(const saved of profile?.watches||[]) {
    const watch=makeWatch(saved); state.watches.push(watch);
    try { const item=await api.request('inspect',{path:watch.path,sha:state.sha}); if(!item.scalar)throw Error('不是数值字段'); watch.type=item.type; watch.valid=true; }
    catch(error) { watch.error='当前 ELF 无法解析：'+error.message; missing++; }
  }
  renderAll(); await searchVariables();
  if(monitorActive())await scanMotors();
  if(state.modules.communications.enabled)await scanCommunications();
  changed(); await persistence.flush();
  notify('已加载 '+state.profileName+'。'+(profile?'已恢复 '+state.watches.length+' 个变量及对应曲线 / 模块配置。':'从变量浏览器添加需要观察的字段即可开始。')+(missing?' '+missing+' 个变量已失效，配置仍保留，请修改或移除。':''),missing>0);
}
function makeWatch(options) {
  return {path:options.path,label:options.label||options.path.split(/->|\./).pop(),unit:options.unit||'',scale:Number.isFinite(options.scale)?options.scale:1,
    plot:options.plot!==false,color:palette[state.watches.length%palette.length],type:'',valid:false,value:null,lastTime:0,error:'',address:''};
}
async function addVariable(path, options={}) {
  path=path.trim(); if(!path)throw Error('请输入变量路径。');
  if(state.watches.some(w=>w.path===path))throw Error('这个变量已经在观察列表中。');
  if(state.watches.length>=16)throw Error('每个 ELF 最多观察 16 个变量。');
  const item=await api.request('inspect',{path,sha:state.sha});
  if(!item.scalar)throw Error('请继续展开对象，选择具体数值字段。');
  state.watches.push({...makeWatch({path,plot:options.plot}),type:item.type,valid:true});
  renderAll(); changed(); notify('已添加 '+path+'。可用于变量读数、数据曲线或监视指标绑定。');
}
function treeItem(item) {
  const wrapper=el('div'); const row=el('div','variable-row'); const toggle=el('button','variable-toggle',item.expandable?'▸':'·');
  toggle.disabled=!item.expandable; toggle.setAttribute('aria-label','展开 '+item.path); toggle.setAttribute('aria-expanded','false');
  const label=el('div','variable-label'); label.append(el('strong','',item.name),el('small','',item.type+(item.address?' · '+item.address:''))); row.append(toggle,label);
  if(item.scalar) { const add=el('button','variable-add','＋ 添加'); add.setAttribute('aria-label','添加变量 '+item.path); add.addEventListener('click',()=>action(()=>addVariable(item.path))); row.append(add); }
  wrapper.append(row);
  toggle.addEventListener('click',async()=>{
    if(state.busy)return; toggle.disabled=true;
    const generation=state.generation;
    try {
      let children=wrapper.querySelector(':scope > .variable-children');
      if(children) { children.hidden=!children.hidden; toggle.textContent=children.hidden?'▸':'▾'; toggle.setAttribute('aria-expanded',String(!children.hidden)); return; }
      const data=await api.request('children?'+new URLSearchParams({path:item.path,sha:state.sha}));
      if(generation!==state.generation)return;
      children=el('div','variable-children');
      if(!data.items.length)children.append(el('div','empty','没有可展开的成员。'));
      data.items.forEach(child=>children.append(treeItem(child))); wrapper.append(children); toggle.textContent='▾'; toggle.setAttribute('aria-expanded','true');
    } catch(error) { notify(error.message,true); } finally { toggle.disabled=false; }
  });
  return wrapper;
}
async function searchVariables(more=false) {
  if(!state.sha)return;
  const searchId=++state.searchId,generation=state.generation,offset=more?state.offset:0;
  const data=await api.request('variables?'+new URLSearchParams({q:$('variable-search').value,offset,sha:state.sha}));
  if(searchId!==state.searchId||generation!==state.generation)return;
  if(!more)$('variable-tree').replaceChildren();
  if(!more&&!data.items.length)$('variable-tree').append(el('div','empty','没有匹配的变量。试试更短的名称。'));
  data.items.forEach(item=>$('variable-tree').append(treeItem(item))); state.offset=offset+data.items.length;
  $('variable-count').textContent=data.total+' 个匹配 · 已显示 '+state.offset; $('more-variables').hidden=state.offset>=data.total;
}
function renderWatches() {
  $('watch-count').textContent=state.watches.length+' / 16'; const body=$('watch-table'); body.replaceChildren();
  if(!state.watches.length) { const row=el('tr'),cell=el('td','empty','还没有已选变量。在左侧展开对象，添加要观察的数值。'); cell.colSpan=8; row.append(cell); body.append(row); }
  for(const watch of state.watches) {
    const row=el('tr'),path=el('td'); path.append(el('code','',watch.path),el('small','',watch.type||'路径待修正')); row.append(path);
    watch.valueNode=el('td','watch-value','—');row.append(watch.valueNode);
    for(const key of ['label','unit','scale']) {
      const cell=el('td'),input=el('input',key); input.type=key==='scale'?'number':'text'; input.value=watch[key];
      if(key==='scale')input.step='any'; else input.maxLength=100;
      input.setAttribute('aria-label',watch.path+' '+{label:'显示名称',unit:'显示单位',scale:'显示倍率'}[key]);
      input.addEventListener('input',()=>{
        if(key==='scale'&&(!input.value.trim()||!Number.isFinite(Number(input.value))))return;
        watch[key]=key==='scale'?Number(input.value):input.value;if(key==='scale'||key==='unit')motion.reset(); updateValues(); renderCurves(); changed();
      });
      input.addEventListener('change',()=>{if(key==='scale'&&(!input.value.trim()||!Number.isFinite(Number(input.value)))){input.value=watch.scale;notify('倍率必须是有限数值。',true);}if(key==='label')renderModules();});
      cell.append(input);row.append(cell);
    }
    watch.statusNode=el('td','watch-state','等待采集');
    const plotCell=el('td'),plot=el('input');plot.type='checkbox';plot.checked=watch.plot;plot.setAttribute('aria-label','绘制 '+watch.path);
    plot.addEventListener('change',()=>{watch.plot=plot.checked;renderCurves();changed();});watch.plotNode=plot;plotCell.append(plot);
    const actions=el('td'),remove=el('button','text-button','移除'); remove.setAttribute('aria-label','移除 '+watch.path);
    remove.addEventListener('click',()=>{if(state.busy)return;state.watches=state.watches.filter(w=>w!==watch);for(const config of Object.values(state.modules))for(const field of Object.keys(config.bindings))if(config.bindings[field]===watch.path)config.bindings[field]='';motion.reset();if(!state.watches.some(w=>w.valid)&&!motorPaths().length&&!communications.request())stop();renderAll();changed();});
    actions.append(remove);row.append(watch.statusNode,plotCell,actions);body.append(row);
  }
}
function valueText(watch) { return watch.value===null?'—':watch.exact&&watch.scale===1?watch.exact:number(Number(watch.value)*watch.scale); }
function isStale(watch) { return !state.running||Date.now()/1000-watch.lastTime>2; }
function updateValues() {
  for(const watch of state.watches) {
    if(!watch.valueNode)continue;
    watch.valueNode.textContent=valueText(watch);watch.valueNode.classList.toggle('stale',isStale(watch));
    watch.statusNode.textContent=watch.error||(watch.lastTime?(isStale(watch)?'历史值 · ':'已更新 · ')+watch.address:'等待采集');
    watch.statusNode.classList.toggle('error',Boolean(watch.error));
  }
  renderReadings(); if(moduleDefinitions[state.page])renderMonitor();
}
function renderCurves() {
  const wrap=$('curve-channels');wrap.replaceChildren();
  if(!state.watches.length)wrap.append(el('div','empty','先在工作空间添加变量。'));
  for(const watch of state.watches) {
    const row=el('div','curve-channel'),label=el('label'),check=el('input'),dot=el('i','series-dot'),copy=el('span');
    check.type='checkbox';check.checked=watch.plot;check.setAttribute('aria-label','曲线通道 '+watch.path);dot.style.setProperty('--series',watch.color);
    copy.append(el('strong','',watch.label),el('small','',watch.path+(watch.unit?' · '+watch.unit:'')));label.append(check,copy);row.append(dot,label);
    check.addEventListener('change',()=>{watch.plot=check.checked;watch.plotNode.checked=watch.plot;renderCurves();changed();});wrap.append(row);
  }
  $('plotted-count').textContent=state.watches.filter(w=>w.plot).length+' / '+state.watches.length;
  $('plot-all').textContent=state.watches.length&&state.watches.every(w=>w.plot)?'取消全选':'全选';
  chart.draw(state.watches,state.rows,state.window); renderReadings();
}
function renderReadings() {
  const wrap=$('curve-readings');wrap.replaceChildren();
  for(const watch of state.watches.filter(w=>w.plot)) {
    const card=el('div','reading-card'+(isStale(watch)?' stale':''));card.style.setProperty('--series',watch.color);
    card.append(el('small','',watch.label),el('strong','',valueText(watch)),el('span','unit',watch.unit));
    if(watch.error)card.append(el('small','',watch.error));wrap.append(card);
  }
  if(!wrap.children.length)wrap.append(el('div','empty','选择曲线变量后在这里查看读数。'));
}
function renderModules() {
  const definition=moduleDefinitions[state.page];if(!definition)return;
  const config=state.modules[state.page],enabled=Boolean(state.sha&&config.enabled);
  $('monitor-enabled').checked=config.enabled;
  $('monitor-enabled').setAttribute('aria-label','启用'+definition.name);
  $('monitor-enable-label').textContent='启用'+definition.name;
  $('monitor-state').textContent=config.enabled?'已启用':'未启用';
  $('monitor-hint').textContent=!state.sha?'先在工作空间加载 ELF，再启用本模块并配置变量绑定。':config.enabled?'为当前模块绑定电机或其他数值字段。监视开关独立控制，不影响工作空间读数与曲线采集。':'本模块当前关闭。打开开关后配置绑定，关闭时保留已有设置。';
  $('communication-dashboard').hidden=!enabled||state.page!=='communications';
  if(state.page==='communications'){
    $('monitor-settings').hidden=true;$('motor-dashboard').hidden=true;$('motion-dashboard').hidden=true;
    $('monitor-disabled').hidden=enabled;
    $('monitor-hint').textContent='选择一路通信，实时查看收发帧与解析字段。字段快照兼容未加记录的旧固件；逐帧记录需重新构建固件。';
    $('monitor-disabled').querySelector('p').textContent='打开开关后扫描通信链路。';
    if(enabled)communications.configure();controls();return;
  }
  $('monitor-settings').hidden=!enabled||state.page==='motors';
  $('motor-dashboard').hidden=!enabled||state.page!=='motors';
  if(state.page==='motors')$('monitor-hint').textContent='扫描固件注册的 CAN 电机，选择后统一采集反馈、目标与输出。无需逐字段绑定；选择、重点电机与总线筛选随 ELF 保存。';
  $('monitor-disabled').hidden=enabled;
  $('monitor-disabled').querySelector('p').textContent=state.page==='motors'?'打开上方开关后，扫描并选择当前 CAN 电机。':'打开上方开关后，再配置变量绑定并查看监视数据。';
  $('motion-dashboard').hidden=!enabled||state.page==='motors';
  if(enabled&&state.page!=='motors')motion.configure(state.page);
  if(state.page!=='motors')$('monitor-hint').textContent='选择电机即可读取姿态 / 轮速、在线、模式和输出。下方可选变量覆盖反馈与目标；电机绑定和采集独立于电机监视开关，所有设置随 ELF 保存。';
  if(state.page==='vehicle')$('monitor-hint').textContent='复用云台与底盘的绑定和标定，可在下方直接配置。独立启用即可采集当前构型的电机；绿色反馈、橙色目标，对照底盘旋转与云台补偿后的瞄向。';
  const fields=$('monitor-bindings');fields.replaceChildren();
  $('monitor-variable').value='';
  if(enabled)for(const [field,title] of Object.entries(bindingFields(config,state.page,definition.fields))) {
    const fieldLabel=el('label','',title),select=el('select');select.setAttribute('aria-label',definition.name+' '+title+'绑定');
    const empty=el('option','','自动使用绑定电机 / 未绑定');empty.value='';select.append(empty);
    for(const watch of state.watches) {const option=el('option','',watch.label+' · '+watch.path);option.value=watch.path;select.append(option);}
    select.value=config.bindings[field]||'';
    select.addEventListener('change',()=>{config.bindings[field]=select.value;motion.reset(state.page);renderMonitor();changed();});
    fieldLabel.append(select);fields.append(fieldLabel);
  }
  controls();
}
function renderNavigation() {
  const nav=$('module-nav');nav.replaceChildren();
  for(const [key,definition] of Object.entries(moduleDefinitions)) {
    const button=el('button','nav-item'),indicator=el('span','module-indicator'+(state.modules[key].enabled?' enabled':''));
    indicator.setAttribute('aria-hidden','true');button.dataset.page=key;button.title=definition.name+' · '+(state.modules[key].enabled?'已启用':'未启用');
    button.append(el('span','nav-icon',definition.icon),document.createTextNode(definition.name),indicator);
    button.addEventListener('click',()=>navigate(key));nav.append(button);
  }
  navigate(state.page,false);
}
function renderMonitor() {
  const definition=moduleDefinitions[state.page];if(!definition)return;
  if(state.page==='motors'){motors.render();return;}
  if(state.page==='communications'){communications.render();return;}
  motion.render();
}
function navigate(page,updateHash=true) {
  if(!['workspace','curves'].includes(page)&&!moduleDefinitions[page])page='workspace';state.page=page;
  $('workspace-page').hidden=page!=='workspace';$('curves-page').hidden=page!=='curves';$('monitor-page').hidden=!moduleDefinitions[page];
  document.querySelectorAll('[data-page]').forEach(button=>{const active=button.dataset.page===page;button.classList.toggle('active',active);button.setAttribute('aria-current',active?'page':'false');});
  const title=page==='workspace'?'从变量开始，理解你的程序。':page==='curves'?'让每一条曲线，都有来处。':moduleDefinitions[page].name;
  $('page-title').textContent=title;$('breadcrumb').textContent=page==='workspace'?'ELF 与变量':page==='curves'?'数据曲线':title;
  $('page-description').textContent=page==='workspace'?'选择 ELF，观察真实变量。每个程序都有自己的调试配置。':page==='curves'?'同一个采集会话，自由选择变量、倍率与单位。':page==='motors'?'从 CAN 反馈到控制输出，观察电机正在经历什么。':page==='gimbal'?'按所选构型联动查看各关节，悬停电机查看反馈、目标与输出。':page==='vehicle'?'把底盘与云台放在一起，对照整车姿态、目标瞄向与旋转补偿。':'按实际构型观察平移、转动与轮组响应，可编辑模板拓展。';
  if(page==='communications')$('page-description').textContent='选择任意一路通信，对照收发帧、原始字节与当前解析字段。';
  if(updateHash&&location.hash!=='#'+page)history.replaceState(null,'','#'+page);
  if(updateHash)window.scrollTo({top:0});
  if(page==='curves')requestAnimationFrame(()=>chart.draw(state.watches,state.rows,state.window));
  if(moduleDefinitions[page]){renderModules();renderMonitor();}
}
function renderAll(){renderWatches();renderCurves();renderModules();renderNavigation();updateValues();controls();$('chart-meta').textContent=state.rows.length?state.rows.length+' 帧 · 当前 ELF 历史':'保留最近 10 分钟，最多 12,000 帧';}

async function connect() {
  await persistence.flush();stop();state.connected=false;state.generation++;controls();notify('正在启动 / 复用 OpenOCD，核对 ELF 并连接 RTT…');
  const data=await api.request('connect',{sha:state.sha,...connection(),confirmed:$('firmware-confirm').checked});
  state.connected=true;state.rttConnected=!data.rttError;state.rttCursor=0;
  motors.reset();motion.reset();communications.reset();if(monitorActive())await scanMotors();
  if(state.modules.communications.enabled)await scanCommunications();
  if(state.rttLines.length)state.rttLines.push('── '+new Date().toLocaleTimeString()+' · 重新连接 ──');
  $('rtt-status').textContent=data.rttError||'RTT 已连接 · 上行通道 0';
  if(!state.rttLines.length)$('rtt-log').textContent=data.rttError||'RTT 已连接，等待固件输出日志。';
  notify(data.service+' · '+data.target+'（'+data.state+'）· '+data.note+(data.state!=='running'?' 目标未运行，请在原调试环境处理。':''));controls();
}
async function disconnect(){stop();state.generation++;await api.request('disconnect',{});state.connected=false;$('rtt-status').textContent='已断开';controls();notify('已断开。网页启动的 OpenOCD 已关闭，外部服务继续运行。');}
async function poll(run) {
  if(!state.running||run!==state.run||state.inFlight)return;
  const paths=state.watches.filter(w=>w.valid).map(w=>w.path);
  const selectedMotors=motorPaths();
  if(selectedMotors.length>64){stop();notify('所有监视模块合计最多采集 64 个不同电机，请减少选择。',true);return;}
  const selectedCommunication=communications.request();
  if(!paths.length&&!selectedMotors.length&&!selectedCommunication){stop();return;}
  const started=performance.now();state.inFlight=true;
  try {
    const data=await api.request('sample',{paths,motorPaths:selectedMotors,communication:selectedCommunication,sha:state.sha});
    if(run!==state.run||!state.running)return;
    if(data.motors?.length)motors.ingest(data.motors,data.time);
    communications.ingest(data.communication,data.time);
    const row={time:data.time,values:Object.create(null),raw:Object.create(null)};let valid=0;
    for(const result of data.values){const watch=state.watches.find(w=>w.path===result.path);if(!watch)continue;row.values[result.path]=result.value;row.raw[result.path]=result.exact??result.value;watch.value=result.value;watch.exact=result.exact;watch.error=result.error||'';if(result.value!==null){watch.lastTime=data.time;watch.address=result.address;valid++;}}
    motion.ingest(data.time);
    state.rows.push(row);while(state.rows.length&&(state.rows.length>12000||row.time-state.rows[0].time>600))state.rows.shift();
    $('sample-meta').textContent=data.durationMs+' ms · '+valid+'/'+paths.length+' 变量 · '+(data.motors?.length||0)+' 电机';$('chart-meta').textContent=state.rows.length+' 帧 · 最近读取 '+data.durationMs+' ms · '+valid+'/'+paths.length+' 通道有效';
    $('chart-caption').textContent='SWD 真实采样 · '+new Date(data.time*1000).toLocaleTimeString('zh-CN',{hour12:false});
    updateValues();if(state.page==='curves')chart.draw(state.watches,state.rows,state.window);
    if(!data.connected){state.connected=false;stop();notify('OpenOCD 已断开，请检查接线后重新连接。',true);}
  }catch(error){if(run!==state.run)return;state.connected=false;stop();notify(error.message,true);}
  finally{state.inFlight=false;if(state.running&&run===state.run)state.timer=setTimeout(()=>poll(run),Math.max(0,1000/state.rate-(performance.now()-started)));}
}
async function pollRtt() {
  if(!state.connected||state.rttBusy||document.hidden)return;
  const generation=state.generation;state.rttBusy=true;
  try {
    const data=await api.request('rtt?'+new URLSearchParams({after:state.rttCursor}));
    if(generation!==state.generation)return;
    state.rttCursor=data.cursor;
    if(data.lines.length) {
      state.rttLines.push(...data.lines.map(line=>line.text));state.rttLines=state.rttLines.slice(-1500);
      $('rtt-log').textContent=state.rttLines.join('\n');
      if(state.rttFollow)$('rtt-log').scrollTop=$('rtt-log').scrollHeight;
    }
    state.rttConnected=!data.error;
    $('rtt-status').textContent=data.error||'RTT 已连接 · 上行通道 0';
    controls();
  } catch(error) {
    if(generation===state.generation){state.rttConnected=false;$('rtt-status').textContent=error.message;controls();}
  } finally {state.rttBusy=false;}
}

$('load-elf').addEventListener('click',()=>action(()=>loadElf($('elf-path').value)));
$('elf-path').addEventListener('keydown',event=>{if(event.key==='Enter')$('load-elf').click();});
$('profile-select').addEventListener('change',()=>{const id=$('profile-select').value;if(!id)return;action(async()=>{await persistence.flush();const profile=await api.request('profile?'+new URLSearchParams({id}));await loadElf(profile.elfPath,profile);}).then(renderProfiles);});
$('profile-name').addEventListener('input',()=>{state.profileName=$('profile-name').value;controls();changed();});
$('save-profile').addEventListener('click',()=>action(async()=>{await persistence.flush(true);notify('已保存当前 ELF 的调试配置。');}));
$('export-profile').addEventListener('click',()=>action(async()=>{await persistence.flush();const profile=snapshotProfile(state,connection());delete profile.id;download(JSON.stringify(profile,null,2),'livertt-profile-'+Date.now()+'.json','application/json');}));
$('import-profile').addEventListener('change',event=>{const file=event.target.files[0];if(!file)return;action(async()=>{if(file.size>64000)throw Error('配置文件超过 64 KB。');let body=JSON.parse(await file.text());if(body.version===1)body={version:2,elfPath:body.elfHint,name:body.elfHint?.split(/[\\/]/).pop(),watches:body.watches,connection:connection(),modules:emptyModules()};delete body.id;const validated=await api.request('profile/validate',body);await loadElf(validated.elfPath,validated,true);}).finally(()=>{event.target.value='';});});
for(const id of ['openocd-executable','openocd-config','tcl-port','rtt-port','auto-start'])$(id).addEventListener('input',changed);
$('firmware-confirm').addEventListener('change',controls);
$('connect').addEventListener('click',()=>action(connect));$('disconnect').addEventListener('click',()=>action(disconnect));
$('sample-toggle').addEventListener('click',()=>{if(state.running){stop();return;}if(state.inFlight){notify('上一轮读取正在结束，请稍后开始。');return;}state.running=true;state.run++;controls();poll(state.run);});
$('sample-rate').addEventListener('change',()=>{state.rate=Number($('sample-rate').value);changed();});
$('chart-window').addEventListener('change',()=>{state.window=$('chart-window').value;chart.draw(state.watches,state.rows,state.window);changed();});
$('add-variable').addEventListener('click',()=>action(()=>addVariable($('variable-expression').value)));
$('variable-expression').addEventListener('keydown',event=>{if(event.key==='Enter')$('add-variable').click();});
$('monitor-enabled').addEventListener('change',()=>{
  if(state.busy||!state.sha||!moduleDefinitions[state.page])return;
  state.modules[state.page].enabled=$('monitor-enabled').checked;
  if(!['motors','communications'].includes(state.page))motion.reset(state.page,false);
  renderNavigation();changed();
  if(state.modules[state.page].enabled)action(state.page==='communications'?scanCommunications:scanMotors);
});
$('monitor-add-variable').addEventListener('click',()=>action(async()=>{
  if(!state.modules[state.page]?.enabled) return;
  await addVariable($('monitor-variable').value,{plot:false});
}));
$('monitor-variable').addEventListener('keydown',event=>{if(event.key==='Enter')$('monitor-add-variable').click();});
let searchTimer=0;$('variable-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>searchVariables().catch(error=>notify(error.message,true)),250);});
$('more-variables').addEventListener('click',()=>action(()=>searchVariables(true)));
document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.page)));
document.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.go)));
$('plot-all').addEventListener('click',()=>{if(state.busy)return;const value=!state.watches.every(w=>w.plot);state.watches.forEach(w=>{w.plot=value;w.plotNode.checked=value;});renderCurves();changed();});
$('export-csv').addEventListener('click',()=>{const watches=state.watches.filter(w=>w.plot);if(!state.rows.length||!watches.length){notify('请先采集数据并选择曲线通道。',true);return;}download(buildCsv(watches,state.rows),'livertt-variables-'+Date.now()+'.csv','text/csv;charset=utf-8');});
$('clear-samples').addEventListener('click',()=>{state.rows=[];state.watches.forEach(w=>{w.value=null;w.lastTime=0;w.exact=undefined;});updateValues();chart.draw(state.watches,state.rows,state.window);$('chart-meta').textContent='采样历史已清空';});
$('rtt-follow').addEventListener('click',()=>{state.rttFollow=!state.rttFollow;$('rtt-follow').textContent='自动滚动：'+(state.rttFollow?'开':'关');$('rtt-follow').setAttribute('aria-pressed',String(state.rttFollow));});
$('clear-rtt').addEventListener('click',()=>{state.rttLines=[];$('rtt-log').textContent='';});$('export-rtt').addEventListener('click',()=>download(state.rttLines.join('\n'),'rtt-log-'+Date.now()+'.txt','text/plain;charset=utf-8'));
$('help').addEventListener('click',()=>$('help-dialog').showModal());
window.addEventListener('resize',()=>chart.draw(state.watches,state.rows,state.window));window.addEventListener('hashchange',()=>navigate(location.hash.slice(1),false));
document.addEventListener('keydown',event=>{if(event.ctrlKey||event.metaKey||event.altKey||/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)||$('help-dialog').open)return;if(event.key==='1')navigate('workspace');if(event.key==='2')navigate('curves');});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.running){stop();notify('页面进入后台，已暂停内存采集。返回后可手动继续。');}});
window.addEventListener('beforeunload',event=>{if(persistence.dirty||state.rows.length){event.preventDefault();event.returnValue='';}});
setInterval(()=>{updateValues();pollRtt();},500);

async function init(){renderAll();navigate(location.hash.slice(1)||'workspace');try{const status=await api.request('status');state.ready=true;state.defaults=status.openocd;state.profiles=status.profiles;renderProfiles();applyConnection();const candidates=$('elf-candidates');for(const preset of status.presets){const option=el('option');option.value=preset.path;option.label=preset.name;candidates.append(option);}if(status.presets.length)$('elf-path').value=status.presets[0].path;notify('选择已保存配置，或加载任意例程的 ELF。配置会按 ELF 独立保存。');controls();}catch(error){notify(error.message,true);controls();}}
init();
