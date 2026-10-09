export interface ProfileObservation {
  case_id: string;
  target_id: string;
  comparison_key?: string;
  metric: string;
  measurement_definition: string;
  unit: string;
  value: number;
  aggregation?: string;
  attributes: {
    package?: string; feature?: string; workload?: string; version?: string;
    stack?: string[]; runtime_dispatch?: boolean[]; inference_status?: string[];
    inferred_return_type?: string[]; gc_event?: boolean[];
    source_file?: string; source_line?: number;
  };
}

interface FlameNode {
  name: string; value: number; children: Map<string, FlameNode>;
  dynamic: boolean; unstable: boolean; gc: boolean; inferredTypes: Set<string>;
}

export interface FlameFrame {
  index: number; parent: number | null; name: string; value: number;
  x0: number; x1: number; depth: number;
  dynamic: boolean; unstable: boolean; gc: boolean; inferredTypes: string[];
}

export interface FlameModel {
  frames: FlameFrame[]; totalWeight: number; metric: string; unit: string;
  maximumDepth: number; unavailable?: string;
}

const html = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g,
  character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
const freshNode = (name: string): FlameNode => ({name, value:0, children:new Map(),
  dynamic:false, unstable:false, gc:false, inferredTypes:new Set()});

/** Preserve every profile/allocation group. The predicates match the Output views. */
export function profileGroups(observations: ProfileObservation[], kind: 'flame' | 'allocation'): Map<string, ProfileObservation[]> {
  const groups = new Map<string, ProfileObservation[]>();
  for (const observation of observations) {
    const accepted = kind === 'flame' ? Array.isArray(observation.attributes.stack) :
      observation.metric === 'julia.alloc.bytes' &&
      (observation.measurement_definition.includes('profile-allocs') || observation.measurement_definition.includes('line-tracking'));
    if (!accepted) continue;
    const key = JSON.stringify([observation.case_id, observation.target_id, observation.measurement_definition]);
    const group = groups.get(key) ?? [];
    group.push(observation); groups.set(key, group);
  }
  return groups;
}

/** Inclusive frame weights and normalized coordinates; no minimum width or frame limit. */
export function flameModel(observations: ProfileObservation[]): FlameModel {
  const root = freshNode('root');
  const model: FlameModel = {frames:[], totalWeight:0, metric:observations[0]?.metric ?? '',
    unit:observations[0]?.unit ?? '', maximumDepth:0};
  for (const observation of observations) {
    if (!Number.isFinite(observation.value) || observation.value <= 0) continue;
    root.value += observation.value;
    let parent = root;
    for (const [index, name] of (observation.attributes.stack ?? []).entries()) {
      let node = parent.children.get(name);
      if (!node) {node = freshNode(name); parent.children.set(name, node);}
      node.value += observation.value;
      node.dynamic ||= observation.attributes.runtime_dispatch?.[index] === true;
      const inference = observation.attributes.inference_status?.[index];
      node.unstable ||= Boolean(inference && inference !== 'concrete');
      node.gc ||= observation.attributes.gc_event?.[index] === true;
      const inferred = observation.attributes.inferred_return_type?.[index];
      if (inferred) node.inferredTypes.add(inferred);
      parent = node;
    }
  }
  if (!Number.isFinite(root.value)) {
    model.unavailable = 'The total profile weight exceeds the numeric range. Inspect the original JSON.';
    return model;
  }
  model.totalWeight = root.value;
  if (!root.value) return model;
  type Pending = {node: FlameNode; left: number; depth: number; parent: number | null};
  const pending: Pending[] = [];
  const children = (node: FlameNode, left: number, depth: number, parent: number | null): void => {
    const entries: Pending[] = [];
    for (const child of [...node.children.values()].sort((a,b) => b.value-a.value)) {
      entries.push({node:child, left, depth, parent}); left += child.value/root.value;
    }
    for (let index=entries.length-1; index>=0; index--) pending.push(entries[index]);
  };
  children(root, 0, 0, null);
  while (pending.length) {
    const {node, left, depth, parent} = pending.pop()!;
    const index = model.frames.length+1;
    model.frames.push({index, parent, name:node.name, value:node.value,
      x0:left, x1:left+node.value/root.value, depth, dynamic:node.dynamic,
      unstable:node.unstable, gc:node.gc, inferredTypes:[...node.inferredTypes]});
    model.maximumDepth = Math.max(model.maximumDepth, depth);
    children(node, left, depth+1, index);
  }
  return model;
}

