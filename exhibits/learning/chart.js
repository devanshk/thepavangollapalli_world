// chart.js — draws the loss curve on a logarithmic axis.

const decadeLabel = (d) => (d >= 0 ? String(10 ** d) : d >= -3 ? (10 ** d).toFixed(-d) : `1e${d}`);

/**
 * drawChart(ctx, size, history, theme)
 *   size     { pw, ph, dpr } from the kit view
 *   history  from history.js (values, count, stride)
 *   theme    { bg, line, muted, accent, mono } resolved from the design tokens
 */
export function drawChart(ctx, size, history, theme) {
  const { pw, ph, dpr } = size;
  if (!pw || !ph) return;
  const left = 42 * dpr;
  const right = 10 * dpr;
  const top = 9 * dpr;
  const bottom = 20 * dpr;
  const w = pw - left - right;
  const h = ph - top - bottom;
  const { values, count, stride } = history;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, pw, ph);

  // Whole decades that contain the data, never fewer than two.
  let lo = -3;
  let hi = -1;
  if (count > 0) {
    let min = Infinity;
    let max = 0;
    for (let i = 0; i < count; i++) {
      const v = Math.max(values[i], 1e-12);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    hi = Math.ceil(Math.log10(max));
    lo = Math.floor(Math.log10(min));
    if (hi - lo < 2) lo = hi - 2;
  }
  const yOf = (logValue) => top + (h * (hi - logValue)) / (hi - lo);

  ctx.font = `${Math.round(10.5 * dpr)}px ${theme.mono}`;
  ctx.lineWidth = dpr;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let d = lo; d <= hi; d++) {
    const y = Math.round(yOf(d)) + 0.5;
    ctx.strokeStyle = theme.line;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(pw - right, y);
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.fillText(decadeLabel(d), left - 6 * dpr, y);
  }

  const steps = count * stride;
  ctx.fillStyle = theme.muted;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('step 0', left, ph - 5 * dpr);
  ctx.textAlign = 'right';
  ctx.fillText(steps.toLocaleString('en-US'), pw - right, ph - 5 * dpr);
  if (count === 0) return;

  const xOf = (i) => left + (w * (i + 0.5)) / count;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const y = yOf(Math.log10(Math.max(values[i], 1e-12)));
    if (i === 0) ctx.moveTo(xOf(i), y);
    else ctx.lineTo(xOf(i), y);
  }
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.6 * dpr;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.arc(xOf(count - 1), yOf(Math.log10(Math.max(values[count - 1], 1e-12))), 2.6 * dpr, 0, Math.PI * 2);
  ctx.fill();
}
