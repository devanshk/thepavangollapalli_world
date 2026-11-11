// LIGHT — a progressive path tracer in a fragment shader. This file is the thin page layer:
// controls, pointer input and camera state. The physics lives in shader/, the GPU plumbing in
// renderer.js and the frame schedule in session.js.
import {
  bar, button, clamp, el, hint, loadCSS, overlay, pointer, segmented, slider, spacer, stat, view,
} from '../../assets/js/kit.js';
import { createGL, onContextLoss } from '../../assets/js/glkit.js';
import { METRES_PER_UNIT, depthOf, makeCamera, pinholeRay } from './camera.js';
import { closestHit } from './mirror.js';
import { createOrbit } from './orbit.js';
import { packScene } from './pack.js';
import { createRenderer, pickFormat } from './renderer.js';
import { SCENES, sceneById } from './scenes.js';
import { createSession } from './session.js';
import { MAX_BOUNCES } from './shader/index.js';
import { madd, normalize, sub } from './vec.js';

/** Samples per pixel after which the image is left alone. Half floats hold fewer usefully. */
const SAMPLE_BUDGET = { rgba32f: 2000, rgba16f: 1000 };
const F_STOPS = [22, 16, 11, 8, 5.6, 4, 2.8, 2, 1.4];
const ORBIT_SMOOTHING_S = 0.09;
const FOCUS_PULL_S = 0.12;
const TAP_SLOP_PX = 6;
const TAP_MS = 450;
const FAR_FOCUS = 400;

const UNAVAILABLE = {
  webgl: {
    title: 'WebGL2 is not available',
    text: 'This exhibit traces light on the GPU and needs WebGL2, which this browser or device does not provide.',
  },
  float: {
    title: 'Float render targets are not available',
    text: 'The path tracer averages light in a floating-point texture, and this GPU cannot render to one.',
  },
  shader: {
    title: 'The path tracer could not start',
    text: 'Its shader did not compile on this GPU, so there is nothing to show here.',
  },
};

const formatDistance = (units) => {
  const metres = units * METRES_PER_UNIT;
  return metres < 1 ? `${Math.round(metres * 100)} cm` : `${metres.toFixed(metres < 10 ? 2 : 1)} m`;
};

