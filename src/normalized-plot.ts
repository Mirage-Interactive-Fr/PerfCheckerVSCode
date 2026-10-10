function html(value: unknown): string { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function compact(value: number): string { return Number(value.toPrecision(4)).toString(); }
function versionLabel(value: string): string {
  return /^[a-f0-9]{12,40}$/i.test(value) ? value.slice(0,7) : value.length > 10 ? value.slice(0,9) + '…' : value;
}
export interface NormalizedPlot {
  kind: string;
  title: string;
  description: string;
  options: {package: string; feature: string; workload: string; collector: string; versions: string[]; reference_version: string};
  data: {version: string; metric: string; value: number; unit: string; ratio: number | null; normalization_status: string}[];
}

export function normalizedChart(plot: NormalizedPlot, id: string): string {
  const versions = [...new Set(plot.options.versions)].filter(version => plot.data.some(row => row.version === version));
  const colors = ['#219eaa', '#d89b39', '#ad87e6', '#518ee5'];
  const metrics = [...new Set(plot.data.map(row => row.metric))];
  const width = 900, height = 380, left = 55, top = 20, bottom = 280;
  const max = plot.data.reduce((maximum, row) => versions.includes(row.version) && finite(row.ratio) && row.ratio >= 0 ? Math.max(maximum, row.ratio) : maximum, 1.1) * 1.1;
  const x = (version: string) => versions.length === 1 ? (left + width - 25) / 2 : left + versions.indexOf(version) * (width - left - 25) / (versions.length - 1);
  const y = (ratio: number) => bottom - ratio / max * (bottom - top);
  const curves = metrics.map((metric, i) => {
    const rows = versions.map(version => plot.data.find(row => row.metric === metric && row.version === version));
    let segment = ''; const paths: string[] = [];
    const points = rows.map(row => {
      if (!row || !finite(row.ratio) || row.ratio < 0) {if (segment) paths.push(segment); segment = ''; return '';}
      segment += `${segment ? ' L' : 'M'}${x(row.version)},${y(row.ratio)}`;
      const detail = `${row.version} · ${metric}: ${row.value} ${row.unit}; ratio ${row.ratio}; ${row.normalization_status}`;
      return `<circle tabindex="0" aria-label="${html(detail)}" class="hover-value" data-version="${html(row.version)}" data-metric="${i}" data-detail="${html(detail)}" data-target="${html(id)}" cx="${x(row.version)}" cy="${y(row.ratio)}" r="4" fill="${colors[i % colors.length]}"><title>${html(detail)}</title></circle>`;
    }).join('');
    if (segment) paths.push(segment);
    return paths.map(d => `<path d="${d}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="2"/>`).join('') + points;
  }).join('');
  const density = Math.max(1, Math.ceil(versions.length / 8));
  const ticks = versions.map((v,index) => index % density && index !== versions.length - 1 ? '' :
    `<text x="${x(v)}" y="310" transform="rotate(-40 ${x(v)} 310)" text-anchor="end" fill="currentColor" font-size="12" aria-label="${html(v)}"><title>${html(v)}</title>${html(versionLabel(v))}</text>`).join('');
  const yticks = [0, 1, max].map(v => `<text x="45" y="${y(v)}" text-anchor="end" fill="currentColor" font-size="12">${compact(v)}</text>`).join('');
  const legend = metrics.map((metric, i) => `<label><input type="checkbox" data-normalized-metric="${i}" checked><svg width="12" height="12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2" fill="${colors[i % colors.length]}"/></svg> ${html(metric.replace('julia.', ''))}</label>`).join('');
  const choices = versions.map((version,index) => `<option value="${index}">${html(version)}</option>`).join('');
  const lastChoices = versions.map((version,index) => `<option value="${index}"${index === versions.length - 1 ? ' selected' : ''}>${html(version)}</option>`).join('');
  const unavailable = plot.data.filter(row => versions.includes(row.version) && (!finite(row.ratio) || row.ratio < 0))
    .map(row => `${row.version} · ${row.metric}: ${row.normalization_status}`);
  const payload = {versions, metrics, colors, max, data: plot.data.filter(row => versions.includes(row.version))};
  return `<div class="normalized-plot" data-normalized="${html(JSON.stringify(payload))}" data-detail-target="${html(id)}"><div class="normalized-controls"><fieldset class="normalized-legend"><legend>Visible metrics</legend>${legend}</fieldset><div class="normalized-range"><label>From measured version<select data-normalized-from>${choices}</select></label><label>To measured version<select data-normalized-to>${lastChoices}</select></label><button type="button" data-normalized-reset>Reset chart</button></div></div><svg class="normalized-chart" width="100%" viewBox="0 0 ${width} ${height}" role="img" aria-label="Overlaid measurements relative to ${html(plot.options.reference_version)}"><line x1="${left}" x2="875" y1="${y(1)}" y2="${y(1)}" stroke="currentColor" stroke-dasharray="5 5"/>${yticks}<g class="normalized-series">${curves}</g><g class="normalized-labels">${ticks}</g></svg><p>${html(plot.description)}</p><p class="normalized-scope">View only: ratios and the reference remain unchanged. Gaps are preserved.</p>${unavailable.length ? `<p class="notice">Unavailable ratios: ${html(unavailable.join('; '))}. Gaps are preserved.</p>` : ''}<pre class="plot-detail" id="${html(id)}">Hover or focus a point for its raw value and normalization status.</pre></div>`;
}

// Executed only inside the Output webview's existing nonce-authorized script.
// Labels and measurements enter through escaped JSON attributes; DOM updates
// use textContent and SVG attributes, never untrusted HTML or script fragments.
export const normalizedChartScript = String.raw`
document.querySelectorAll('.normalized-plot').forEach(chart=>{
  const plot=JSON.parse(chart.dataset.normalized),svg=chart.querySelector('svg.normalized-chart');
  const series=svg.querySelector('.normalized-series'),labels=svg.querySelector('.normalized-labels');
  const from=chart.querySelector('[data-normalized-from]'),to=chart.querySelector('[data-normalized-to]');
  const metrics=[...chart.querySelectorAll('[data-normalized-metric]')],detail=document.getElementById(chart.dataset.detailTarget);
  const emptyDetail='Hover or focus a point for its raw value and normalization status.';
  const node=(name,attributes,text)=>{const value=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [key,item]of Object.entries(attributes))value.setAttribute(key,String(item));if(text!==undefined)value.textContent=text;return value;};
  const label=version=>/^[a-f0-9]{12,40}$/i.test(version)?version.slice(0,7):version.length>10?version.slice(0,9)+'…':version;
  const show=event=>{const point=event.target.closest?.('.hover-value');if(point&&chart.contains(point))detail.textContent=point.dataset.detail;};
  chart.addEventListener('mouseover',show);chart.addEventListener('focusin',show);
  const render=changed=>{
    let first=Number(from.value),last=Number(to.value);
    if(first>last){if(changed===from)to.value=String(last=first);else from.value=String(first=last);}
    const versions=plot.versions.slice(first,last+1),density=Math.max(1,Math.ceil(versions.length/8));
    const active=document.activeElement?.closest?.('.hover-value'),focus=active&&chart.contains(active)?{metric:active.dataset.metric,version:active.dataset.version}:undefined;
    const x=version=>versions.length===1?465:55+versions.indexOf(version)*820/(versions.length-1),y=ratio=>280-ratio/plot.max*260;
    series.replaceChildren();labels.replaceChildren();detail.textContent=emptyDetail;
    plot.metrics.forEach((metric,index)=>{
      if(!metrics[index].checked)return;
      let segment='';const paths=[],points=[];
      for(const version of versions){
        const row=plot.data.find(value=>value.metric===metric&&value.version===version);
        if(!row||!Number.isFinite(row.ratio)||row.ratio<0){if(segment)paths.push(segment);segment='';continue;}
        segment+=(segment?' L':'M')+x(version)+','+y(row.ratio);
        const text=version+' · '+metric+': '+row.value+' '+row.unit+'; ratio '+row.ratio+'; '+row.normalization_status;
        const point=node('circle',{tabindex:0,'aria-label':text,class:'hover-value','data-version':version,'data-metric':index,'data-detail':text,'data-target':chart.dataset.detailTarget,cx:x(version),cy:y(row.ratio),r:4,fill:plot.colors[index%plot.colors.length]});
        point.append(node('title',{},text));points.push(point);
      }
      if(segment)paths.push(segment);
      for(const d of paths)series.append(node('path',{d,fill:'none',stroke:plot.colors[index%plot.colors.length],'stroke-width':2}));
      series.append(...points);
    });
    versions.forEach((version,index)=>{if(index%density&&index!==versions.length-1)return;
      const tick=node('text',{x:x(version),y:310,transform:'rotate(-40 '+x(version)+' 310)','text-anchor':'end',fill:'currentColor','font-size':12,'aria-label':version});
      tick.append(node('title',{},version),document.createTextNode(label(version)));labels.append(tick);
    });
    if(focus){const replacement=[...series.querySelectorAll('.hover-value')].find(point=>point.dataset.metric===focus.metric&&point.dataset.version===focus.version);if(replacement)replacement.focus();else metrics[Number(focus.metric)].focus();}
  };
  [...metrics,from,to].forEach(control=>control.addEventListener('change',()=>render(control)));
  chart.querySelector('[data-normalized-reset]').addEventListener('click',()=>{metrics.forEach(control=>control.checked=true);from.value='0';to.value=String(plot.versions.length-1);render();});
});`;
