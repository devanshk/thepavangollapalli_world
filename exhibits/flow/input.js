// input.js — every finger at once. The shared kit's pointer() reports one drag (or a pinch);
// the fluid wants each touch on its own, so this tracks raw pointer events instead.
// Positions are 0..1 across the canvas with y pointing up, like the simulation.

const unit = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * trackPointers(canvas, onDown) → { active, flush(), destroy() }
 * active: Map of pointerId → { x, y, px, py, index, released, color }. The frame loop reads a
 * stroke from (px, py) to (x, y), sets px, py itself, then calls flush() to drop lifted fingers,
 * so even a tap that starts and ends between two frames is seen once.
 */
export function trackPointers(canvas, onDown) {
  const active = new Map();
  let count = 0;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const place = (p, e) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    p.x = unit((e.clientX - r.left) / r.width);
    p.y = unit(1 - (e.clientY - r.top) / r.height);
  };
  const down = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // capture is a convenience: without it the stroke just ends at the canvas edge
    }
    const p = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, index: count++, released: false, color: null };
    place(p, e);
    p.px = p.x;
    p.py = p.y;
    if (active.size > 16) active.clear();
    active.set(e.pointerId, p);
    if (onDown) onDown(p);
  };
  const move = (e) => {
    const p = active.get(e.pointerId);
    if (p && !p.released) place(p, e);
  };
  const up = (e) => {
    const p = active.get(e.pointerId);
    if (p) p.released = true;
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  return {
    active,
    flush() {
      for (const [id, p] of active) if (p.released) active.delete(id);
    },
    destroy() {
      canvas.style.touchAction = previousTouchAction;
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      active.clear();
    },
  };
}
