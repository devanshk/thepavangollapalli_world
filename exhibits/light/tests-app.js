// Tests of everything around the ray maths: scene packing, the three scenes, the sky model, and the
// controllers for quality, camera easing and the frame schedule. They run in Node and in the browser.
import { assert, equal, near, throws } from '../../assets/js/check.js';
import { depthOf, makeCamera } from './camera.js';
import { KIND_SPHERE, closestHit } from './mirror.js';
import { createOrbit } from './orbit.js';
import { LIGHT_QUAD, LIGHT_SPHERE, packScene, unpackScene } from './pack.js';
import { createQuality } from './quality.js';
import { SCENES } from './scenes.js';
import { createSession } from './session.js';
import { environment } from './sky.js';
import { length, normalize, sub } from './vec.js';

const close = (a, b, eps, what) => a.forEach((x, k) => near(x, b[k], eps, what));

const sceneTests = [
  {
    name: 'every scene survives packing and unpacking',
    fn() {
      for (const scene of SCENES) {
        const names = Object.keys(scene.materials);
        const back = unpackScene(packScene(scene));
        equal(back.spheres.length, (scene.spheres || []).length);
        equal(back.boxes.length, (scene.boxes || []).length);
        equal(back.quads.length, scene.quads.length);
        (scene.spheres || []).forEach((s, i) => {
          close(back.spheres[i].c, s.c, 1e-5, 'sphere centre');
          near(back.spheres[i].r, s.r, 1e-6);
          equal(names[back.spheres[i].mat], s.mat);
        });
        (scene.boxes || []).forEach((b, i) => {
          close(back.boxes[i].c, b.c, 1e-5, 'box centre');
          close(back.boxes[i].h, b.h, 1e-5, 'box size');
          near(back.boxes[i].rotY, b.rotY || 0, 1e-6);
          equal(names[back.boxes[i].mat], b.mat);
        });
        scene.quads.forEach((q, i) => {
          close(back.quads[i].c, q.c, 1e-4, 'quad centre');
          close(back.quads[i].u, q.u, 1e-3, 'quad edge');
          close(back.quads[i].v, q.v, 1e-3, 'quad edge');
          equal(back.quads[i].oneSided, !!q.oneSided);
          equal(names[back.quads[i].mat], q.mat);
        });
        names.forEach((name, i) => {
          const m = scene.materials[name];
          equal(back.materials[i].type, m.type);
          close(back.materials[i].color, m.color, 1e-5, 'colour');
          near(back.materials[i].roughness, m.roughness || 0, 1e-6);
          close(back.materials[i].tiles, m.tiles || [0, 1], 1e-6, 'tiles');
        });
      }
    },
  },
  {
    name: 'emissive quads and spheres are registered as lights',
    fn() {
      const back = unpackScene(
        packScene({
          materials: { glow: { type: 'emissive', color: [5, 5, 5] }, wall: { type: 'diffuse', color: [1, 1, 1] } },
          spheres: [{ c: [0, 0, 0], r: 1, mat: 'wall' }, { c: [3, 0, 0], r: 1, mat: 'glow' }],
          quads: [{ c: [0, 5, 0], u: [1, 0, 0], v: [0, 0, 1], mat: 'glow' }],
        }),
      );
      equal(back.lights, [{ kind: LIGHT_QUAD, index: 0 }, { kind: LIGHT_SPHERE, index: 1 }]);
    },
  },
  {
    name: 'malformed scenes are rejected with a reason',
    fn() {
      const materials = { a: { type: 'diffuse', color: [1, 1, 1] }, glow: { type: 'emissive', color: [1, 1, 1] } };
      throws(() => packScene({ materials, spheres: [{ c: [0, 0, 0], r: 1, mat: 'nope' }] }), /Unknown material/);
      throws(() => packScene({ materials, quads: [{ c: [0, 0, 0], u: [1, 0, 0], v: [1, 1, 0], mat: 'a' }] }), /perpendicular/);
      throws(() => packScene({ materials, boxes: [{ c: [0, 0, 0], h: [1, 1, 1], mat: 'glow' }] }), /light/);
      const many = Array.from({ length: 65 }, (_, i) => ({ c: [i * 3, 0, 0], r: 1, mat: 'a' }));
      throws(() => packScene({ materials, spheres: many }), /Too many spheres/);
    },
  },
  {
    name: 'each scene opens with an object in focus at the centre of attention',
    fn() {
      for (const scene of SCENES) {
        const data = packScene(scene);
        const cam = makeCamera(scene.camera, { fovDeg: scene.camera.fov, aspect: 1, fNumber: scene.camera.fNumber, focus: 1 });
        const hit = closestHit(data, cam.eye, normalize(sub(scene.camera.focus, cam.eye)));
        assert(hit && hit.kind === KIND_SPHERE, `${scene.id}: the focus target is a sphere`);
        const depth = depthOf(cam, hit.point);
        assert(depth > 1 && depth < scene.camera.distance * 1.5, `${scene.id}: focus depth ${depth}`);
      }
    },
  },
  {
    name: 'spheres rest on the ground and never overlap',
    fn() {
      for (const scene of SCENES) {
        const spheres = scene.spheres || [];
        spheres.forEach((a, i) => {
          near(a.c[1], a.r, 1e-9, `${scene.id}: sphere ${i} touches the floor`);
          for (let j = 0; j < i; j++) {
            const gap = length(sub(a.c, spheres[j].c)) - a.r - spheres[j].r;
            assert(gap > 0, `${scene.id}: spheres ${i} and ${j} overlap`);
          }
        });
      }
    },
  },
  {
    name: 'a low sun is dimmer and redder than a high one, and carries its stated power',
    fn() {
      const sky = (elevation) => environment({ sun: { azimuth: 0, elevation, radius: 2 }, intensity: 1, skyGain: 1 });
      const low = sky(5);
      const high = sky(60);
      assert(low.sunRadiance[1] < high.sunRadiance[1], 'dimmer');
      assert(low.sunRadiance[0] / low.sunRadiance[2] > 2 * (high.sunRadiance[0] / high.sunRadiance[2]), 'redder');
      near(length(high.sunDir), 1, 1e-12);
      near(high.sunDir[1], Math.sin(Math.PI / 3), 1e-12);
      // radiance × solid angle is the irradiance left after the atmosphere: below the intensity above it
      const solidAngle = 2 * Math.PI * high.sunCone[1];
      near(solidAngle, Math.PI * Math.sin((2 * Math.PI) / 180) ** 2, 1e-5);
      high.sunRadiance.forEach((radiance) => assert(radiance * solidAngle < 1 && radiance * solidAngle > 0.6));
    },
  },
];