export async function mount(root, env) {
  await loadCSS(new URL('./style.css', import.meta.url));
  const v = view(root, {
    aspect: 16 / 9,
    aspectNarrow: 1,
    label: 'Path-traced scene, refining as samples accumulate. Drag to orbit, pinch to zoom, tap to focus.',
  });
  v.wrap.classList.add('light-view');

  const made = createGL(v.canvas);
  const format = made && pickFormat(made.gl, made.caps);
  let renderer = null;
  let problem = !made ? UNAVAILABLE.webgl : !format ? UNAVAILABLE.float : null;
  if (!problem) {
    try {
      renderer = createRenderer(made.gl, format);
    } catch {
      problem = UNAVAILABLE.shader;
    }
  }
  if (problem) {
    overlay(v.wrap, problem);
    return { start() {}, stop() {}, destroy: () => v.destroy() };
  }

  /* ── state ── */
  const sampleBudget = SAMPLE_BUDGET[format];
  const smoothing = env.reducedMotion ? 0 : ORBIT_SMOOTHING_S;
  let scene = SCENES[0];
  let packed = packScene(scene);
  let stop = F_STOPS.indexOf(scene.camera.fNumber);
  let focusPoint = scene.camera.focus;
  let focusLag = 0; // log of (rendered focus distance / true distance), eased to zero after a tap
  const orbit = createOrbit(scene.camera, scene.camera.limits, smoothing);

  function camera() {
    const { w, h } = v.size;
    const cam = makeCamera(
      { target: scene.camera.target, ...orbit.pose },
      { fovDeg: scene.camera.fov, aspect: w / h || 1, minTanH: scene.camera.minTanH, fNumber: F_STOPS[stop], focus: 1 },
    );
    cam.focus = clamp(depthOf(cam, focusPoint), 0.2, FAR_FOCUS) * Math.exp(focusLag);
    return cam;
  }

  function animate(dt) {
    const orbiting = orbit.step(dt);
    const pulling = focusLag !== 0;
    if (pulling) {
      focusLag *= smoothing > 0 ? Math.exp(-dt / FOCUS_PULL_S) : 0;
      if (Math.abs(focusLag) < 1e-3) focusLag = 0;
    }
    renderer.setCamera(camera());
    return orbiting || pulling;
  }

  /* ── on-canvas furniture ── */
  const progressFill = el('div', { class: 'light-progress-fill' });
  const progress = el('div', { class: 'light-progress', 'aria-hidden': 'true' }, progressFill);
  const reticleLabel = el('span', { class: 'light-reticle-label' });
  const reticle = el('div', { class: 'light-reticle', 'aria-hidden': 'true' }, reticleLabel);
  const zoom = el(
    'div',
    { class: 'light-zoom' },
    button({ label: '+', title: 'Zoom in', onClick: () => zoomBy(1.25) }),
    button({ label: '−', title: 'Zoom out', onClick: () => zoomBy(0.8) }),
  );
  zoom.firstChild.setAttribute('aria-label', 'Zoom in');
  zoom.lastChild.setAttribute('aria-label', 'Zoom out');
  v.wrap.append(progress, reticle, zoom);

  /* ── controls ── */
  const samplesStat = stat({ label: 'Samples' });
  const resolutionStat = stat({ label: 'Resolution' });
  const aperture = slider({
    label: 'Aperture',
    min: 0,
    max: F_STOPS.length - 1,
    step: 1,
    value: stop,
    format: (i) => `f/${F_STOPS[i]}`,
    onInput: (i) => {
      stop = i;
      session.invalidate();
    },
  });
  const bounces = slider({
    label: 'Bounces',
    min: 1,
    max: MAX_BOUNCES,
    step: 1,
    value: 6,
    onInput: (n) => {
      renderer.setOptions({ bounces: n });
      session.invalidate();
    },
  });
  bar(
    root,
    segmented({
      label: 'Scene',
      options: SCENES.map((s) => ({ value: s.id, label: s.name })),
      value: scene.id,
      onChange: (id) => {
        loadScene(sceneById(id));
        session.invalidate();
      },
    }),
    aperture,
    bounces,
    spacer(),
    samplesStat,
    resolutionStat,
    hint(env.coarse ? 'Drag to orbit · pinch to zoom · tap to focus' : 'Drag to orbit · ctrl + scroll to zoom · click to focus'),
  );

  function report({ samples, w, h }) {
    samplesStat.set(`${samples} / ${sampleBudget}`);
    resolutionStat.set(`${w} × ${h}`);
    progressFill.style.transform = `scaleX(${Math.min(1, samples / sampleBudget)})`;
    progress.toggleAttribute('data-done', samples >= sampleBudget);
  }

  const session = createSession({ view: v, renderer, sampleBudget, animate, report, onError: () => overlay(v.wrap, UNAVAILABLE.float) });

  /** Aim through a world point and return the first surface on the way: where to focus. */
  function surfaceToward(point) {
    const eye = camera().eye;
    const hit = closestHit(packed, eye, normalize(sub(point, eye)));
    return hit ? hit.point : point;
  }

  function loadScene(next) {
    scene = next;
    packed = packScene(scene);
    renderer.setScene(scene);
    orbit.reset(scene.camera, scene.camera.limits);
    stop = F_STOPS.indexOf(scene.camera.fNumber);
    aperture.value = stop;
    focusLag = 0;
    focusPoint = surfaceToward(scene.camera.focus);
  }

  function zoomBy(factor) {
    orbit.zoom(factor);
    session.invalidate();
  }

  function focusAt(p) {
    const cam = camera();
    const ray = pinholeRay(cam, p.nx, p.ny);
    const hit = closestHit(packed, ray.o, ray.d);
    const before = cam.focus;
    focusPoint = hit ? hit.point : madd(ray.o, ray.d, FAR_FOCUS);
    const after = clamp(depthOf(cam, focusPoint), 0.2, FAR_FOCUS);
    focusLag = Math.log(before / after);
    reticleLabel.textContent = hit ? formatDistance(after) : 'Far';
    reticle.style.left = `${p.x}px`;
    reticle.style.top = `${p.y}px`;
    reticle.removeAttribute('data-show');
    void reticle.offsetWidth; // restart the CSS animation
    reticle.setAttribute('data-show', '');
    session.invalidate();
  }

  /* ── input ── */
  let drag = null;
  const offPointer = pointer(v.canvas, {
    down(p) {
      drag = { x: p.x, y: p.y, at: performance.now(), moved: false };
    },
    move(p) {
      if (!drag) return;
      if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) < TAP_SLOP_PX) return;
      drag.moved = true;
      const radiansPerPx = 2.4 / Math.min(p.w, p.h);
      orbit.rotate(-p.dx * radiansPerPx, p.dy * radiansPerPx);
      session.invalidate();
    },
    up(p) {
      // the kit also calls up() when a second finger lands to begin a pinch: that is not a tap
      const lifted = p.event.type === 'pointerup';
      if (drag && lifted && !drag.moved && performance.now() - drag.at < TAP_MS) focusAt(p);
      drag = null;
    },
    pinch({ factor }) {
      zoomBy(factor);
    },
  });

  v.canvas.tabIndex = 0;
  const onKey = (e) => {
    const turn = { ArrowLeft: [0.12, 0], ArrowRight: [-0.12, 0], ArrowUp: [0, 0.08], ArrowDown: [0, -0.08] }[e.key];
    if (turn) orbit.rotate(turn[0], turn[1]);
    else if (e.key === '+' || e.key === '=') orbit.zoom(1.25);
    else if (e.key === '-') orbit.zoom(0.8);
    else return;
    e.preventDefault();
    session.invalidate();
  };
  v.canvas.addEventListener('keydown', onKey);

  /* ── lifecycle ── */
  let notice = null;
  const offContext = onContextLoss(v.canvas, {
    lost() {
      session.suspend();
      notice = overlay(v.wrap, {
        title: 'The graphics context was lost',
        text: 'The browser took the GPU away. Rendering resumes as soon as it is given back.',
      });
    },
    restored() {
      if (notice) notice.remove();
      notice = null;
      renderer.rebuild();
      renderer.setScene(scene);
      session.resume();
    },
  });

  loadScene(scene);
  renderer.setOptions({ bounces: bounces.value });
  // Subscribe first: the kit calls a new subscriber at once, and that call must not discard the
  // image prime() is about to trace. Only a real resize during priming needs a redraw afterwards.
  let primed = false;
  let resizedMeanwhile = false;
  const offResize = v.onResize(() => {
    if (primed) session.resized();
    else resizedMeanwhile = true;
  });
  resizedMeanwhile = false;
  if (v.size.pw) await session.prime();
  primed = true;
  if (resizedMeanwhile) session.resized();

  return {
    start: () => session.start(),
    stop: () => session.stop(),
    destroy() {
      session.end();
      offResize();
      offPointer();
      offContext();
      v.canvas.removeEventListener('keydown', onKey);
      renderer.dispose();
      const lose = made.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      v.destroy();
    },
  };
}
