/** Browser behavior for the existing distribution cards; values and statistics remain saved evidence. */
export const distributionChartScript = String.raw`
(() => {
  const groups = new Map();
  const hint = 'Hover, tap or focus a point to inspect it.';
  const number = value => new Intl.NumberFormat(undefined, {maximumFractionDigits:3}).format(value);
  const display = (value, unit) => {
    if (unit === 'ns' || unit === 's') {
      const seconds = unit === 'ns' ? value / 1e9 : value;
      if (Math.abs(seconds) < 1e-6) return number(seconds * 1e9) + ' ns';
      if (Math.abs(seconds) < 1e-3) return number(seconds * 1e6) + ' µs';
      if (Math.abs(seconds) < 1) return number(seconds * 1e3) + ' ms';
      return number(seconds) + ' s';
    }
    return number(value) + ' ' + unit;
  };
  // Binary searches count all samples, including those omitted from the bounded SVG.
  const bound = (values, value, upper) => {
    let low = 0, high = values.length;
    while (low < high) {const mid = (low + high) >>> 1;
      if (values[mid] < value || (upper && values[mid] === value)) low = mid + 1; else high = mid;
    }
    return low;
  };
  const render = group => {
    const full = group.max - group.min, width = group.to - group.from;
    const epsilon = Math.max(Number.EPSILON * Math.max(Math.abs(group.min), Math.abs(group.max), 1), full * 1e-9);
    for (const view of group.views) {
      const svg = view.querySelector('svg.distribution'), unit = view.dataset.unit;
      const x = value => width === 0 ? 350 : 18 + (value - group.from) * 664 / width;
      svg.dataset.currentMin = String(group.from); svg.dataset.currentMax = String(group.to);
      const whisker = svg.querySelector('.whisker'), box = svg.querySelector('.box'), median = svg.querySelector('.median');
      whisker.setAttribute('x1', x(Number(svg.dataset.min))); whisker.setAttribute('x2', x(Number(svg.dataset.max)));
      box.setAttribute('x', x(Number(svg.dataset.q1)));box.setAttribute('width', Math.max(1,x(Number(svg.dataset.q3))-x(Number(svg.dataset.q1))));
      median.setAttribute('x1', x(Number(svg.dataset.median)));median.setAttribute('x2', x(Number(svg.dataset.median)));
      let plottedVisible = 0;
      for (const point of view.querySelectorAll('.sample')) {
        const value = Number(point.dataset.value), visible = value >= group.from && value <= group.to;
        point.setAttribute('cx', x(value));point.style.display = visible ? '' : 'none';
        if (visible) plottedVisible++;
      }
      const values = view.distributionValues;
      const count = bound(values, group.to, true) - bound(values, group.from, false);
      view.querySelector('.distribution-scale').textContent = 'Shared series range: ' + display(group.from, unit) + ' – ' + display(group.to, unit) + ' (' + unit + ')';
      view.querySelector('.distribution-visible').textContent = count + ' / ' + values.length + ' samples in view' +
        (values.length > 512 ? ' · ' + plottedVisible + ' plotted points in view' : '') + '. Zoom changes the view only.';
      for (const control of view.querySelectorAll('[data-distribution-bound]')) {
        control.value = String(control.dataset.distributionBound === 'min' ? group.from : group.to);control.disabled = full === 0;
      }
      for (const control of view.querySelectorAll('[data-distribution-slider]')) {
        control.value = String(full === 0 ? 0 : 1000 * ((control.dataset.distributionSlider === 'min' ? group.from : group.to) - group.min) / full);
        control.disabled = full === 0;
      }
      for (const button of view.querySelectorAll('[data-distribution-action]')) {
        const action = button.dataset.distributionAction;
        button.disabled = full === 0 || (action === 'in' && width <= Math.max(full * 1e-6, epsilon)) ||
          (['out','fit'].includes(action) && group.from === group.min && group.to === group.max) ||
          (action === 'left' && group.from <= group.min + epsilon) || (action === 'right' && group.to >= group.max - epsilon);
      }
      if (view.inspectedPoint && view.inspectedPoint.style.display === 'none') {
        view.querySelector('.plot-detail').textContent = hint;view.inspectedPoint = undefined;
      }
    }
  };
  const setRange = (group, from, to) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) {render(group);return;}
    const full = group.max - group.min, width = Math.min(to - from, full);
    from = Math.max(group.min, Math.min(from, group.max - width));to = from + width;
    // Exact endpoints make Fit reversible without accumulated floating point drift.
    if (width >= full) {from = group.min;to = group.max;}
    group.from = from;group.to = to;render(group);
  };
  for (const view of document.querySelectorAll('.distribution-view')) {
    const key = view.dataset.distributionGroup;
    const group = groups.get(key) || {min:Number(view.dataset.fullMin),max:Number(view.dataset.fullMax),views:[]};
    groups.set(key,group);group.views.push(view);
    view.distributionValues = JSON.parse(view.dataset.values);delete view.dataset.values;
    const svg = view.querySelector('svg.distribution');
    const inspect = point => {
      group.anchor = Number(point.dataset.value);view.inspectedPoint = point;
      view.querySelector('.plot-detail').textContent = point.dataset.detail;
    };
    for (const point of svg.querySelectorAll('.sample')) {
      point.addEventListener('mouseenter',()=>inspect(point));
      point.addEventListener('focus',()=>inspect(point));
      point.addEventListener('click',()=>{point.focus();inspect(point);});
    }
    // A tap anywhere on the plot selects the nearest visible sample, so small mobile dots remain usable.
    svg.addEventListener('click', event => {
      if (event.target.closest('.sample')) return;
      const rect = svg.getBoundingClientRect(), x = (event.clientX - rect.left) * 700 / rect.width;
      const points = [...svg.querySelectorAll('.sample')].filter(point=>point.style.display !== 'none');
      const point = points.reduce((best,point)=>!best || Math.abs(Number(point.getAttribute('cx'))-x)<Math.abs(Number(best.getAttribute('cx'))-x)?point:best,undefined);
      if (point) {point.focus();inspect(point);}
    });
    for (const button of view.querySelectorAll('[data-distribution-action]')) button.addEventListener('click',()=>{
      const action = button.dataset.distributionAction, width = group.to - group.from, full = group.max - group.min;
      if (full === 0) return;
      if (action === 'fit') {group.anchor = undefined;setRange(group,group.min,group.max);return;}
      if (action === 'left' || action === 'right') {const step = width * (action === 'left' ? -.25 : .25);setRange(group,group.from+step,group.to+step);return;}
      const next = action === 'in' ? Math.max(width / 2,full * 1e-6) : Math.min(width * 2,full);
      const center = Number.isFinite(group.anchor) && group.anchor >= group.from && group.anchor <= group.to ? group.anchor : (group.from+group.to)/2;
      setRange(group,center-next/2,center+next/2);
    });
    for (const control of view.querySelectorAll('[data-distribution-bound]')) control.addEventListener('change',()=>{
      setRange(group,Number(view.querySelector('[data-distribution-bound="min"]').value),Number(view.querySelector('[data-distribution-bound="max"]').value));
    });
    for (const control of view.querySelectorAll('[data-distribution-slider]')) control.addEventListener('input',()=>{
      const from = Number(view.querySelector('[data-distribution-slider="min"]').value),to = Number(view.querySelector('[data-distribution-slider="max"]').value);
      setRange(group,group.min+(group.max-group.min)*from/1000,group.min+(group.max-group.min)*to/1000);
    });
  }
  for (const group of groups.values()) {group.from = group.min;group.to = group.max;render(group);}
})();`;
