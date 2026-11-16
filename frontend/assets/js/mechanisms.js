import library from '../models/library.json' with {type:'json'};

export const mechanismLibrary=library;
// Only exact shipped snapshots are corrected; custom geometry and all bindings stay intact.
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
export function migrateMechanism(model,kind){
 const migration=kind==='gimbal'&&library.gimbalMigrations.find(m=>JSON.stringify(ordered(m.from))===JSON.stringify(ordered(model)));
 if(!migration)return structuredClone(model);
 return structuredClone(migration.to?library.gimbal.find(m=>m.id===migration.to):{...model,id:'legacy-four-axis',name:'旧四轴自定义（请重新选择构型）'});
}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const rad=v=>v*Math.PI/180;
const I=()=>[[1,0,0],[0,1,0],[0,0,1]];
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const mul=(a,b)=>a.map(row=>b[0].map((_,j)=>row.reduce((s,v,k)=>s+v*b[k][j],0)));
const apply=(r,v)=>r.map(row=>row.reduce((s,n,i)=>s+n*v[i],0));
const rotation=(axis,angle)=>{const l=Math.hypot(...axis),[x,y,z]=axis.map(v=>v/l),c=Math.cos(angle),s=Math.sin(angle),t=1-c;return [[t*x*x+c,t*x*y-s*z,t*x*z+s*y],[t*x*y+s*z,t*y*y+c,t*y*z-s*x],[t*x*z-s*y,t*y*z+s*x,t*z*z+c]];};
const euler=angles=>angles.reduce((r,v,i)=>mul(r,rotation([[1,0,0],[0,1,0],[0,0,1]][i],rad(v))),I());
export const rotateHeading=(v,h)=>v&&finite(h)?apply(rotation([0,0,1],h),v):null;
export const defaultAxis=()=>({motor:'',sign:1,ratio:1,zero:0,min:-180,max:180});
export function mechanism(config,kind){return config.mechanism||library[kind].find(m=>m.id===(kind==='chassis'?config.layout:'yaw-pitch'))||library[kind][0];}
export const slots=(config,kind)=>mechanism(config,kind)[kind==='gimbal'?'joints':'wheels'];
export const slotLabel=(config,kind,id)=>slots(config,kind).find(s=>s.id===id)?.label||id;
export function supportsWorldGimbal(cfg){
 const joints=slots(cfg,'gimbal'),mount=cfg.mount;
 return joints.length===2&&joints[0].id==='yaw'&&joints[0].parent===null&&joints[1].id==='pitch'&&joints[1].parent==='yaw'&&
  joints[0].axis[0]===0&&joints[0].axis[1]===0&&joints[0].axis[2]>0&&joints[1].axis[0]===0&&joints[1].axis[1]<0&&joints[1].axis[2]===0&&
  joints.every(j=>(j.rest||[]).every(v=>v===0))&&(!mount||[...mount.position,...mount.rotation].every(v=>v===0));
}
export function ensureSlots(config,kind){
 const group=kind==='gimbal'?'axes':'wheels';config[group]??={};config.bindings??={};
 for(const s of slots(config,kind)){
  config[group][s.id]={...(kind==='gimbal'?defaultAxis():{motor:'',sign:1,ratio:1}),...config[group][s.id]};
  if(kind==='gimbal')for(const suffix of ['', 'Target','Speed'])config.bindings[s.id+suffix]??='';
 }
 if(kind==='gimbal')config.mount??={position:[0,0,0],rotation:[0,0,0]};
 return config;
}
export function selectMechanism(config,kind,model){config.mechanism=structuredClone(model);if(kind==='chassis')config.layout=model.id;ensureSlots(config,kind);}
export function bindingFields(config,kind,base={}){
 if(kind!=='gimbal')return base;
 return {...Object.fromEntries(slots(config,kind).flatMap(j=>[['', '反馈角度'],['Target','目标角度'],['Speed','反馈角速度']].map(([suffix,label])=>[j.id+suffix,j.label+' '+label]))),enabled:base.enabled||'云台使能',mode:base.mode||'控制模式（原始枚举）'};
}

