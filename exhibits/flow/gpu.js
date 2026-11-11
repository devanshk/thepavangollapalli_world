// gpu.js — the solver on the GPU: render targets and the order of the passes.
// One step is: advect velocity (two passes), curl, forces, strokes, pressure projection
// (divergence, red-black relaxation, gradient), then advect dye (two passes) and add dye.
import { program, target, doubleTarget, texture, toScreen } from '../../assets/js/glkit.js';
import * as S from './shaders.js';
import { DISPLAY } from './shader-view.js';
import { STREAKS } from './palette.js';

const SOURCES = {
  advectVel: S.ADVECT_VEL,
  advectVelFix: S.ADVECT_VEL_FIX,
  curl: S.CURL,
  forces: S.FORCES,
  splatVel: S.SPLAT_VEL,
  divergence: S.DIVERGENCE,
  relax: S.RELAX,
  gradient: S.GRADIENT,
  advectDye: S.ADVECT_DYE,
  advectDyeFix: S.ADVECT_DYE_FIX,
  dyeSource: S.DYE_SOURCE,
  resampleVel: S.RESAMPLE_VEL,
  copy: S.COPY,
  display: DISPLAY,
};

export const VIEWS = { dye: 0, speed: 1, vorticity: 2, pressure: 3 };

/** Empty stroke lists in the shape step() and splatVelocity() expect. Up to eight of each per step. */
export function createSplats() {
  return {
    velCount: 0,
    velSeg: new Float32Array(32),
    velVal: new Float32Array(32),
    dyeCount: 0,
    dyeSeg: new Float32Array(32),
    dyeCol: new Float32Array(32),
  };
}

/**
 * createSolver(gl, caps) → the solver. Throws when half-float render targets are missing or a
 * shader fails to compile. Call resize() and setMask() before the first step.
 */