export function flameFramePath(model: FlameModel, index: number): string[] {
  const path: string[] = [];
  let frame: FlameFrame | undefined = model.frames[index-1];
  while (frame) {
    path.push(frame.name);
    frame = frame.parent === null ? undefined : model.frames[frame.parent-1];
  }
  return path.reverse();
}

export function flameGraph(observations: ProfileObservation[], id: string): string {
  if (!observations.length) return '';
  const model = flameModel(observations);
  if (!model.frames.length) return `<p class="muted">${html(model.unavailable ?? 'No positive profile weights with call frames are available. Inspect the original JSON for all observations.')}</p>`;
  const height = (model.maximumDepth+1)*25;
  const frames = model.frames.map(frame => {
    const state = frame.gc ? 'gc' : frame.dynamic ? 'dynamic' : frame.unstable ? 'unstable' : 'normal';
    return `<g class="flame-node ${state}" tabindex="0" data-frame-index="${frame.index}" data-target="${html(id)}" aria-label="${html(`Frame ${frame.index}: ${frame.name}; ${frame.value} ${model.unit}`)}"><rect x="${frame.x0*1000}" y="${frame.depth*25}" width="${(frame.x1-frame.x0)*1000}" height="24"></rect></g>`;
  }).join('');
  const buttons = [['in','Zoom +','Zoom in flame graph'],['out','Zoom −','Zoom out flame graph'],
    ['left','←','Pan flame graph left'],['right','→','Pan flame graph right'],['fit','Fit','Fit all flame frames']]
    .map(([action,label,title]) => `<button type="button" data-flame-action="${action}" aria-label="${title}" title="${title}">${label}</button>`).join('');
  return `<div class="flame-view" data-flame="${html(JSON.stringify(model))}" data-detail-target="${html(id)}"><div class="flame-toolbar" role="group" aria-label="Flame graph view">${buttons}<details class="flame-range"><summary>Range</summary><div>${['min','max'].map((bound,index) => `<label>${index ? 'End' : 'Start'} (% of total weight)<input type="number" min="0" max="100" step="any" value="${index ? 100 : 0}" data-flame-bound="${bound}"></label>`).join('')}</div></details></div><div class="flame-inspection"><label>Inspect frame<input type="number" min="1" max="${model.frames.length}" step="1" value="1" data-flame-index></label><label>Frame index<input type="range" min="1" max="${model.frames.length}" step="1" value="1" data-flame-slider></label><span>${model.frames.length} frames</span></div><p class="flame-scope">Frame width includes child calls. Zoom changes the view only; every frame remains available through Inspect frame.</p><p class="flame-range-error" role="alert"></p><div class="flame-wrap" tabindex="0" aria-label="Scrollable flame graph; use arrow keys to pan, plus and minus to zoom, and zero to fit"><svg class="flame" viewBox="0 0 1000 ${height}" width="1000" height="${height}" role="group" aria-label="Profile call stacks weighted by ${html(model.metric)}"><defs><clipPath id="${html(id)}-clip"><rect width="1000" height="${height}"></rect></clipPath></defs><g class="flame-frames" clip-path="url(#${html(id)}-clip)">${frames}</g></svg></div><pre class="flame-detail" id="${html(id)}" aria-live="polite">Use the frame index, or hover, tap or focus a frame, to inspect its full call path.</pre></div>`;
}

export const flameChartStyle = String.raw`
.flame-toolbar{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin:12px 0 4px}
.flame-toolbar button{font-size:12px;min-height:36px;padding:6px 8px}.flame-toolbar button:disabled{opacity:.5;cursor:default}
.flame-range{flex:1 0 100%;font-size:12px}.flame-range summary{cursor:pointer;padding:7px 0}.flame-range>div{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.flame-inspection{display:flex;flex-wrap:wrap;align-items:end;gap:8px;margin:8px 0}.flame-inspection label,.flame-range label{display:grid;min-width:0;gap:4px;font-size:12px}.flame-inspection label:first-child{flex:0 1 110px}.flame-inspection label:nth-child(2){flex:1 1 180px}
.flame-inspection input,.flame-range input{box-sizing:border-box;width:100%;min-width:0;max-width:100%;margin:0;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:5px}.flame-inspection input[type=range]{padding:0;min-height:36px}
.flame-scope,.flame-range-error{font-size:12px;line-height:1.5}.flame-range-error:empty{display:none}
.flame-view .flame-wrap{max-height:480px;overflow:auto;min-width:0}.flame-view .flame{display:block;min-width:0;width:100%;max-width:none}
.flame-view .flame-node rect{fill:var(--vscode-charts-blue);stroke:none}.flame-view .flame-node.dynamic rect{fill:var(--vscode-charts-red)}.flame-view .flame-node.unstable rect{fill:var(--vscode-charts-purple)}.flame-view .flame-node.gc rect{fill:var(--vscode-charts-orange)}
.flame-view .flame-node:hover rect,.flame-view .flame-node:focus rect,.flame-view .flame-node.selected rect{stroke:none;filter:brightness(1.3)}
.flame-view .flame-node text{font-size:11px;pointer-events:none}.flame-view .flame-detail{overflow-wrap:anywhere;max-height:420px;overflow:auto}
@media(max-width:400px){.flame-toolbar button,.flame-inspection input{min-height:44px}.flame-range>div{grid-template-columns:1fr}.flame-view .flame-detail{font-size:12px}}
`;