// Open chain forward kinematics: X forward, Y left, Z up; geometry in mm.
const gimbalAdapters=new Map();
export function registerGimbalAdapter(id,adapter){gimbalAdapters.set(id,adapter);}
export function solveGimbal(config,states,field='angle',{heading=0,reference=false}={}){
 const model=mechanism(config,'gimbal'),adapter=gimbalAdapters.get(model.adapter);
 if(!adapter)throw Error('未注册云台解算器：'+model.adapter);
 return adapter(model,config,states,field,{heading,reference});
}
registerGimbalAdapter('joint-tree',(model,config,states,field,{heading,reference})=>{
 const mount=config.mount||{position:[0,0,0],rotation:[0,0,0]},baseR=mul(rotation([0,0,1],finite(heading)?heading:0),euler(mount.rotation)),baseP=rotateHeading(mount.position,finite(heading)?heading:0);
 const transforms=new Map(),joints=[];
 for(const joint of model.joints){
  const parent=joint.parent?transforms.get(joint.parent):{p:baseP,r:baseR,valid:finite(heading)};
  const state=states[joint.id],raw=state?.[field];
  const usable=reference||(finite(raw)&&(field!=='angle'||state.source==='变量反馈'||state.motor?.status==='online'));
  const p=add(parent.p,apply(parent.r,joint.origin)),rest=mul(parent.r,euler(joint.rest||[0,0,0]));
  const r=mul(rest,rotation(joint.axis,reference?0:usable?raw:0)),valid=parent.valid&&usable;
  const t={p,r,valid};transforms.set(joint.id,t);joints.push({...joint,position:p,axis:apply(rest,joint.axis.map(v=>v/Math.hypot(...joint.axis))),valid});
 }
 const end=transforms.get(model.tool.parent),tool=add(end.p,apply(end.r,model.tool.origin)),direction=end.valid?apply(end.r,model.tool.origin.map(v=>v/Math.hypot(...model.tool.origin))):null;
 return {joints,tool,origin:end.p,direction,complete:!!direction,yaw:direction?Math.atan2(direction[1],direction[0]):null,pitch:direction?Math.atan2(direction[2],Math.hypot(direction[0],direction[1])):null};
});

const chassisAdapters=new Map();
export function registerChassisAdapter(id,adapter){chassisAdapters.set(id,adapter);}
function driveRows(model,cfg){
 if(model.adapter==='uicrm-four'){const a=model.factor,k=(cfg.halfLength+cfg.halfWidth)*a;return model.wheels.map((w,i)=>[[1,1,-1,-1][i]*a,[1,-1,1,-1][i]*a,k*(i<2?1-cfg.offset:1+cfg.offset)]);}
 // Rows map [right m/s, forward m/s, clockwise rad/s] to wheel m/s.
 // Matrix rotation coefficient is multiplied by halfWidth in metres.
 return model.wheels.map(w=>[w.drive[0],w.drive[1],w.drive[2]*cfg.halfWidth]);
}
function linearSolve(a,b){
 const n=b.length,m=a.map((row,i)=>[...row,b[i]]);
 for(let j=0;j<n;j++){let p=j;for(let i=j+1;i<n;i++)if(Math.abs(m[i][j])>Math.abs(m[p][j]))p=i;if(Math.abs(m[p][j])<1e-10)return null;[m[p],m[j]]=[m[j],m[p]];const d=m[j][j];m[j]=m[j].map(v=>v/d);for(let i=0;i<n;i++)if(i!==j){const f=m[i][j];m[i]=m[i].map((v,k)=>v-f*m[j][k]);}}
 return m.map(row=>row[n]);
}
const matrixAdapter={
 estimate(model,cfg,rates){
  if(!model.wheels.every(w=>finite(rates[w.id])))return null;
  const keys=model.components||['vx','vy','omega'],indices=keys.map(k=>['vx','vy','omega'].indexOf(k)),rows=driveRows(model,cfg).map(r=>indices.map(i=>r[i])),b=model.wheels.map(w=>rates[w.id]*cfg.radius);
  const a=indices.map((_,i)=>indices.map((_,j)=>rows.reduce((s,r)=>s+r[i]*r[j],0))),atb=indices.map((_,i)=>rows.reduce((s,r,j)=>s+r[i]*b[j],0)),x=linearSolve(a,atb);
  return x?{vx:null,vy:null,omega:null,...Object.fromEntries(keys.map((k,i)=>[k,x[i]]))}:null;
 },
 commands(model,cfg,v){return Object.fromEntries(model.wheels.map((w,i)=>[w.id,driveRows(model,cfg)[i].reduce((s,a,j)=>s+a*(v[['vx','vy','omega'][j]]||0),0)/cfg.radius]));}
};
registerChassisAdapter('matrix',matrixAdapter);registerChassisAdapter('uicrm-four',matrixAdapter);
export function estimateChassis(cfg,rates){const m=mechanism(cfg,'chassis');return chassisAdapters.get(m.adapter)?.estimate(m,cfg,rates)??null;}
export function commandChassis(cfg,values){const m=mechanism(cfg,'chassis');return chassisAdapters.get(m.adapter)?.commands(m,cfg,values)??null;}
export function wheelGeometry(cfg){return Object.fromEntries(slots(cfg,'chassis').map(w=>[w.id,{...w,x:w.position[0],y:w.position[1],angle:rad(w.angle)}]));}

