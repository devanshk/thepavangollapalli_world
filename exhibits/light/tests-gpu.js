// Browser-only tests: they compile the real shaders on an off-screen canvas and read the float
// accumulation buffer back. Where a GPU cannot read float pixels (common on phones) the numeric
// checks have nothing to compare and pass.
import { assert, near } from '../../assets/js/check.js';
import { createGL } from '../../assets/js/glkit.js';
import { rng } from '../../assets/js/kit.js';
import { makeCamera, pinholeRay } from './camera.js';
import { closestHit } from './mirror.js';
import { ggxG1, ggxG2, reflect, sampleGgxVndf } from './optics.js';
import { packScene } from './pack.js';
import { createRenderer, pickFormat } from './renderer.js';
import { SCENES } from './scenes.js';
import { environment } from './sky.js';

const NO_CLAMP = 1e30;
const rigs = new Map();
let idleTimer = 0;

/** One shared renderer per accumulation format, released a moment after the last test used it. */
function rig(format) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    for (const { gl } of rigs.values()) {
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
    rigs.clear();
  }, 1500);
  if (!rigs.has(format)) {
    const made = createGL(document.createElement('canvas'));
    assert(made, 'WebGL2 is available');
    const best = pickFormat(made.gl, made.caps);
    assert(best, 'a float render target is available');
    const use = format === 'best' ? best : format;
    rigs.set(format, { gl: made.gl, renderer: createRenderer(made.gl, use), supported: use === best || made.caps.float16 });
  }
  return rigs.get(format);
}

/**
 * Trace `samples` per pixel of a scene at size × size and return the mean radiance of the image
 * (or of the central `crop` fraction), or null where float read-back is unsupported.
 */
function measure(scene, view, { samples, size = 16, crop = 1, bounces = 1, strategy = 0, format = 'best' }) {
  const { renderer } = rig(format);
  renderer.setScene(scene);
  renderer.setCamera(makeCamera(view, { fovDeg: view.fov, aspect: 1, fNumber: 1e9, focus: view.distance }));
  renderer.setOptions({ bounces, strategy, clamp: NO_CLAMP });
  renderer.buffer('test', size, size);
  renderer.reset('test');
  while (renderer.samples('test') < samples) renderer.accumulate('test', 8);
  const data = renderer.read('test');
  if (!data) return null;
  const lo = Math.floor((size * (1 - crop)) / 2);
  const mean = [0, 0, 0];
  let count = 0;
  for (let y = lo; y < size - lo; y++) {
    for (let x = lo; x < size - lo; x++) {
      for (let k = 0; k < 3; k++) mean[k] += data[(y * size + x) * 4 + k];
      count++;
    }
  }
  return { mean: mean.map((v) => v / count), data };
}

const furnace = (material) => ({
  exposure: 1,
  env: { color: [1, 1, 1] },
  materials: { m: material },
  spheres: [{ c: [0, 0, 0], r: 1, mat: 'm' }],
});
const furnaceView = { target: [0, 0, 0], yaw: 0.3, pitch: 0.2, distance: 6, fov: 30 };

/** A grey floor seen through a long lens, lit by one light: every pixel has the same radiance. */
const ALBEDO = 0.5;
const floorView = { target: [0, 0, 0], yaw: 0.6, pitch: 0.5, distance: 12, fov: 0.6 };
const litFloor = (extra) => ({
  exposure: 1,
  env: { color: [0, 0, 0] },
  ...extra,
  materials: { floor: { type: 'diffuse', color: [ALBEDO, ALBEDO, ALBEDO] }, ...extra.materials },
  quads: [{ c: [0, 0, 0], u: [30, 0, 0], v: [0, 0, -30], mat: 'floor' }, ...(extra.quads || [])],
});

const STRATEGIES = [
  { name: 'multiple importance sampling', strategy: 0, tolerance: 0.02 },
  { name: 'BSDF sampling alone', strategy: 1, tolerance: 0.05 },
  { name: 'light sampling alone', strategy: 2, tolerance: 0.02 },
];

