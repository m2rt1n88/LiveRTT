import {element, number} from './api.js';

export function buildCsv(watches, rows) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+@\-]/.test(text) && typeof value !== 'number') text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const start = rows[0]?.time || 0;
  const header = ['timestamp_unix_s', 'elapsed_s', ...watches.flatMap(w => [w.path + ' [raw]', w.label + ' [' + (w.unit || 'unitless') + ']'])];
  const data = rows.map(row => [row.time, row.time - start, ...watches.flatMap(w => {
    const raw = row.raw[w.path];
    return [raw, raw === null || raw === undefined ? '' : Number(raw) * w.scale];
  })]);
  return '\ufeff' + [header, ...data].map(row => row.map(cell).join(',')).join('\r\n');
}

export class VariableChart {
  constructor(canvas, empty, legend, tooltip) {
    Object.assign(this, {canvas, empty, legend, tooltip});
    this.plot = null;
    canvas.addEventListener('pointermove', event => this.hover(event));
    canvas.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  }
  draw(watches, history, windowValue) {
    this.watches = watches.filter(w => w.plot);
    this.legend.replaceChildren(...this.watches.map(w => {
      const span = element('span'); const dot = element('i', 'series-dot'); dot.style.setProperty('--series', w.color);
      span.append(dot, document.createTextNode(w.label + (w.unit ? ' · ' + w.unit : ''))); return span;
    }));
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr); this.canvas.height = Math.round(rect.height * dpr);
    const ctx = this.canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const width = rect.width, height = rect.height;
    const groups = [...new Set(this.watches.map(w => w.unit || '无单位'))];
    const axesWidth = Math.min(Math.max(groups.length, 1) * 48, width * .48);
    const left = axesWidth + 10, right = width - 15, top = 34, bottom = height - 33;
    const last = history.at(-1)?.time || 0;
    const start = windowValue === 'all' ? (history[0]?.time || 0) : Math.max(history[0]?.time || 0, last - Number(windowValue));
    const span = Math.max(last - start, 1);
    const rows = history.filter(row => row.time >= start);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '9px Consolas, monospace'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = top + (bottom - top) * i / 4; ctx.strokeStyle = '#eaf0eb'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      const x = left + (right - left) * i / 4; ctx.fillStyle = '#9aaa9e'; ctx.textAlign = 'center';
      ctx.fillText(number(start + span * i / 4 - (history[0]?.time || 0)) + ' s', x, height - 10);
    }
    let hasData = false;
    groups.forEach((unit, index) => {
      const channels = this.watches.filter(w => (w.unit || '无单位') === unit);
      let min = Infinity, max = -Infinity;
      for (const row of rows) for (const watch of channels) {
        const value = row.values[watch.path]; const scaled = Number(value) * watch.scale;
        if (value !== null && value !== undefined && Number.isFinite(scaled)) { min = Math.min(min, scaled); max = Math.max(max, scaled); }
      }
      if (!Number.isFinite(min)) return;
      hasData = true;
      const padding = Math.max((max - min) * .1, Math.abs(max) * .02, .01); min -= padding; max += padding;
      ctx.fillStyle = channels[0].color; ctx.textAlign = 'right';
      const axisX = left - 8 - index * axesWidth / Math.max(groups.length, 1);
      const compact = value => Math.abs(value) >= 10000 ? value.toExponential(1) : Number(value.toPrecision(3)).toString();
      ctx.fillText(unit.slice(0, 10), axisX, 16);
      for (let i = 0; i <= 4; i++) ctx.fillText(compact(max - (max - min) * i / 4), axisX, top + (bottom - top) * i / 4 + 3);
      ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
      for (const watch of channels) {
        ctx.strokeStyle = watch.color; ctx.lineWidth = 1.7; ctx.beginPath(); let pen = false;
        for (const row of rows) {
          const value = row.values[watch.path]; const scaled = Number(value) * watch.scale;
          if (value === null || value === undefined || !Number.isFinite(scaled)) { pen = false; continue; }
          const x = left + (row.time - start) / span * (right - left), y = bottom - (scaled - min) / (max - min) * (bottom - top);
          if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y); pen = true;
        }
        ctx.stroke();
      }
      ctx.restore();
    });
    this.empty.hidden = hasData;
    this.empty.textContent = !this.watches.length ? '在左侧选择需要绘制的变量' : '等待真实采样 · 点击上方「开始采集」';
    this.plot = {left, right, start, span, rows};
    this.tooltip.hidden = true;
  }
  hover(event) {
    const plot = this.plot;
    if (!plot?.rows.length || !this.watches.length) return;
    const rect = this.canvas.getBoundingClientRect(); const x = event.clientX - rect.left;
    const time = plot.start + Math.max(0, Math.min(1, (x - plot.left) / (plot.right - plot.left))) * plot.span;
    let nearest = plot.rows[0];
    for (const row of plot.rows) if (Math.abs(row.time - time) < Math.abs(nearest.time - time)) nearest = row;
    this.tooltip.replaceChildren(element('strong', '', new Date(nearest.time * 1000).toLocaleTimeString('zh-CN', {hour12:false})));
    for (const watch of this.watches) {
      const value = nearest.values[watch.path];
      this.tooltip.append(element('div', '', watch.label + '：' + (value === null || value === undefined ? '缺失' : number(Number(value) * watch.scale) + ' ' + watch.unit)));
    }
    this.tooltip.hidden = false; this.tooltip.style.left = Math.min(Math.max(0, rect.width - 280), x + 10) + 'px';
  }
}
