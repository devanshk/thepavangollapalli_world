// A small function plotter on canvas: automatic ranges, a grid with round ticks, curves that
// break at poles instead of drawing a vertical line through them, and a read-out under the pointer.
import { cssVar, pointer, clamp } from '../../assets/js/kit.js';
import { evalReal } from './numeric.js';

function ticks(lo, hi, target) {
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
const label = (v) => String(+v.toPrecision(6));

/** createPlot(canvas, spec, root) → { destroy() }.  spec: { v, curves: [{ e, label }], marks, range, shade } */
export function createPlot(canvas, spec, root) {
  const ctx = canvas.getContext('2d');
  const colours = [cssVar(root, '--st-accent'), cssVar(root, '--st-c2'), cssVar(root, '--st-c3')];
  const ink = { grid: cssVar(root, '--st-line'), text: cssVar(root, '--st-muted'), strong: cssVar(root, '--st-text'), bg: cssVar(root, '--st-bg') };
  const mono = cssVar(root, '--font-mono');
  let hover = null;

  let [x0, x1] = spec.range || [-4, 4];
  if (spec.range && spec.shade) {
    const pad = (x1 - x0) * 0.25 || 1;
    x0 -= pad;
    x1 += pad;
  }
  for (const m of spec.marks) {
    x0 = Math.min(x0, m - 1.5);
    x1 = Math.max(x1, m + 1.5);
  }
  const fns = spec.curves.map((c) => (x) => evalReal(c.e, { [spec.v]: x }));

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = ink.bg;
    ctx.fillRect(0, 0, w, h);

    const n = Math.max(120, Math.round(w));
    const xs = Array.from({ length: n + 1 }, (_, i) => x0 + ((x1 - x0) * i) / n);
    const ys = fns.map((f) => xs.map(f));
    // vertical range from the middle 92% of the values, so one pole does not flatten everything
    const finite = ys.flat().filter(Number.isFinite).sort((a, b) => a - b);
    let y0 = finite.length ? finite[Math.floor(finite.length * 0.04)] : -1;
    let y1 = finite.length ? finite[Math.ceil(finite.length * 0.96) - 1] : 1;
    if (spec.shade || spec.marks.length) {
      y0 = Math.min(y0, 0);
      y1 = Math.max(y1, 0);
    }
    if (!(y1 - y0 > 1e-9)) {
      y0 -= 1;
      y1 += 1;
    }
    const padY = (y1 - y0) * 0.14;
    y0 -= padY;
    y1 += padY;
    const X = (x) => ((x - x0) / (x1 - x0)) * w;
    const Y = (y) => h - ((y - y0) / (y1 - y0)) * h;

    ctx.lineWidth = 1;
    ctx.font = `10px ${mono}`;
    ctx.fillStyle = ink.text;
    for (const t of ticks(x0, x1, w / 70)) {
      ctx.strokeStyle = ink.grid;
      ctx.globalAlpha = t === 0 ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(Math.round(X(t)) + 0.5, 0);
      ctx.lineTo(Math.round(X(t)) + 0.5, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center';
      ctx.fillText(label(t), clamp(X(t), 12, w - 12), h - 4);
    }
    for (const t of ticks(y0, y1, h / 38)) {
      ctx.strokeStyle = ink.grid;
      ctx.globalAlpha = t === 0 ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(Y(t)) + 0.5);
      ctx.lineTo(w, Math.round(Y(t)) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      if (Y(t) > 12 && Y(t) < h - 14) ctx.fillText(label(t), 4, Y(t) - 3);
    }

    if (spec.shade && spec.range) {
      ctx.fillStyle = colours[0];
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.moveTo(X(spec.range[0]), Y(0));
      for (let i = 0; i <= n; i++) if (xs[i] >= spec.range[0] && xs[i] <= spec.range[1] && Number.isFinite(ys[0][i])) ctx.lineTo(X(xs[i]), Y(ys[0][i]));
      ctx.lineTo(X(spec.range[1]), Y(0));
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ys.forEach((row, c) => {
      ctx.strokeStyle = colours[c % colours.length];
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i <= n; i++) {
        const y = row[i];
        // lift the pen at a gap in the domain or a jump too large to be a real slope
        if (!Number.isFinite(y) || (pen && Math.abs(y - row[i - 1]) > (y1 - y0) * 1.5)) {
          pen = false;
          if (!Number.isFinite(y)) continue;
        }
        const py = clamp(Y(y), -50, h + 50);
        if (pen) ctx.lineTo(X(xs[i]), py);
        else ctx.moveTo(X(xs[i]), py);
        pen = true;
      }
      ctx.stroke();
    });

    ctx.fillStyle = ink.strong;
    for (const m of spec.marks) {
      ctx.beginPath();
      ctx.arc(X(m), Y(0), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // legend, or the values under the pointer
    ctx.font = `11px ${mono}`;
    ctx.textAlign = 'right';
    const rows = spec.curves.map((c, i) => ({ text: hover == null ? c.label : `${c.label} = ${Number.isFinite(fns[i](hover)) ? label(fns[i](hover)) : 'undefined'}`, colour: colours[i % colours.length] }));
    if (hover != null) rows.unshift({ text: `${spec.v} = ${label(hover)}`, colour: ink.text });
    rows.forEach((r, i) => {
      ctx.fillStyle = r.colour;
      ctx.fillText(r.text, w - 8, 15 + i * 14);
    });
    if (hover != null) {
      ctx.strokeStyle = ink.text;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(X(hover), 0);
      ctx.lineTo(X(hover), h);
      ctx.stroke();
      ctx.setLineDash([]);
      fns.forEach((f, i) => {
        const y = f(hover);
        if (!Number.isFinite(y)) return;
        ctx.fillStyle = colours[i % colours.length];
        ctx.beginPath();
        ctx.arc(X(hover), Y(y), 3.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  const follow = (p) => {
    hover = x0 + clamp(p.nx, 0, 1) * (x1 - x0);
    draw();
  };
  const off = pointer(canvas, { hover: follow, down: follow, move: follow, leave() { hover = null; draw(); } }, { touchAction: 'pan-y' });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  if (observer) observer.observe(canvas);
  draw();
  return {
    destroy() {
      off();
      if (observer) observer.disconnect();
    },
  };
}
