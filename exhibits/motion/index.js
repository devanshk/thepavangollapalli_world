// Motion — a 2D rigid-body engine. This file is the thin DOM layer: controls, pointer input, the
// fixed-timestep loop and read-outs. The engine itself lives in the pure modules beside it.
import { view, bar, group, button, toggle, slider, select, stat, hint, spacer, overlay, loop, pointer, fpsMeter, rng, clamp } from '../../assets/js/kit.js';
import { DT, DYNAMIC } from './world.js';
import { MouseJoint } from './joints.js';
import { SCENES, GROUND, createScene, randomShape } from './scenes.js';
import { createRenderer } from './render.js';

const MAX_STEPS_PER_FRAME = 5; // below 24 frames a second the simulation slows down instead of stalling
const SLOW_MOTION = 0.2;
const MAX_DROPPED = 80;
const STATS_INTERVAL = 0.3;

const formatEnergy = (e) => (Math.abs(e) < 1000 ? `${e.toFixed(0)} J` : `${(e / 1000).toFixed(2)} kJ`);

export function mount(root, env) {
  const v = view(root, {
    aspect: 16 / 9,
    aspectNarrow: 0.9,
    label: 'Rigid bodies colliding, stacking and swinging under gravity. Drag a shape to throw it.',
  });
  const renderer = createRenderer(v.canvas, root);
  if (!renderer) {
    overlay(v.wrap, {
      title: 'Canvas drawing is not available',
      text: 'This exhibit draws with the 2D canvas, which this browser did not provide.',
    });
    return { start() {}, stop() {}, destroy: () => v.destroy() };
  }

  let scene = null;
  let sceneId = SCENES[0].id;
  let builtAspect = 0;
  let gravity = 9.8;
  let slow = false;
  let paused = !!env.reducedMotion;
  let acc = 0;
  let dirty = true;
  let tap = null;
  // once the visitor has interfered, the scene is theirs: it no longer restarts on its own
  let touched = false;
  let dropRng = rng(2024);
  let statsTimer = STATS_INTERVAL;
  const frame = { alpha: 0, debug: false, drag: null };
  const dropped = [];
  const fps = fpsMeter();

  const stats = {
    bodies: stat({ label: 'Bodies' }),
    contacts: stat({ label: 'Contacts' }),
    collide: stat({ label: 'Collide' }),
    solve: stat({ label: 'Solve' }),
    energy: stat({ label: 'Energy' }),
    fps: stat({ label: 'Frames/s' }),
  };

  function draw() {
    if (!scene || !v.size.pw) return;
    frame.alpha = acc / DT;
    renderer.draw(scene, v.size, frame);
    dirty = false;
  }

  function showStats() {
    const world = scene.world;
    let bodies = 0;
    let awake = 0;
    for (let i = 0; i < world.bodies.length; i++) {
      const b = world.bodies[i];
      if (b.type !== DYNAMIC) continue;
      bodies++;
      if (b.awake) awake++;
    }
    stats.bodies.set(`${bodies} · ${awake} awake`);
    stats.contacts.set(`${world.manifoldCount} · ${world.pointCount} points`);
    stats.energy.set(formatEnergy(world.energy()));
    if (world.timedSteps > 0) {
      // wall-clock time per step, averaged over the steps since the last read-out
      stats.collide.set(`${(world.collideMs / world.timedSteps).toFixed(2)} ms`);
      stats.solve.set(`${(world.solveMs / world.timedSteps).toFixed(2)} ms`);
      world.collideMs = 0;
      world.solveMs = 0;
      world.timedSteps = 0;
    }
  }

  function releaseDrag() {
    if (!frame.drag) return;
    scene.world.removeJoint(frame.drag);
    frame.drag = null;
    v.canvas.style.cursor = '';
  }

  function load() {
    const { w, h } = v.size;
    if (!w || !h) return;
    releaseDrag();
    scene = createScene(sceneId, w / h, gravity);
    builtAspect = w / h;
    acc = 0;
    tap = null;
    touched = false;
    dropped.length = 0;
    dropRng = rng(2024);
    showStats();
    draw();
  }

  function explode() {
    if (!scene) return;
    scene.world.explode(scene.W / 2, scene.top * 0.25, 16, scene.W * 0.3);
    touched = true;
    dirty = true;
  }

  function dropShape(x, y) {
    const world = scene.world;
    const b = randomShape(world, dropRng, clamp(x, 0.7, scene.W - 0.7), clamp(y, 0.7, scene.top - 0.7), dropRng.range(0.3, 0.5));
    dropped.push(b);
    if (dropped.length > MAX_DROPPED) world.removeBody(dropped.shift());
    dirty = true;
  }

  const pauseButton = button({
    label: paused ? 'Play' : 'Pause',
    onClick: () => {
      paused = !paused;
      touched = true;
      pauseButton.setLabel(paused ? 'Play' : 'Pause');
    },
  });
  bar(
    root,
    select({
      label: 'Scene',
      options: SCENES.map((s) => ({ value: s.id, label: s.label })),
      value: sceneId,
      onChange: (id) => {
        sceneId = id;
        load();
      },
    }),
    group(button({ label: 'Reset', onClick: load }), button({ label: 'Explode', onClick: explode }), pauseButton),
    slider({
      label: 'Gravity',
      min: 0,
      max: 20,
      step: 0.2,
      value: gravity,
      format: (g) => `${g.toFixed(1)} m/s²`,
      onInput: (g) => {
        gravity = g;
        touched = true;
        if (scene) scene.world.setGravity(g);
      },
    }),
    toggle({
      label: 'Slow motion',
      value: slow,
      onChange: (on) => {
        slow = on;
        touched = true;
      },
    }),
    toggle({
      label: 'Show internals',
      value: frame.debug,
      onChange: (on) => {
        frame.debug = on;
        touched = true;
        dirty = true;
      },
    }),
    spacer(),
    hint(`Drag a shape to throw it. ${env.coarse ? 'Tap' : 'Click'} empty space to drop one.`),
  );
  bar(root, stats.bodies, stats.contacts, stats.collide, stats.solve, stats.energy, spacer(), stats.fps);

  const toWorld = (p) => [(p.x / p.w) * scene.W, (1 - p.y / p.h) * scene.H - GROUND];
  const pickAt = (p) => {
    const [x, y] = toWorld(p);
    // a finger is less precise than a cursor, so touch grabs reach a little further
    return scene.world.pick(x, y, ((env.coarse ? 14 : 4) * scene.W) / p.w);
  };
  const offPointer = pointer(v.canvas, {
    down(p) {
      if (!scene) return;
      const body = pickAt(p);
      touched = true;
      dirty = true;
      if (body) {
        const [x, y] = toWorld(p);
        frame.drag = scene.world.addJoint(new MouseJoint(scene.world.fixed, body, x, y));
        v.canvas.style.cursor = 'grabbing';
      } else tap = { x: p.x, y: p.y };
    },
    move(p) {
      if (frame.drag) {
        const [x, y] = toWorld(p);
        frame.drag.setTarget(clamp(x, 0, scene.W), clamp(y, 0, scene.top));
        dirty = true;
      } else if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > 10) tap = null;
    },
    up(p) {
      if (frame.drag) releaseDrag();
      else if (tap && scene) dropShape(...toWorld(p));
      tap = null;
      dirty = true;
    },
    hover(p) {
      if (scene) v.canvas.style.cursor = pickAt(p) ? 'grab' : 'crosshair';
    },
  });

  const anim = loop((dt) => {
    if (!scene) return;
    const world = scene.world;
    // when every body is asleep and nothing is pending, neither simulate nor redraw
    if (!paused && (world.moving || scene.busy || frame.drag)) {
      acc += dt * (slow ? SLOW_MOTION : 1);
      let steps = 0;
      while (acc >= DT && steps < MAX_STEPS_PER_FRAME) {
        scene.advance();
        acc -= DT;
        steps++;
      }
      if (acc >= DT) acc = 0;
      dirty = true;
      if (scene.replay > 0 && !touched && world.stepCount * DT > scene.replay) load();
    }
    if (dirty) draw();
    stats.fps.set(Math.round(fps.tick(dt)));
    statsTimer -= dt;
    if (statsTimer <= 0) {
      statsTimer = STATS_INTERVAL;
      showStats();
    }
  });

  const offResize = v.onResize(({ w, h }) => {
    if (!scene || Math.abs(w / h - builtAspect) > 0.02 * builtAspect) load();
    else draw();
  });

  return {
    start: () => anim.start(),
    stop: () => anim.stop(),
    destroy() {
      anim.stop();
      offPointer();
      offResize();
      v.destroy();
    },
  };
}