// Editable JSON is checked here and independently by the persistence API.
export function validateMechanism(model,kind){
 const fail=()=>{throw Error('构型 JSON 无效：请检查关节父级、轴向、轮位与解算器。');};
 const id=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v);
 const vec=v=>Array.isArray(v)&&v.length===3&&v.every(x=>finite(x)&&Math.abs(x)<=100000);
 if(!model||!id(model.id)||typeof model.name!=='string'||!model.name||model.name.length>100)fail();
 const items=model[kind==='gimbal'?'joints':'wheels'];if(!Array.isArray(items)||!items.length||items.length>16)fail();
 const seen=new Set();for(const s of items){if(!id(s.id)||seen.has(s.id)||typeof s.label!=='string'||!s.label||s.label.length>100)fail();
  if(kind==='gimbal'){if(s.parent!==null&&!seen.has(s.parent)||!vec(s.origin)||!vec(s.axis)||Math.hypot(...s.axis)<.000001||(s.rest&&!vec(s.rest)))fail();}
  else if(!vec(s.position)||!finite(s.angle)||Math.abs(s.angle)>360000||![1,-1].includes(s.rollingSign)||![-1,0,1].includes(s.roller)||(model.adapter==='matrix'&&!vec(s.drive)))fail();seen.add(s.id);
 }
 if(kind==='gimbal'){const fields=items.flatMap(j=>['','Target','Speed'].map(s=>j.id+s));if(items.some(j=>['enabled','mode','config'].includes(j.id))||new Set(fields).size!==fields.length||!gimbalAdapters.has(model.adapter)||!seen.has(model.tool?.parent)||!vec(model.tool?.origin)||Math.hypot(...model.tool.origin)<.000001)fail();}
 else {if(!chassisAdapters.has(model.adapter))fail();if(model.outline&&(!Array.isArray(model.outline)||model.outline.length<3||model.outline.length>32||model.outline.some(p=>!Array.isArray(p)||p.length!==2||!p.every(v=>finite(v)&&Math.abs(v)<=100000))))fail();if(model.adapter==='uicrm-four'&&(items.map(s=>s.id).join(',')!=='fl,fr,bl,br'||!finite(model.factor)||model.factor<=0||model.factor>2))fail();if(model.adapter==='matrix'&&(!Array.isArray(model.components)||!model.components.length||new Set(model.components).size!==model.components.length||model.components.some(k=>!['vx','vy','omega'].includes(k))))fail();}
 return structuredClone(model);
}