export const flameChartScript = String.raw`
(() => {
  for (const view of document.querySelectorAll('.flame-view')) {
    const model=JSON.parse(view.dataset.flame),svg=view.querySelector('svg.flame'),viewport=view.querySelector('.flame-wrap');
    const frames=[...svg.querySelectorAll('.flame-node')],detail=document.getElementById(view.dataset.detailTarget);
    const indexInput=view.querySelector('[data-flame-index]'),slider=view.querySelector('[data-flame-slider]'),error=view.querySelector('.flame-range-error');
    const height=(model.maximumDepth+1)*25,minimumWidth=1e-6;
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const colors=canvas.getContext('2d',{willReadFrequently:true}),inkCache=new Map();
    let from=0,to=1,selected=1,marked=0;
    const foregroundInk=group=>{
      if(!colors)return;
      const style=getComputedStyle(group.querySelector('rect')),background=getComputedStyle(view.closest('.flame-card')||view).backgroundColor;
      const key=style.fill+'|'+style.filter+'|'+background;
      if(!inkCache.has(key)){
        colors.clearRect(0,0,1,1);colors.filter='none';
        colors.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background');colors.fillRect(0,0,1,1);
        colors.fillStyle=background;colors.fillRect(0,0,1,1);
        colors.filter=style.filter;colors.fillStyle=style.fill;colors.fillRect(0,0,1,1);
        const rgb=[...colors.getImageData(0,0,1,1).data].slice(0,3).map(value=>{const s=value/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;});
        const luminance=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
        inkCache.set(key,(luminance+.05)/.05>=1.05/(luminance+.05)?'#000000':'#ffffff');
      }
      return inkCache.get(key);
    };
    const labelInk=group=>{const label=group.querySelector('text'),ink=foregroundInk(group);if(label&&ink)label.style.fill=ink;};
    const path=index=>{const names=[];for(let frame=model.frames[index-1];frame;frame=frame.parent===null?undefined:model.frames[frame.parent-1])names.push(frame.name);return names.reverse();};
    const show=()=>{
      const frame=model.frames[selected-1];
      indexInput.value=slider.value=String(selected);slider.setAttribute('aria-valuetext','Frame '+selected+': '+frame.name);
      detail.textContent='Frame '+selected+' / '+model.frames.length+'\nInclusive weight: '+frame.value+' '+model.unit+' ('+(100*frame.value/model.totalWeight)+'% of total)\nMetric: '+model.metric+'\nCall path:\n'+path(selected).join(' → ')+
        (frame.dynamic?'\nRuntime dispatch detected':'')+(frame.unstable?'\nNon-concrete inferred return':'')+(frame.gc?'\nGC frame':'')+(frame.inferredTypes.length?'\nInferred: '+frame.inferredTypes.join(' | '):'');
      if(marked){frames[marked-1].classList.remove('selected');labelInk(frames[marked-1]);}
      frames[selected-1].classList.add('selected');labelInk(frames[selected-1]);marked=selected;
    };
    const render=()=>{
      const width=Math.max(1,viewport.clientWidth),span=to-from;
      svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));svg.style.height=height+'px';
      svg.dataset.currentMin=String(from);svg.dataset.currentMax=String(to);
      svg.querySelector('clipPath rect').setAttribute('width',String(width));
      const labels=[];
      for(let i=0;i<frames.length;i++){
        const frame=model.frames[i],group=frames[i],rect=group.querySelector('rect');
        const x=(frame.x0-from)*width/span,w=(frame.x1-frame.x0)*width/span;
        rect.setAttribute('x',String(x));rect.setAttribute('width',String(w));
        let label=group.querySelector('text');
        if(!label){label=document.createElementNS('http://www.w3.org/2000/svg','text');label.textContent=frame.name;group.append(label);}
        const left=Math.max(0,x),right=Math.min(width,x+w),available=right-left-8;
        label.setAttribute('x',String(left+4));label.setAttribute('y',String(frame.depth*25+17));label.style.display='';
        labels.push({label,group,available});
      }
      // Batch DOM writes, then measurements, then presentation writes: no layout per frame.
      for(const item of labels){item.visible=item.available>0&&item.label.getComputedTextLength()<=item.available;item.ink=item.visible?foregroundInk(item.group):undefined;}
      for(const item of labels){item.label.style.display=item.visible?'':'none';if(item.ink)item.label.style.fill=item.ink;}
      for(const input of view.querySelectorAll('[data-flame-bound]'))input.value=String((input.dataset.flameBound==='min'?from:to)*100);
      for(const button of view.querySelectorAll('[data-flame-action]')){
        const action=button.dataset.flameAction;
        button.disabled=(action==='in'&&span<=minimumWidth)||(action==='left'&&from===0)||(action==='right'&&to===1)||(['out','fit'].includes(action)&&from===0&&to===1);
      }
    };
    const setRange=(start,end)=>{
      if(!Number.isFinite(start)||!Number.isFinite(end)||!(end>start)){error.textContent='Enter a finite start below the end.';render();return false;}
      const span=Math.min(1,Math.max(minimumWidth,end-start));from=Math.max(0,Math.min(start,1-span));to=from+span;
      if(span>=1){from=0;to=1;}if(1-to<Number.EPSILON*4)to=1;if(from<Number.EPSILON*4)from=0;
      error.textContent='';render();return true;
    };
    const inspect=(index,reveal)=>{
      if(!Number.isInteger(index)||index<1||index>model.frames.length){error.textContent='Choose a frame from 1 to '+model.frames.length+'.';show();return;}
      selected=index;error.textContent='';const frame=model.frames[index-1];
      if(reveal){const center=(frame.x0+frame.x1)/2,span=to-from;if(center<from||center>to)setRange(center-span/2,center+span/2);viewport.scrollTop=Math.max(0,frame.depth*25-viewport.clientHeight/2);}
      show();
    };
    const action=kind=>{
      const span=to-from;
      if(kind==='fit'){setRange(0,1);return;}
      if(kind==='left'||kind==='right'){const offset=span*(kind==='left'?-.25:.25);setRange(from+offset,to+offset);return;}
      const frame=model.frames[selected-1],anchor=(frame.x0+frame.x1)/2,center=anchor>=from&&anchor<=to?anchor:(from+to)/2;
      const next=kind==='in'?Math.max(minimumWidth,span/2):Math.min(1,span*2);setRange(center-next/2,center+next/2);
    };
    for(const button of view.querySelectorAll('[data-flame-action]'))button.addEventListener('click',()=>action(button.dataset.flameAction));
    for(const input of view.querySelectorAll('[data-flame-bound]'))input.addEventListener('change',()=>{
      const start=view.querySelector('[data-flame-bound="min"]').value,end=view.querySelector('[data-flame-bound="max"]').value;
      if(!start.trim()||!end.trim()||!Number.isFinite(Number(start))||!Number.isFinite(Number(end))||Number(start)<0||Number(end)>100||Number(end)<=Number(start)){
        error.textContent='Enter a start and end from 0 to 100, with the start below the end.';render();return;
      }
      setRange(Number(start)/100,Number(end)/100);
    });
    indexInput.addEventListener('change',()=>inspect(Number(indexInput.value),true));slider.addEventListener('input',()=>inspect(Number(slider.value),true));
    const frameFor=event=>event.target.closest?.('.flame-node');
    svg.addEventListener('mouseover',event=>{const frame=frameFor(event);if(frame)inspect(Number(frame.dataset.frameIndex),false);});
    svg.addEventListener('focusin',event=>{const frame=frameFor(event);if(frame)inspect(Number(frame.dataset.frameIndex),true);});
    svg.addEventListener('click',event=>{const frame=frameFor(event);if(frame){frame.focus();inspect(Number(frame.dataset.frameIndex),true);}});
    viewport.addEventListener('keydown',event=>{const key={ArrowLeft:'left',ArrowRight:'right','+':'in','=':'in','-':'out','0':'fit'}[event.key];if(key){event.preventDefault();action(key);}});
    const observer=new ResizeObserver(render);observer.observe(viewport);
    const themeObserver=new MutationObserver(()=>{inkCache.clear();render();});
    themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','style','data-vscode-theme-id']});
    if(document.fonts)document.fonts.ready.then(render);
    render();show();
  }
})();`;
