// SVG presentation only. Kinematics and ELF bindings stay outside this module.
const green='#287963',amber='#d39547';
const svg=(tag,attrs={},text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n;};
const line=(parent,a,b,color,width=3,dash=false)=>parent.append(svg('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:color,'stroke-width':width,'stroke-linecap':'round',...(dash?{'stroke-dasharray':'6 5'}:{})}));
export function drawMechanism(parent,{feedback,target,reference,states,project,baseHeight=56}){
 const point=v=>project([v[0],v[1],v[2]+baseHeight]);
 const draw=(pose,color,dash=false,referenceOnly=false)=>{
  const g=svg('g',{class:referenceOnly?'mechanism-reference':dash?'mechanism-target':'mechanism-feedback','data-direction':pose.direction?.join(',')||'missing'});
  const byId=new Map(pose.joints.map(j=>[j.id,j]));
  for(const joint of pose.joints){const from=joint.parent?byId.get(joint.parent).position:[0,0,0];
   if(referenceOnly||dash&&joint.valid||!dash&&joint.valid)line(g,point(from),point(joint.position),color,dash||referenceOnly?2:10,dash||referenceOnly);
  }
  if(pose.complete){line(g,point(pose.origin),point(pose.tool),color,referenceOnly?2:dash?4:12,dash||referenceOnly);const end=point(pose.tool);g.append(svg('circle',{cx:end[0],cy:end[1],r:dash||referenceOnly?4:7,fill:dash||referenceOnly?'#fff':color,stroke:color,'stroke-width':2}));}
  parent.append(g);
 };
 draw(reference,'#b4c5bb',false,true);draw(target,amber,true);draw(feedback,green);
 for(const joint of feedback.joints){
  const pos=joint.position,p=point(pos),state=states[joint.id],color=state?.motor?.status==='online'?green:state?.motor?.status==='offline'?'#bf6b5a':'#8da394';
  const yaw=Math.abs(joint.axis[2])>.95;
  if(yaw){const ring=svg('g',{class:'yaw-bearing'}),r=joint.id==='yaw'?40:25;ring.append(svg('polyline',{points:Array.from({length:49},(_,i)=>point([pos[0]+r*Math.cos(i*Math.PI/24),pos[1]+r*Math.sin(i*Math.PI/24),pos[2]])).map(p=>p.join(',')).join(' '),fill:'none',stroke:color,'stroke-width':3}));parent.append(ring);}
  else line(parent,point(pos.map((v,i)=>v-joint.axis[i]*23)),point(pos.map((v,i)=>v+joint.axis[i]*23)),color,7);
  const button=svg('g',{class:'motor-hotspot chassis-wheel','data-motor':joint.id,tabindex:0,role:'button','aria-label':joint.label+' 电机数据，点击或按回车固定'});
  button.append(svg('circle',{cx:p[0],cy:p[1],r:23,fill:'transparent'}),svg('circle',{cx:p[0],cy:p[1],r:12,fill:'#fff',stroke:color,'stroke-width':3}),svg('text',{x:p[0],y:p[1]+4,'text-anchor':'middle',fill:color,'font-size':10},joint.label.slice(0,1)),svg('text',{x:p[0]+18,y:p[1]+4,fill:color,'font-size':11},joint.label));parent.append(button);
 }
}