const controlTests = [
  {
    name: 'slow frames shrink the render budget and fast frames grow it back',
    fn() {
      const q = createQuality();
      q.calibrate(13 / 4e5);
      near(q.budget, 4e5, 1);
      for (let i = 0; i < 6; i++) q.feedback(50, q.budget);
      const reduced = q.budget;
      assert(reduced < 2e5, `budget fell to ${reduced}`);
      for (let i = 0; i < 300; i++) q.feedback(16.7, q.budget);
      assert(q.budget > reduced * 1.5, 'budget recovered');
      const before = q.budget;
      q.feedback(16.7, before * 0.1);
      equal(q.budget, before, 'an idle frame says nothing about capacity');
    },
  },
  {
    name: 'the planned resolution fits the budget and never exceeds the canvas',
    fn() {
      const q = createQuality({ maxPixels: 1.4e6 });
      for (const cost of [1e-3, 1e-4, 2e-5, 2e-6, 1e-7]) {
        q.calibrate(cost);
        for (const [w, h] of [[716, 716], [1120, 630], [2240, 1260]]) {
          const { still, moving } = q.plan(w, h);
          assert(still.w <= w && still.h <= h, 'still fits the canvas');
          assert(still.w * still.h <= 1.4e6 * 1.01, 'still respects the pixel limit');
          assert(moving.w <= still.w && moving.spf >= 1, 'moving is never sharper than still');
          near(still.w / still.h, w / h, 0.02, 'aspect ratio is kept');
          const spf = q.spf(still.w, still.h);
          assert(spf >= 1 && spf <= 4, 'samples per frame stay in range');
        }
      }
      q.calibrate(1e-7);
      equal(q.plan(716, 716).still.w, 716, 'a fast GPU renders at full resolution');
      q.calibrate(1e-3);
      const slow = q.plan(1000, 1000);
      near(slow.still.w * slow.still.h, 1.2e5, 2e3, 'a slow GPU drops to the smallest useful picture');
      assert(slow.moving.w < slow.still.w, 'and coarser still while moving');
      equal(q.plan(300, 300).still.w, 300, 'a canvas smaller than that floor is rendered whole');
    },
  },
  {
    name: 'the orbit eases to its goal and stays within its limits',
    fn() {
      const limits = { pitch: [0, 1], distance: [5, 20] };
      const orbit = createOrbit({ yaw: 0, pitch: 0.2, distance: 10 }, limits, 0.09);
      orbit.rotate(1, 5);
      orbit.zoom(100);
      assert(orbit.step(1 / 60), 'moving after input');
      assert(orbit.pose.yaw > 0 && orbit.pose.yaw < 1, 'part of the way there after one frame');
      let frames = 0;
      while (orbit.step(1 / 60) && frames < 600) frames++;
      assert(frames < 200, 'settles');
      near(orbit.pose.yaw, 1, 1e-12);
      near(orbit.pose.pitch, 1, 1e-12, 'pitch clamps to its limit');
      near(orbit.pose.distance, 5, 1e-12, 'distance clamps to its limit');
      equal(orbit.step(1 / 60), false, 'at rest once settled');
      const instant = createOrbit({ yaw: 0, pitch: 0.2, distance: 10 }, limits, 0);
      instant.rotate(0.5, 0);
      instant.step(1 / 60);
      near(instant.pose.yaw, 0.5, 1e-12, 'no easing when smoothing is off');
    },
  },
];


