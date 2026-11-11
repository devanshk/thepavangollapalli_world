// render.js — draws a scene on a 2D canvas. Poses are interpolated between the last two
// simulation steps; shapes are batched into one path per colour so a few hundred bodies cost a
// dozen fills and strokes.
import { cssVar } from '../../assets/js/kit.js';
import { STATIC, DYNAMIC, CIRCLE } from './body.js';
import { GROUND } from './scenes.js';

const TAU = Math.PI * 2;

/** Returns { draw }, or null when the browser provides no 2D canvas context. */
export function createRenderer(canvas, root) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const token = (name) => cssVar(root, name);
  const col = {
    bg: token('--st-bg'),
    surface: token('--st-surface'),
    raise: token('--st-raise'),
    line: token('--st-line'),
    muted: token('--st-muted'),
    faint: token('--st-faint'),
    accent: token('--st-accent'),
    good: token('--st-good'),
    warn: token('--st-warn'),
    series: [1, 2, 3, 4, 5, 6].map((i) => token(`--st-c${i}`)),
  };
  const font = token('--font-mono');

  // camera (device pixels per metre, y of the floor line) and interpolation factor
  let s = 1;
  let oy = 0;
  let px = 1;
  let alpha = 1;
  // interpolated pose of the body last passed to pose()
  let ix = 0;
  let iy = 0;
  let ic = 1;
  let is = 0;

  function pose(b) {
    if (b.awake) {
      const a = b.pa + (b.a - b.pa) * alpha;
      ix = b.px + (b.x - b.px) * alpha;
      iy = b.py + (b.y - b.py) * alpha;
      ic = Math.cos(a);
      is = Math.sin(a);
    } else {
      ix = b.x;
      iy = b.y;
      ic = b.cos;
      is = b.sin;
    }
  }

  /** Add a body's outline, and optionally a mark from its centre that shows rotation, to the path. */
  function trace(b, mark) {
    pose(b);
    const shape = b.shape;
    const X = ix * s;
    const Y = oy - iy * s;
    if (shape.kind === CIRCLE) {
      const r = shape.radius * s;
      ctx.moveTo(X + r, Y);
      ctx.arc(X, Y, r, 0, TAU);
    } else {
      const v = shape.verts;
      for (let i = 0, end = 2 * shape.n; i < end; i += 2) {
        const x = X + (ic * v[i] - is * v[i + 1]) * s;
        const y = Y - (is * v[i] + ic * v[i + 1]) * s;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    if (mark) {
      const m = shape.mark * s;
      ctx.moveTo(X, Y);
      ctx.lineTo(X + ic * m, Y - is * m);
    }
  }

  /** Canvas position of a body-local point, in outX / outY. */
  let outX = 0;
  let outY = 0;
  function anchor(b, lx, ly) {
    pose(b);
    outX = (ix + ic * lx - is * ly) * s;
    outY = oy - (iy + is * lx + ic * ly) * s;
  }

  function backdrop(pw, ph, W) {
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, pw, ph);
    ctx.strokeStyle = col.line;
    ctx.lineWidth = px;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    for (let x = 2; x < W; x += 2) {
      const X = Math.round(x * s) + 0.5;
      ctx.moveTo(X, 0);
      ctx.lineTo(X, oy);
    }
    for (let y = 2; y * s < oy; y += 2) {
      const Y = Math.round(oy - y * s) + 0.5;
      ctx.moveTo(0, Y);
      ctx.lineTo(pw, Y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // the ground: a filled band with hatching under a bright floor line
    const depth = ph - oy;
    ctx.fillStyle = col.surface;
    ctx.fillRect(0, oy, pw, depth);
    ctx.strokeStyle = col.line;
    ctx.beginPath();
    for (let X = -depth; X < pw; X += Math.max(8 * px, 0.5 * s)) {
      ctx.moveTo(X, ph);
      ctx.lineTo(X + depth, oy);
    }
    ctx.stroke();
    ctx.strokeStyle = col.muted;
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.moveTo(0, oy);
    ctx.lineTo(pw, oy);
    ctx.stroke();
  }

  function structures(bodies) {
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (b.type === DYNAMIC || b.hidden || (b.type === STATIC) !== (pass === 0)) continue;
        trace(b, false);
      }
      ctx.fillStyle = col.raise;
      ctx.fill();
      ctx.strokeStyle = pass === 0 ? col.faint : col.accent;
      ctx.lineWidth = 1.25 * px;
      ctx.stroke();
    }
  }

  function ropes(joints, debug) {
    ctx.strokeStyle = col.muted;
    ctx.lineWidth = 1.25 * px;
    ctx.beginPath();
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (j.kind !== 'distance' || (j.hidden && !debug)) continue;
      anchor(j.a, j.lax, j.lay);
      ctx.moveTo(outX, outY);
      anchor(j.b, j.lbx, j.lby);
      ctx.lineTo(outX, outY);
    }
    ctx.stroke();
  }

  function dynamics(bodies, debug) {
    ctx.lineWidth = 1.25 * px;
    ctx.lineJoin = 'round';
    for (let k = -1; k < 6; k++) {
      const color = k < 0 ? col.muted : col.series[k];
      for (let pass = 0; pass < (debug ? 2 : 1); pass++) {
        let any = false;
        ctx.beginPath();
        for (let i = 0; i < bodies.length; i++) {
          const b = bodies[i];
          if (b.type !== DYNAMIC || b.color !== k) continue;
          if (debug && b.awake !== (pass === 0)) continue;
          trace(b, true);
          any = true;
        }
        if (!any) continue;
        const asleep = debug && pass === 1;
        ctx.fillStyle = col.bg;
        ctx.fill();
        ctx.fillStyle = color;
        ctx.globalAlpha = asleep ? 0.08 : 0.3;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.globalAlpha = asleep ? 0.4 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  function pins(joints) {
    const r = 2.2 * px;
    ctx.beginPath();
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (j.kind !== 'revolute') continue;
      anchor(j.b, j.lbx, j.lby);
      ctx.moveTo(outX + r, outY);
      ctx.arc(outX, outY, r, 0, TAU);
    }
    ctx.fillStyle = col.bg;
    ctx.fill();
    ctx.strokeStyle = col.muted;
    ctx.lineWidth = px;
    ctx.stroke();
  }

  function tether(joint) {
    anchor(joint.b, joint.lbx, joint.lby);
    const tx = joint.tx * s;
    const ty = oy - joint.ty * s;
    ctx.strokeStyle = col.accent;
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.beginPath();
    ctx.moveTo(outX, outY);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(tx, ty, 7 * px, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = col.accent;
    ctx.beginPath();
    ctx.arc(outX, outY, 3 * px, 0, TAU);
    ctx.fill();
  }

  /** The engine's own view: fattened AABBs, contact points (loaded or speculative) and normals. */
  function internals(world) {
    const bodies = world.bodies;
    ctx.strokeStyle = col.faint;
    ctx.lineWidth = px;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.hidden) continue;
      ctx.rect(b.minX * s, oy - b.maxY * s, (b.maxX - b.minX) * s, (b.maxY - b.minY) * s);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    const contacts = world.contacts;
    const len = Math.max(0.3 * s, 7 * px);
    ctx.strokeStyle = col.good;
    ctx.lineWidth = 1.25 * px;
    ctx.beginPath();
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      for (let k = 0; k < c.count; k++) {
        const p = k === 0 ? c.p0 : c.p1;
        ctx.moveTo(p.x * s, oy - p.y * s);
        ctx.lineTo(p.x * s + c.nx * len, oy - p.y * s - c.ny * len);
      }
    }
    ctx.stroke();
    const half = 1.75 * px;
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass === 0 ? col.faint : col.warn;
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        for (let k = 0; k < c.count; k++) {
          const p = k === 0 ? c.p0 : c.p1;
          if (p.jn > 0 === (pass === 1)) ctx.fillRect(p.x * s - half, oy - p.y * s - half, 2 * half, 2 * half);
        }
      }
    }
    legend();
  }

  function legend() {
    ctx.font = `${Math.round(11 * px)}px ${font}`;
    ctx.textBaseline = 'middle';
    const y = 14 * px;
    let x = 10 * px;
    const label = (text) => {
      ctx.fillStyle = col.muted;
      ctx.fillText(text, x, y);
      x += ctx.measureText(text).width + 12 * px;
    };
    ctx.fillStyle = col.warn;
    ctx.fillRect(x, y - 2 * px, 4 * px, 4 * px);
    x += 9 * px;
    label('contact');
    ctx.strokeStyle = col.good;
    ctx.lineWidth = 1.25 * px;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 10 * px, y);
    ctx.stroke();
    x += 15 * px;
    label('normal');
    ctx.strokeStyle = col.faint;
    ctx.lineWidth = px;
    ctx.strokeRect(x + 0.5, y - 4 * px, 9 * px, 8 * px);
    x += 14 * px;
    label('AABB');
    label('dim = asleep');
  }

  /**
   * scene: from createScene. size: view.size. opts: { alpha: 0..1 between the last two steps,
   * debug: draw internals, drag: the active MouseJoint or null }.
   */
  function draw(scene, size, opts) {
    const world = scene.world;
    px = size.dpr;
    s = size.pw / scene.W;
    oy = size.ph - GROUND * s;
    alpha = opts.alpha;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    backdrop(size.pw, size.ph, scene.W);
    structures(world.bodies);
    ropes(world.joints, opts.debug);
    dynamics(world.bodies, opts.debug);
    pins(world.joints);
    if (opts.debug) internals(world);
    if (opts.drag) tether(opts.drag);
  }

  return { draw };
}
