function html(value: unknown): string { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function compact(value: number): string { return Number(value.toPrecision(4)).toString(); }
export interface NormalizedPlot {
  kind: string;
  title: string;
  description: string;
  options: {package: string; feature: string; workload: string; collector: string; versions: string[]; reference_version: string};
  data: {version: string; metric: string; value: number; unit: string; ratio: number | null; normalization_status: string}[];
}

export function normalizedChart(plot: NormalizedPlot, id: string): string {
  const versions = plot.options.versions;
  const colors = ['#219eaa', '#d89b39', '#ad87e6', '#518ee5'];
  const metrics = [...new Set(plot.data.map(row => row.metric))];
  const width = 900, height = 340, left = 55, top = 20, bottom = 280;
  const max = Math.max(1.1, ...plot.data.map(row => row.ratio ?? 0)) * 1.1;
  const x = (version: string) => left + versions.indexOf(version) * (width - left - 25) / Math.max(1, versions.length - 1);
  const y = (ratio: number) => bottom - ratio / max * (bottom - top);
  const curves = metrics.map((metric, i) => {
    const rows = plot.data.filter(row => row.metric === metric);
    let segment = ''; const paths: string[] = [];
    const points = rows.map(row => {
      if (!finite(row.ratio)) {if (segment) paths.push(segment); segment = ''; return '';}
      segment += `${segment ? ' L' : 'M'}${x(row.version)},${y(row.ratio)}`;
      const detail = `${row.version} · ${metric}: ${row.value} ${row.unit}; ratio ${row.ratio}; ${row.normalization_status}`;
      return `<circle tabindex="0" class="hover-value" data-detail="${html(detail)}" data-target="${html(id)}" cx="${x(row.version)}" cy="${y(row.ratio)}" r="4" fill="${colors[i % colors.length]}"><title>${html(detail)}</title></circle>`;
    }).join('');
    if (segment) paths.push(segment);
    return paths.map(d => `<path d="${d}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="2"/>`).join('') + points;
  }).join('');
  const ticks = versions.map(v => `<text x="${x(v)}" y="305" text-anchor="middle" fill="currentColor" font-size="12">${html(v)}</text>`).join('');
  const yticks = [0, 1, max].map(v => `<text x="45" y="${y(v)}" text-anchor="end" fill="currentColor" font-size="12">${compact(v)}</text>`).join('');
  const legend = metrics.map((metric, i) => `<span style="color:${colors[i % colors.length]}">● ${html(metric.replace('julia.', ''))}</span>`).join(' · ');
  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%" role="img" aria-label="Overlaid measurements relative to ${html(plot.options.reference_version)}"><line x1="${left}" x2="875" y1="${y(1)}" y2="${y(1)}" stroke="currentColor" stroke-dasharray="5 5"/>${yticks}${curves}${ticks}</svg><div>${legend}</div><p>${html(plot.description)}</p><pre class="plot-detail" id="${html(id)}">Hover or focus a point for its raw value and normalization status.</pre>`;
}
