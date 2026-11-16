import {ensureSlots, validateMechanism, migrateMechanism} from './mechanisms.js';
export const moduleDefinitions = {
  motors: {name: '电机监视', icon: '◉', fields: {angle: '角度', speed: '速度', current: '电流', temperature: '温度'}},
  gimbal: {name: '云台监视', icon: '◎', fields: {yaw: 'Yaw 反馈角度', yawTarget: 'Yaw 目标角度', pitch: 'Pitch 反馈角度', pitchTarget: 'Pitch 目标角度', yawSpeed: 'Yaw 反馈角速度', pitchSpeed: 'Pitch 反馈角速度', enabled: '云台使能', mode: '控制模式（原始枚举）'}},
  chassis: {name: '底盘监视', icon: '▧', fields: {vx: '实测右向速度 vx', vy: '实测前向速度 vy', omega: '实测顺时针角速度 vt', heading: '实测航向角（逆时针为正）', vxTarget: '右向指令 vx', vyTarget: '前向指令 vy', omegaTarget: '顺时针指令 vt', enabled: '底盘使能'}},
  vehicle: {name: '整车状态', icon: '◇', fields: {headingTarget: '底盘目标航向（可选）'}}
};

export function emptyModules() {
  const modules=Object.fromEntries(Object.entries(moduleDefinitions).map(([key, definition]) => [key, {enabled: false, bindings: Object.fromEntries(Object.keys(definition.fields).map(field => [field, '']))}]));
  const axis=()=>({motor:'',sign:1,ratio:1,zero:0,min:-180,max:180});
  Object.assign(modules.gimbal,{angleUnit:'rad',yawWrap:true,tolerance:3,axes:{yaw:axis(),pitch:{...axis(),min:-30,max:30}}});
  Object.assign(modules.chassis,{angleUnit:'rad',layout:'mecanum',radius:.076,halfLength:.2,halfWidth:.2,vectorScale:2,offset:0,commandUnits:'si',wheels:Object.fromEntries(['fl','fr','bl','br'].map(key=>[key,{motor:'',sign:1,ratio:1}]))});
  Object.assign(modules.vehicle,{angleUnit:'rad',gimbalFrame:'body'});
  ensureSlots(modules.gimbal,'gimbal');
  return modules;
}

// Read only supported modules. Old target settings disappear without removing user watches.
export function normalizeModules(saved={}) {
  const modules=emptyModules();
  for(const [key,defaults] of Object.entries(modules)) {
    const item=saved?.[key]||{};
    for(const prop of [...Object.keys(defaults),'mechanism'])if(prop!=='bindings'&&prop!=='axes'&&prop!=='wheels'&&item[prop]!==undefined)defaults[prop]=structuredClone(item[prop]);
    if(['gimbal','chassis'].includes(key)){
      if(defaults.mechanism)defaults.mechanism=migrateMechanism(validateMechanism(defaults.mechanism,key),key);
      for(const [slot,cfg]of Object.entries(item[key==='gimbal'?'axes':'wheels']||{}))if(!['rl','rr'].includes(slot))defaults[key==='gimbal'?'axes':'wheels'][slot]={...defaults[key==='gimbal'?'axes':'wheels'][slot],...structuredClone(cfg)};
      ensureSlots(defaults,key);
      if(key==='gimbal')for(const axis of Object.keys(defaults.axes))for(const suffix of ['', 'Target','Speed'])defaults.bindings[axis+suffix]??='';
    }
    defaults.bindings=Object.fromEntries(Object.keys(defaults.bindings).map(field=>[field,item.bindings?.[field]||'']));
    for(const prop of ['axes','wheels'])if(defaults[prop])for(const slot of Object.keys(defaults[prop]))Object.assign(defaults[prop][slot],item[prop]?.[slot]||item[prop]?.[({bl:'rl',br:'rr'})[slot]]||{});
    if(key==='motors')for(const prop of ['selected','focus','bus'])if(item[prop]!==undefined)defaults[prop]=structuredClone(item[prop]);
  }
  return modules;
}

export function normalizePath(path) { return String(path).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase(); }

export function snapshotProfile(state, connection) {
  return {version: 2, ...(state.profileId ? {id: state.profileId} : {}), name: state.profileName,
    elfPath: state.elfPath, connection, rate: state.rate, window: state.window, modules: structuredClone(state.modules),
    watches: state.watches.map(({path, label, unit, scale, plot}) => ({path, label, unit, scale, plot}))};
}

export class ProfilePersistence {
  constructor(api, getSnapshot, onSaved, onError) {
    this.api = api; this.getSnapshot = getSnapshot; this.onSaved = onSaved; this.onError = onError;
    this.timer = 0; this.revision = 0; this.savedRevision = 0; this.queue = Promise.resolve();
  }
  changed() { this.revision++; clearTimeout(this.timer); this.timer = setTimeout(() => this.flush().catch(this.onError), 650); }
  flush(force = false) {
    clearTimeout(this.timer);
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!force && this.savedRevision === this.revision) return;
      const body = this.getSnapshot();
      if (!body?.elfPath) return;
      const revision = this.revision;
      const result = await this.api.request('profile/save', body);
      this.savedRevision = revision;
      this.onSaved(result, this.revision === revision);
      return result;
    });
    return this.queue;
  }
  get dirty() { return this.savedRevision !== this.revision; }
}