function expectRadiance(scene, expected, options = {}) {
  for (const { name, strategy, tolerance } of options.strategies || STRATEGIES) {
    const result = measure(scene, floorView, { samples: 256, strategy, ...options });
    if (!result) return;
    near(result.mean[1] / expected, 1, tolerance, name);
  }
}

export default [
  {
    name: 'the path tracer and display shaders compile',
    browser: true,
    fn() {
      assert(rig('best').renderer, 'programs linked');
    },
  },
  {
    name: 'every scene renders finite, visible light',
    browser: true,
    fn() {
      const { renderer } = rig('best');
      for (const scene of SCENES) {
        renderer.setScene(scene);
        const view = scene.camera;
        renderer.setCamera(makeCamera(view, { fovDeg: view.fov, aspect: 1.5, fNumber: view.fNumber, focus: view.distance }));
        renderer.setOptions({ bounces: 6, strategy: 0, clamp: null });
        renderer.buffer('scene', 36, 24);
        renderer.reset('scene');
        renderer.accumulate('scene', 8);
        renderer.accumulate('scene', 8);
        const data = renderer.read('scene');
        if (!data) return;
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          assert(Number.isFinite(data[i]) && data[i] >= 0, `${scene.id}: value ${data[i]} at ${i}`);
          sum += i % 4 === 3 ? 0 : data[i];
        }
        assert(sum / (36 * 24 * 3) > 0.01, `${scene.id} is not black`);
      }
    },
  },
  {
    name: 'the GPU and the JavaScript mirror agree on what each ray hits',
    browser: true,
    fn() {
      const { renderer } = rig('best');
      const [w, h] = [30, 20];
      for (const scene of SCENES) {
        // a slightly turned view, so that no ray runs exactly along an edge where two walls meet
        const view = { ...scene.camera, yaw: scene.camera.yaw + 0.07, pitch: scene.camera.pitch + 0.05 };
        const cam = makeCamera(view, { fovDeg: view.fov, aspect: w / h, fNumber: 8, focus: 1 });
        renderer.setScene(scene);
        renderer.setCamera(cam);
        const probe = renderer.probe(w, h);
        if (!probe) return;
        const data = packScene(scene);
        let agree = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const ray = pinholeRay(cam, (x + 0.5) / w, 1 - (y + 0.5) / h);
            const hit = closestHit(data, ray.o, ray.d);
            const [t, kind, index] = probe.subarray((y * w + x) * 4);
            if (hit ? kind === hit.kind && index === hit.index && Math.abs(t - hit.t) < 2e-3 * hit.t : t < 0) agree++;
          }
        }
        // rays grazing a silhouette may fall either way in 32-bit and 64-bit arithmetic
        assert(agree >= w * h - 6, `${scene.id}: ${agree} of ${w * h} rays agree`);
      }
    },
  },
  {
    name: 'white furnace: a matte sphere in uniform light returns exactly its albedo',
    browser: true,
    fn() {
      const albedo = [0.8, 0.5, 0.2];
      const result = measure(furnace({ type: 'diffuse', color: albedo }), furnaceView, { samples: 16, size: 24, crop: 0.25, bounces: 8 });
      if (!result) return;
      albedo.forEach((a, k) => near(result.mean[k], a, 2e-3));
      near(result.data[0], 1, 1e-4, 'the background is the furnace itself');
    },
  },
  {
    name: 'white furnace: clear glass neither creates nor loses light',
    browser: true,
    fn() {
      const result = measure(furnace({ type: 'glass', color: [1, 1, 1], ior: 1.5 }), furnaceView, { samples: 32, size: 24, crop: 0.5, bounces: 12 });
      if (!result) return;
      result.mean.forEach((v) => near(v, 1, 5e-3));
    },
  },
  {
    name: 'white furnace: rough metal on the GPU matches the JavaScript GGX model',
    browser: true,
    fn() {
      const roughness = 0.6;
      const result = measure(furnace({ type: 'metal', color: [1, 1, 1], roughness }), furnaceView, { samples: 256, size: 25, crop: 0.12, bounces: 8 });
      if (!result) return;
      // the centre of the sphere is seen head-on: estimate the same albedo with optics.js
      const alpha = roughness * roughness;
      const r = rng(2);
      let sum = 0;
      const count = 20000;
      for (let i = 0; i < count; i++) {
        const wi = reflect([0, 0, -1], sampleGgxVndf([0, 0, 1], alpha, r(), r()));
        if (wi[2] > 0) sum += ggxG2(1, wi[2], alpha) / ggxG1(1, alpha);
      }
      near(result.mean[1], sum / count, 0.03);
      assert(result.mean[1] < 1, 'single scattering loses a little energy, never gains');
    },
  },
  {
    name: 'white furnace: glossy white plastic reflects no more than it receives',
    browser: true,
    fn() {
      const result = measure(furnace({ type: 'plastic', color: [1, 1, 1], roughness: 0.3 }), furnaceView, { samples: 128, size: 24, crop: 0.4, bounces: 8 });
      if (!result) return;
      assert(result.mean[1] <= 1.005 && result.mean[1] > 0.85, `white plastic returned ${result.mean[1]}`);
    },
  },
  {
    name: 'a rectangular light matches its closed-form irradiance with every sampling strategy',
    browser: true,
    fn() {
      const [a, b, height, radiance] = [1.5, 1, 3, 10];
      const scene = litFloor({
        materials: { lamp: { type: 'emissive', color: [radiance, radiance, radiance] } },
        quads: [{ c: [0, height, 0], u: [a, 0, 0], v: [0, 0, b], mat: 'lamp', oneSided: true }],
      });
      // configuration factor of a rectangle seen from below its centre (four corner pieces)
      const ra = Math.hypot(a, height);
      const rb = Math.hypot(b, height);
      const factor = (2 / Math.PI) * ((a / ra) * Math.atan(b / ra) + (b / rb) * Math.atan(a / rb));
      expectRadiance(scene, ALBEDO * radiance * factor);
    },
  },
  {
    name: 'a spherical light matches its closed-form irradiance with every sampling strategy',
    browser: true,
    fn() {
      const [radius, height, radiance] = [1, 4, 10];
      const scene = litFloor({
        materials: { lamp: { type: 'emissive', color: [radiance, radiance, radiance] } },
        spheres: [{ c: [0, height, 0], r: radius, mat: 'lamp' }],
      });
      expectRadiance(scene, ALBEDO * radiance * (radius / height) ** 2);
    },
  },
  {
    name: 'sunlight on the ground matches its closed-form irradiance',
    browser: true,
    fn() {
      const env = { sun: { azimuth: 30, elevation: 35, radius: 2.2 }, intensity: 1, skyGain: 0 };
      const { sunRadiance, sunCone, sunDir } = environment(env);
      // a uniform disc of angular radius r, centred at elevation e: E = L π sin²r sin e
      const irradiance = sunRadiance[1] * Math.PI * (1 - sunCone[0] ** 2) * sunDir[1];
      expectRadiance(litFloor({ env }), (ALBEDO / Math.PI) * irradiance, { strategies: [STRATEGIES[0], STRATEGIES[2]] });
    },
  },
  {
    name: 'half-float accumulation stays unbiased over a thousand samples',
    browser: true,
    fn() {
      const [radius, height, radiance] = [1, 4, 10];
      const scene = litFloor({
        materials: { lamp: { type: 'emissive', color: [radiance, radiance, radiance] } },
        spheres: [{ c: [0, height, 0], r: radius, mat: 'lamp' }],
      });
      if (!rig('rgba16f').supported) return;
      const result = measure(scene, floorView, { samples: 1024, size: 12, strategy: 1, format: 'rgba16f' });
      if (!result) return;
      near(result.mean[1] / (ALBEDO * radiance * (radius / height) ** 2), 1, 0.04);
    },
  },
];