export function createSolver(gl, caps) {
  if (!caps.best) throw new Error('Float render targets are not available');

  // The first format in each list that this GPU can render to.
  const pick = (formats, filter) => {
    for (const format of formats) {
      try {
        target(gl, 4, 4, { format, filter }).dispose();
        return format;
      } catch {
        // not renderable here: try the next one
      }
    }
    throw new Error('No renderable float format');
  };
  const velFormat = pick(['rg16f', 'rgba16f'], 'linear');
  const curlFormat = pick(['r16f', 'rgba16f'], 'linear');
  // Pressure is only ever read texel by texel, so it may use 32-bit floats where they render.
  const scalarFormat = pick(caps.float32 ? ['r32f', 'r16f', 'rgba16f'] : ['r16f', 'rgba16f'], 'nearest');
  pick(['rgba16f'], 'linear');

  const P = {};
  for (const name of Object.keys(SOURCES)) P[name] = program(gl, SOURCES[name]);
  const streakColors = new Float32Array(STREAKS.flat());
  // The solver owns its vertex array. The kit caches one per context object, and that one goes
  // stale when the context is lost and restored.
  const vao = gl.createVertexArray();
  const triangle = () => {
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  let n = 0;
  let m = 0;
  let dn = 0;
  let dm = 0;
  let vel = null;
  let velHat = null;
  let prs = null;
  let div = null;
  let curl = null;
  let dye = null;
  let dyeHat = null;
  let mask = null;
  let probe = null;
  let inflow = 0;
  let dt = 1;

  // Uniforms every simulation pass shares. Unused ones are silently ignored by WebGL.
  function bind(p) {
    p.use();
    p.tex('uVel', vel.read.tex, 0);
    p.tex('uMask', mask, 1);
    gl.uniform2i(p.loc('uSize'), n, m);
    p.v2('uInv', 1 / n, 1 / m);
    if (inflow > 0) p.v2('uSlip', 1.5 / m, (m - 1.5) / m);
    else p.v2('uSlip', 0, 1);
    p.f('uInflow', inflow);
    p.f('uDt', dt);
    return p;
  }
  function draw(t) {
    t.bind();
    triangle();
  }
  function fill(t, r) {
    t.bind();
    gl.clearColor(r, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  function disposeAll(list) {
    for (const t of list) if (t) t.dispose();
  }

  function resize(nn, nm, dyeScale = 2) {
    const old = { n, m, vel, dye, mask, all: [vel, velHat, prs, div, curl, dye, dyeHat, probe] };
    n = nn;
    m = nm;
    dn = nn * dyeScale;
    dm = nm * dyeScale;
    vel = doubleTarget(gl, n, m, { format: velFormat, filter: 'linear' });
    velHat = target(gl, n, m, { format: velFormat, filter: 'linear' });
    prs = doubleTarget(gl, n, m, { format: scalarFormat });
    div = target(gl, n, m, { format: scalarFormat });
    curl = target(gl, n, m, { format: curlFormat, filter: 'linear' });
    dye = doubleTarget(gl, dn, dm, { format: 'rgba16f', filter: 'linear' });
    dyeHat = target(gl, dn, dm, { format: 'rgba16f', filter: 'linear' });
    mask = texture(gl, n, m, { format: 'r8', filter: 'linear' });
    probe = null;
    for (const t of [vel.read, vel.write, velHat, prs.read, prs.write, div, curl, dye.read, dye.write, dyeHat]) fill(t, 0);
    if (old.vel) {
      // Carry the flow over. Velocities are in cells per step, so they scale with the grid.
      const p = P.resampleVel.use();
      p.tex('uVel', old.vel.read.tex, 0);
      gl.uniform2i(p.loc('uSize'), old.n, old.m);
      p.v2('uInv', 1 / old.n, 1 / old.m).v2('uSlip', 0, 1);
      p.v2('uRatio', old.n / n, old.m / m).f('uScale', n / old.n);
      draw(vel.read);
      P.copy.use().tex('uSrc', old.dye.read.tex, 0);
      draw(dye.read);
      disposeAll(old.all);
      gl.deleteTexture(old.mask);
    }
  }

  function setMask(bytes) {
    gl.bindTexture(gl.TEXTURE_2D, mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, m, gl.RED, gl.UNSIGNED_BYTE, bytes);
  }

  /** Still fluid (u = 0) or a uniform stream, with no dye and no pressure. */
  function reset(u) {
    fill(vel.read, u);
    fill(vel.write, u);
    for (const t of [prs.read, prs.write, dye.read, dye.write]) fill(t, 0);
  }

  function splatVelocity(splats) {
    if (!splats.velCount) return;
    bind(P.splatVel).i('uCount', splats.velCount).fv('uSeg', splats.velSeg, 4).fv('uVal', splats.velVal, 4);
    draw(vel.write);
    vel.swap();
  }

  function project(sweeps, omega) {
    bind(P.divergence);
    draw(div);
    const r = bind(P.relax);
    r.tex('uDiv', div.tex, 3);
    for (let s = 0; s < sweeps * 2; s++) {
      // The last two sweeps are unrelaxed, to smooth the ripple over-relaxation leaves behind.
      r.tex('uP', prs.read.tex, 2).i('uParity', s & 1).f('uOmega', s >= sweeps * 2 - 4 ? 1 : omega);
      draw(prs.write);
      prs.swap();
    }
    bind(P.gradient).tex('uP', prs.read.tex, 2);
    draw(vel.write);
    vel.swap();
  }

  // streaks: 0 none, 1 feed the tunnel inlet, 2 lay streaklines across the whole tunnel.
  function addDye(fade, streaks, splats) {
    const p = bind(P.dyeSource);
    p.tex('uDye', dye.read.tex, 2).v2('uDyeSize', dn, dm).f('uFade', fade).f('uStreaks', streaks);
    p.i('uCount', splats ? splats.dyeCount : 0).fv('uStreakCol', streakColors, 3);
    if (splats && splats.dyeCount) p.fv('uSeg', splats.dyeSeg, 4).fv('uCol', splats.dyeCol, 4);
    draw(dye.write);
    dye.swap();
  }

  function step(o) {
    dt = o.dt;
    bind(P.advectVel);
    draw(velHat);
    bind(P.advectVelFix).tex('uHat', velHat.tex, 2);
    draw(vel.write);
    vel.swap();

    bind(P.curl);
    draw(curl);
    bind(P.forces).tex('uCurl', curl.tex, 2).f('uConfine', o.confine).f('uVisc', o.viscosity).f('uFade', o.velFade);
    draw(vel.write);
    vel.swap();

    splatVelocity(o.splats);
    project(o.sweeps, o.omega);

    bind(P.advectDye).tex('uDye', dye.read.tex, 2).v2('uDyeSize', dn, dm);
    draw(dyeHat);
    bind(P.advectDyeFix).tex('uDye', dye.read.tex, 2).tex('uHat', dyeHat.tex, 3).v2('uDyeSize', dn, dm);
    draw(dye.write);
    dye.swap();
    addDye(o.dyeFade, o.streaks, o.splats);
  }

  /** Draw to the canvas. view: a VIEWS index. scale: what maps the field onto the colour map. Colours are linear RGB. */
  function render(view, scale, bg, body, rim) {
    if (view === VIEWS.vorticity) {
      bind(P.curl);
      draw(curl);
    }
    toScreen(gl);
    const p = P.display.use();
    p.tex('uDye', dye.read.tex, 0).tex('uVel', vel.read.tex, 1).tex('uP', prs.read.tex, 2);
    p.tex('uCurl', curl.tex, 3).tex('uMask', mask, 4);
    p.v2('uGrid', n, m).v2('uInv', 1 / n, 1 / m).v2('uDyeInv', 1 / dn, 1 / dm);
    p.i('uView', view).f('uScale', scale);
    p.v3('uBg', bg[0], bg[1], bg[2]).v3('uBody', body[0], body[1], body[2]).v3('uRim', rim[0], rim[1], rim[2]);
    triangle();
  }

  // Float read-back, for the tests only. Returns RGBA floats, or null where the browser refuses.
  function read(tex) {
    if (!probe) probe = target(gl, n, m, { format: 'rgba16f' });
    P.copy.use().tex('uSrc', tex, 0);
    draw(probe);
    while (gl.getError() !== gl.NO_ERROR);
    const out = new Float32Array(n * m * 4);
    gl.readPixels(0, 0, n, m, gl.RGBA, gl.FLOAT, out);
    return gl.getError() === gl.NO_ERROR ? out : null;
  }

  return {
    resize,
    setMask,
    reset,
    step,
    project,
    splatVelocity,
    render,
    setInflow(u) {
      inflow = u;
    },
    fillStreaks() {
      addDye(1, 2, null);
    },
    readVelocity: () => read(vel.read.tex),
    readDivergence() {
      bind(P.divergence);
      draw(div);
      return read(div.tex);
    },
    get formats() {
      return { velocity: velFormat, pressure: scalarFormat };
    },
    dispose() {
      disposeAll([vel, velHat, prs, div, curl, dye, dyeHat, probe]);
      if (mask) gl.deleteTexture(mask);
      gl.deleteVertexArray(vao);
      for (const name of Object.keys(P)) P[name].dispose();
    },
  };
}