/** A session wired to a counting stand-in for the renderer and a clock the test advances by hand. */
function sessionRig(sampleBudget) {
  const buffers = {};
  const traces = [];
  let time = 1000;
  let pending = null;
  let moving = false;
  let queued = 0;
  const renderer = {
    buffer(name, w, h) {
      if (buffers[name] && buffers[name].w === w && buffers[name].h === h) return false;
      buffers[name] = { w, h, samples: 0 };
      return true;
    },
    reset(name) {
      buffers[name].samples = 0;
    },
    samples: (name) => buffers[name].samples,
    accumulate(name, spf) {
      buffers[name].samples += spf;
      queued += buffers[name].w * buffers[name].h * spf;
      traces.push({ name, spf, w: buffers[name].w, total: buffers[name].samples });
      return buffers[name].samples;
    },
    present() {},
    // the stand-in GPU is a slow one: 40 ns per pixel-sample, so full resolution does not fit a frame
    fence() {
      time += queued * 4e-5;
      queued = 0;
      return { done: () => true };
    },
    contextLost: () => false,
  };
  const clock = {
    now: () => time,
    request(fn) {
      pending = fn;
      return 1;
    },
    cancel() {
      pending = null;
    },
    pause: () => Promise.resolve(),
  };
  const session = createSession({
    view: { size: { pw: 1200, ph: 600 } },
    renderer,
    sampleBudget,
    animate: () => moving,
    report() {},
    clock,
  });
  return {
    session,
    traces,
    buffers,
    setMoving(on) {
      moving = on;
    },
    /** Run one animation frame if one is scheduled. Returns whether it ran. */
    frame(ms = 16.7) {
      time += ms;
      const fn = pending;
      pending = null;
      if (fn) fn(time);
      return !!fn;
    },
    get scheduled() {
      return pending !== null;
    },
  };
}

const sessionTests = [
  {
    name: 'a still image is traced before the exhibit is started',
    async fn() {
      const rig = sessionRig(100);
      await rig.session.prime();
      const samples = rig.buffers.still.samples;
      assert(samples >= 8 && samples <= 32, `${samples} samples at rest`);
      equal(rig.scheduled, false, 'nothing runs until start()');
    },
  },
  {
    name: 'rendering stops at the sample budget and leaves the GPU idle',
    async fn() {
      const rig = sessionRig(60);
      await rig.session.prime();
      rig.session.start();
      let frames = 0;
      while (rig.frame() && frames < 500) frames++;
      equal(rig.buffers.still.samples, 60, 'exactly the budget');
      equal(rig.scheduled, false, 'no further frames are requested');
      const traced = rig.traces.length;
      rig.frame();
      equal(rig.traces.length, traced, 'and nothing more is traced');
    },
  },
  {
    name: 'a change redraws coarsely while moving, then restarts the full image',
    async fn() {
      const rig = sessionRig(40);
      await rig.session.prime();
      rig.session.start();
      while (rig.frame());
      rig.setMoving(true);
      rig.session.invalidate();
      assert(rig.scheduled, 'a change wakes the loop');
      for (let i = 0; i < 5; i++) rig.frame();
      const during = rig.traces[rig.traces.length - 1];
      equal(during.name, 'moving');
      assert(during.w < rig.buffers.still.w, 'coarser than the still image');
      assert(during.total <= 2, 'every moving frame starts afresh');
      rig.setMoving(false);
      for (let i = 0; i < 12; i++) rig.frame();
      const after = rig.traces[rig.traces.length - 1];
      equal(after.name, 'still');
      assert(after.total < 40, 'the still image restarted from zero');
      while (rig.frame());
      equal(rig.buffers.still.samples, 40, 'and converges again');
    },
  },
  {
    name: 'stop halts all work until start is called again',
    async fn() {
      const rig = sessionRig(1000);
      await rig.session.prime();
      rig.session.start();
      rig.frame();
      rig.session.stop();
      equal(rig.scheduled, false);
      const traced = rig.traces.length;
      rig.session.invalidate();
      equal(rig.frame(), false, 'changes while stopped schedule nothing');
      equal(rig.traces.length, traced);
      rig.session.start();
      rig.session.start();
      assert(rig.frame(), 'start resumes');
      assert(rig.traces.length > traced);
    },
  },
];

export default [...sceneTests, ...controlTests, ...sessionTests];
