// WORLD: a procedural planet from a seed. This file is the thin DOM layer: it wires the
// controls, the pointer and the frame loop to the pure modules beside it.
import { view, bar, group, button, toggle, slider, stat, hint, spacer, pointer, loop, overlay, el, loadCSS, uid } from '../../assets/js/kit.js';
import { onContextLoss } from '../../assets/js/glkit.js';
import { createRenderer, TAN_FOV } from './renderer.js';
import { paramsFromSeed } from './params.js';
import { createTerrain, solveSeaLevel, createSurvey } from './terrain.js';
import { randomSeedWord } from './names.js';
import { createCard } from './card.js';
import { createQuality } from './quality.js';
import { createOrbit } from './orbit.js';
import { sunDirection, fitRadius } from './camera.js';

const DEFAULT_SEED = 'fable';
const DEFAULT_SUN = -48;
const CLOUD_DRIFT = 0.011; // rad/s the cloud layer turns relative to the ground
const CLOUD_EVOLVE = 0.0045; // how fast cloud shapes change
const SURVEY_POINTS = 12000;
const SETTLE_BUDGET_MS = 1200; // the most a full-quality still frame may cost
const KEY_TURN = 0.12;

export async function mount(root, env) {
  await loadCSS(new URL('./style.css', import.meta.url));

  const viewCol = el('div', { class: 'world-viewcol' });
  const card = createCard();
  root.append(el('div', { class: 'world-layout' }, viewCol, card.node));
  const v = view(viewCol, {
    aspect: 16 / 10,
    aspectNarrow: 1,
    label: 'A procedurally generated planet seen from orbit. Drag to turn it, or focus it and use the arrow keys.',
  });
  v.canvas.classList.add('world-canvas');
  v.canvas.tabIndex = 0;

  let renderer = null;
  let failure = null;
  try {
    renderer = createRenderer(v.canvas);
  } catch (err) {
    failure = err;
  }
  if (!renderer) {
    overlay(v.wrap, failure
      ? { title: 'The planet shader did not compile', text: 'This graphics driver rejected the shader, so the planet cannot be drawn here. The data card is still measured from the same terrain in JavaScript.' }
      : { title: 'WebGL2 is not available', text: 'The planet is drawn by a WebGL2 fragment shader, which this browser or device does not offer. The data card is still measured from the same terrain in JavaScript.' });
  }

  const orbit = createOrbit(TAN_FOV);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const quality = createQuality({ min: Math.max(0.35, 0.6 / dpr) });
  const sun = [0, 0, 1];
  const frame = { rot: orbit.rot, sun, camDist: 1, shift: orbit.shift, cssMin: 1, clouds: true, atmosphere: true, cloudAngle: 0, cloudMorph: 0, lodBias: 0 };
  let params = null;
  let terrain = null;
  let sea = 0;
  let sunAngle = DEFAULT_SUN;
  let spinning = !env.reducedMotion;
  let contextLost = false;
  let lostNotice = null;
  let frameSerial = 0;
  let dirty = false;
  let settled = false;
  let drewLastTick = false;
  let lastTick = 0;
  let halted = false;
  let destroyed = false;

  /* ── drawing ── */

  function drawFrame() {
    if (!renderer || contextLost || !params) return;
    const { w, h } = v.size;
    if (!w) return;
    frame.camDist = orbit.camDist;
    frame.cssMin = Math.min(w, h);
    sunDirection(sun, sunAngle);
    renderer.draw(frame);
    frameSerial++;
    dirty = false;
  }

  // A control changed. While the loop runs it picks the change up; otherwise redraw now.
  function invalidate() {
    dirty = true;
    if (!anim.running) drawFrame();
  }

  // Resolution for a still frame: as sharp as the measured frame cost allows.
  function settleScale() {
    if (!(quality.interval > 20)) return 1;
    const costAtFull = quality.interval / (quality.scale * quality.scale);
    return Math.min(1, Math.max(quality.scale, Math.sqrt(SETTLE_BUDGET_MS / costAtFull)));
  }

  const fpsStat = stat({ label: 'fps' });
  const sizeStat = stat({ label: 'Pixels' });

  const anim = loop((dt) => {
    const now = performance.now();
    const interval = now - lastTick;
    lastTick = now;
    const motion = orbit.update(dt, spinning);
    if (spinning) {
      frame.cloudAngle += CLOUD_DRIFT * dt;
      frame.cloudMorph += CLOUD_EVOLVE * dt;
    }
    // drop an octave of detail while the visitor is moving the view, and ease it back
    const bias = frame.lodBias + ((motion === 2 ? 1 : 0) - frame.lodBias) * Math.min(dt * 6, 1);
    frame.lodBias = Math.abs(bias - (motion === 2 ? 1 : 0)) < 0.01 ? (motion === 2 ? 1 : 0) : bias;
    const active = motion !== 0 || frame.lodBias > 0;
    const before = frameSerial;
    if (active) {
      if (settled) {
        settled = false;
        quality.rest();
        v.setScale(quality.scale);
      } else if (drewLastTick && quality.sample(interval, now)) v.setScale(quality.scale);
      if (frameSerial === before) drawFrame();
      drewLastTick = true;
      fpsStat.set(quality.fps ? Math.round(quality.fps) : '—');
    } else {
      // nothing is moving: draw one sharp still, then leave the GPU alone
      if (!settled) {
        settled = true;
        dirty = true;
        v.setScale(settleScale());
      }
      if (dirty && frameSerial === before) drawFrame();
      drewLastTick = false;
      fpsStat.set('idle');
    }
  });

  /* ── planet ── */

  let survey = null;
  let surveyTimer = 0;
  let surveyMs = 0;

  // Run one slice of the measurement; true once the card has its numbers.
  function surveySlice() {
    const t0 = performance.now();
    const done = survey.step(5);
    surveyMs += performance.now() - t0;
    if (done) {
      card.setSurvey(survey.result(), surveyMs);
      survey = null;
    }
    return done;
  }

  function pumpSurvey() {
    surveyTimer = 0;
    if (survey && !destroyed && !surveySlice()) scheduleSurvey();
  }

  function scheduleSurvey() {
    if (survey && !surveyTimer && !halted && !destroyed) surveyTimer = setTimeout(pumpSurvey, 0);
  }

  function setSeed(text) {
    params = paramsFromSeed(text);
    terrain = createTerrain(params);
    sea = solveSeaLevel(terrain, params.oceanTarget);
    if (renderer) renderer.setPlanet(params, sea);
    orbit.reset(params.tiltDeg, params.longitude);
    refit();
    frame.cloudAngle = 0;
    frame.cloudMorph = 0;
    card.setPlanet(params);
    survey = createSurvey(terrain, sea, SURVEY_POINTS);
    surveyMs = 0;
  }

  function refit() {
    const { w, h } = v.size;
    if (w && params) orbit.setFit(fitRadius(w / h, params.ring && params.ring.outer));
  }

  /* ── controls ── */

  const seedId = uid('world-seed');
  const seedInput = el('input', {
    class: 'world-seed-input',
    id: seedId,
    type: 'text',
    value: DEFAULT_SEED,
    maxLength: 24,
    autocomplete: 'off',
    autocapitalize: 'off',
    enterkeyhint: 'go',
  });
  seedInput.setAttribute('spellcheck', 'false');
  const applySeed = () => {
    setSeed(seedInput.value);
    invalidate();
    scheduleSurvey();
  };
  seedInput.addEventListener('input', applySeed);
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') seedInput.blur();
  });

  const sunSlider = slider({
    label: 'Sun',
    min: -180,
    max: 180,
    step: 1,
    value: sunAngle,
    format: (x) => `${x > 0 ? '+' : ''}${x}°`,
    onInput: (x) => {
      sunAngle = x;
      invalidate();
    },
  });
  const zoomSlider = slider({
    label: 'Zoom',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0,
    format: (x) => `${Math.round(x * 100)} %`,
    onInput: (x) => {
      orbit.zoomTarget = x;
      invalidate();
    },
  });
  const renderControls = [
    sunSlider.input,
    zoomSlider.input,
    toggle({ label: 'Clouds', value: true, onChange: (on) => { frame.clouds = on; invalidate(); } }),
    toggle({ label: 'Atmosphere', value: true, onChange: (on) => { frame.atmosphere = on; invalidate(); } }),
    toggle({ label: 'Spin', value: spinning, onChange: (on) => { spinning = on; invalidate(); } }),
  ];
  if (!renderer) for (const control of renderControls) control.disabled = true;

  bar(
    root,
    group(
      el('label', { class: 'world-seed' }, el('span', { class: 'kit-label' }, 'Seed'), seedInput),
      button({
        label: 'New planet',
        kind: 'primary',
        onClick: () => {
          seedInput.value = randomSeedWord();
          applySeed();
        },
      }),
    ),
    group(renderControls[2], renderControls[3], renderControls[4]),
  );
  bar(
    root,
    sunSlider,
    zoomSlider,
    spacer(),
    hint(env.coarse ? 'Drag to turn · pinch to zoom' : 'Drag to turn · ctrl + scroll to zoom'),
    fpsStat,
    sizeStat,
  );

  /* ── pointer and keyboard ── */

  // pointer position → screen coordinates in half-canvas units, v up
  const toU = (p) => (2 * p.x - p.w) / Math.min(p.w, p.h);
  const toV = (p) => (p.h - 2 * p.y) / Math.min(p.w, p.h);
  const offPointer = pointer(v.canvas, {
    down(p) {
      orbit.grab(toU(p), toV(p), p.event.timeStamp);
      v.canvas.classList.add('world-canvas--held');
    },
    move(p) {
      if (!orbit.grabbed) return;
      orbit.drag(toU(p), toV(p), p.event.timeStamp);
      invalidate();
    },
    up(p) {
      orbit.release(p.event.timeStamp);
      v.canvas.classList.remove('world-canvas--held');
    },
    pinch({ factor }) {
      orbit.halt();
      orbit.zoomBy(factor);
      zoomSlider.value = orbit.zoomTarget;
      invalidate();
    },
  });

  const onKey = (e) => {
    const turns = { ArrowLeft: [0, 1, 0, -KEY_TURN], ArrowRight: [0, 1, 0, KEY_TURN], ArrowUp: [1, 0, 0, -KEY_TURN], ArrowDown: [1, 0, 0, KEY_TURN] };
    const turn = turns[e.key];
    if (!turn) return;
    e.preventDefault();
    orbit.turn(turn[0], turn[1], turn[2], turn[3]);
    invalidate();
  };
  v.canvas.addEventListener('keydown', onKey);

  const offContext = onContextLoss(v.canvas, {
    lost() {
      contextLost = true;
      if (!lostNotice) lostNotice = overlay(v.wrap, { title: 'Graphics paused', text: 'The browser took back the graphics context. The planet returns as soon as it is restored.' });
    },
    restored() {
      try {
        renderer.rebuild();
        contextLost = false;
        if (lostNotice) lostNotice.remove();
        lostNotice = null;
        drawFrame();
      } catch (err) {
        if (lostNotice) lostNotice.remove();
        lostNotice = overlay(v.wrap, { title: 'The planet could not be restored', text: 'The graphics context came back but the shader would not compile again. Reloading the page will fix it.' });
      }
    },
  });

  /* ── first frame ── */

  // Resizing clears the canvas, so every size change redraws at once.
  v.onResize(({ pw, ph }) => {
    refit();
    drawFrame();
    sizeStat.set(`${pw} × ${ph}`);
  });
  setSeed(DEFAULT_SEED);
  drawFrame();
  fpsStat.set('idle');
  // finish the first measurement before reporting ready, in slices that keep the page responsive
  while (survey && !destroyed && !surveySlice()) await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    start() {
      halted = false;
      scheduleSurvey();
      if (anim.running) return;
      lastTick = performance.now();
      quality.rest();
      drewLastTick = false;
      anim.start();
    },
    stop() {
      halted = true;
      clearTimeout(surveyTimer);
      surveyTimer = 0;
      anim.stop();
    },
    destroy() {
      destroyed = true;
      clearTimeout(surveyTimer);
      anim.stop();
      offPointer();
      offContext();
      v.canvas.removeEventListener('keydown', onKey);
      v.destroy();
      if (renderer) renderer.dispose();
    },
  };
}
