import { assert, equal, near } from '../../assets/js/check.js';
import { rng } from '../../assets/js/kit.js';
import { noise3, fbm3, layerSeed } from './noise.js';
import { createTerrain, solveSeaLevel, createSurvey, spherePoint } from './terrain.js';
import { paramsFromSeed, FAMILIES, LIMITS } from './params.js';
import { planetName } from './names.js';
import { chapman, opticalDepthNumeric } from './atmosphere.js';
import { quatToMat3, raySphere, viewRay, pickSphere, discRadius, distanceForRadius } from './rotation.js';
import { sunDirection, initialOrientation, zoomDistance } from './camera.js';
import { createOrbit } from './orbit.js';
import { createQuality } from './quality.js';
import { skyColors } from './card.js';
import { createRenderer, TAN_FOV } from './renderer.js';
import { DEBUG, DEBUG_SCALE } from './shader.js';

const inRange = (x, [lo, hi]) => x >= lo - 1e-9 && x <= hi + 1e-9;

/* ── helpers for the browser tests ── */

const SIZE = 72;
let shared = null;

// One small off-screen renderer shared by the browser tests; null where WebGL2 is missing,
// in which case those tests have nothing to check.
function gpu() {
  if (shared) return shared.renderer;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  shared = { canvas, renderer: createRenderer(canvas) };
  return shared.renderer;
}

function planetFor(seed) {
  const params = paramsFromSeed(seed);
  const terrain = createTerrain(params);
  return { params, terrain, sea: solveSeaLevel(terrain, params.oceanTarget) };
}

function frameFor(planet, extra = {}) {
  const q = initialOrientation([0, 0, 0, 1], planet.params.tiltDeg, planet.params.longitude);
  return {
    rot: quatToMat3(new Float32Array(9), q),
    sun: sunDirection([0, 0, 0], -48),
    camDist: zoomDistance(0, 0.66, TAN_FOV),
    cssMin: SIZE,
    ...extra,
  };
}

function render(renderer, planet, extra) {
  renderer.setPlanet(planet.params, planet.sea);
  renderer.draw(frameFor(planet, extra));
  return renderer.readPixels().data;
}

// The planet-space point the centre of pixel (i, j) looks at, or null off the disc.
function pixelPoint(i, j, frame) {
  const ray = viewRay([0, 0, 0], ((i + 0.5) / SIZE) * 2 - 1, ((j + 0.5) / SIZE) * 2 - 1, TAN_FOV);
  const t = raySphere(0, 0, frame.camDist, ray[0], ray[1], ray[2], 1);
  if (t < 0) return null;
  const v = [ray[0] * t, ray[1] * t, frame.camDist + ray[2] * t];
  const m = frame.rot;
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

const unpack16 = (data, k) => (data[k] * 256 + data[k + 1]) / 65535 - 0.5;

export default [
  {
    name: 'the same seed always gives the same planet',
    fn() {
      const a = paramsFromSeed('fable');
      const b = paramsFromSeed('fable');
      equal(JSON.stringify(a), JSON.stringify(b));
      equal(a.palette, b.palette);
      assert(JSON.stringify(paramsFromSeed('fablf')) !== JSON.stringify(a), 'a different seed gives a different planet');
    },
  },
  {
    name: '500 seeds all land inside the curated ranges',
    fn() {
      const seen = new Set();
      for (let i = 0; i < 500; i++) {
        const p = paramsFromSeed(`seed ${i}`);
        const f = FAMILIES.find((x) => x.id === p.family);
        assert(f, `known family for seed ${i}`);
        seen.add(p.family);
        for (const key of ['contFreq', 'warp', 'mtnAmp', 'tempBase', 'tempLat']) assert(inRange(p[key], f[key]), `${key} of seed ${i}`);
        assert(inRange(p.oceanTarget, f.ocean), `ocean target of seed ${i}`);
        assert(inRange(p.moistBase, f.moist), `moisture of seed ${i}`);
        assert(inRange(p.lights, f.lights), `lights of seed ${i}`);
        assert(inRange(p.clouds.cover, f.clouds), `cloud cover of seed ${i}`);
        assert(inRange(p.gain, LIMITS.gain) && inRange(p.mtnFreq, LIMITS.mtnFreq), `roughness of seed ${i}`);
        assert(inRange(p.tiltDeg, LIMITS.tiltDeg), `tilt of seed ${i}`);
        assert(inRange(p.atmosphere.scaleHeight, LIMITS.scaleHeight), `scale height of seed ${i}`);
        assert(inRange(p.clouds.freq, LIMITS.cloudFreq) && inRange(p.clouds.swirl, LIMITS.swirl), `clouds of seed ${i}`);
        if (p.ring) assert(inRange(p.ring.inner, LIMITS.ringInner) && inRange(p.ring.outer, LIMITS.ringOuter) && p.ring.outer > p.ring.inner + 0.3, `rings of seed ${i}`);
        for (const c of p.palette) assert(c >= 0 && c <= 1, `palette of seed ${i}`);
      }
      equal(seen.size, FAMILIES.length, 'every family turns up');
    },
  },
  {
    name: 'planet names are repeatable and pronounceable',
    fn() {
      const vowels = 'aeiou';
      for (let i = 0; i < 2000; i++) {
        const hash = Math.imul(i + 1, 2654435761) >>> 0;
        const name = planetName(hash);
        equal(planetName(hash), name);
        assert(/^[A-Z][a-z]{3,9}$/.test(name), `${name} is one capitalised word of 4 to 10 letters`);
        let run = 0;
        let groups = 0;
        let prev = null;
        for (const ch of name.toLowerCase()) {
          const isVowel = vowels.includes(ch);
          run = isVowel === prev ? run + 1 : 1;
          if (isVowel && run === 1) groups++;
          prev = isVowel;
          assert(run <= 2, `${name} never has three vowels or three consonants in a row`);
        }
        assert(groups >= 2, `${name} has at least two syllables`);
      }
    },
  },
  {
    name: 'noise is repeatable, bounded and zero on the lattice',
    fn() {
      const r = rng(11);
      const seed = layerSeed(12345, 3);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < 20000; i++) {
        const x = r.range(-40, 40);
        const y = r.range(-40, 40);
        const z = r.range(-40, 40);
        const n = noise3(x, y, z, seed);
        equal(noise3(x, y, z, seed), n);
        peak = Math.max(peak, Math.abs(n));
        sum += n;
      }
      assert(peak < 1.5, `|noise| stays under its bound of 1.5 (saw ${peak})`);
      assert(peak > 0.5, 'noise uses a good part of its range');
      assert(Math.abs(sum / 20000) < 0.02, 'noise averages to zero');
      near(noise3(3, -7, 12, seed), 0, 1e-12);
    },
  },
  {
    name: 'noise is continuous, also across cell boundaries',
    fn() {
      const r = rng(5);
      const seed = layerSeed(999, 1);
      const step = 1e-4;
      for (let i = 0; i < 4000; i++) {
        // half the samples straddle an integer plane, where neighbouring cells meet
        const x = i % 2 ? Math.round(r.range(-20, 20)) - step / 2 : r.range(-20, 20);
        const y = r.range(-20, 20);
        const z = r.range(-20, 20);
        const d = Math.abs(noise3(x + step, y, z, seed) - noise3(x, y, z, seed));
        assert(d < 6 * step, `a step of ${step} changes noise by ${d}`);
      }
    },
  },
  {
    name: 'different seeds give unrelated noise',
    fn() {
      const r = rng(8);
      let dot = 0;
      let aa = 0;
      let bb = 0;
      for (let i = 0; i < 6000; i++) {
        const x = r.range(-30, 30);
        const y = r.range(-30, 30);
        const z = r.range(-30, 30);
        const a = noise3(x, y, z, layerSeed(1, 4));
        const b = noise3(x, y, z, layerSeed(2, 4));
        dot += a * b;
        aa += a * a;
        bb += b * b;
      }
      assert(Math.abs(dot / Math.sqrt(aa * bb)) < 0.05, 'correlation between two seeds is near zero');
    },
  },
  {
    name: 'detail octaves fade in without a jump',
    fn() {
      const seed = layerSeed(77, 4);
      near(fbm3(0.3, 1.7, -2.2, seed, 4 + 1e-7, 0.5), fbm3(0.3, 1.7, -2.2, seed, 4, 0.5), 1e-6);
      const half = fbm3(0.3, 1.7, -2.2, seed, 4.5, 0.5);
      near(half, (fbm3(0.3, 1.7, -2.2, seed, 4, 0.5) + fbm3(0.3, 1.7, -2.2, seed, 5, 0.5)) / 2, 1e-12);
    },
  },
  {
    name: 'terrain has no seams or pole artefacts',
    fn() {
      const { terrain, sea } = planetFor('seamless');
      const p = [0, 0, 0];
      const step = 2e-4;
      let worst = 0;
      const check = (x, y, z) => {
        const n = Math.hypot(x, y, z);
        const e = terrain.elevation(x / n, y / n, z / n, sea);
        const m = Math.hypot(x + step, y - step, z + step);
        worst = Math.max(worst, Math.abs(terrain.elevation((x + step) / m, (y - step) / m, (z + step) / m, sea) - e));
      };
      for (let i = 0; i < 1500; i++) {
        spherePoint(i, 1500, 0.4, p);
        check(p[0], p[1], p[2]);
      }
      // rings of points hugging both poles and the date line, where a 2D map would tear
      for (let i = 0; i < 200; i++) {
        const a = (i / 200) * Math.PI * 2;
        check(1e-3 * Math.cos(a), 1, 1e-3 * Math.sin(a));
        check(1e-3 * Math.cos(a), -1, 1e-3 * Math.sin(a));
        check(-1, Math.cos(a), 1e-4 * (i % 2 ? 1 : -1));
      }
      assert(worst < 0.02, `neighbouring points differ by at most ${worst}`);
    },
  },
  {
    name: 'the solved sea level floods the share of the planet it was asked to',
    fn() {
      for (const seed of ['fable', 'arid one', 'deep blue', 'x']) {
        const planet = planetFor(seed);
        const job = createSurvey(planet.terrain, planet.sea, 3000);
        while (!job.step(1000));
        const s = job.result();
        // mountains raise a little extra land, so measured ocean sits at or just under the target
        assert(Math.abs(s.ocean - planet.params.oceanTarget) < 0.06, `${seed}: asked for ${planet.params.oceanTarget}, measured ${s.ocean}`);
      }
    },
  },
  {
    name: 'the survey accounts for every sample exactly once',
    fn() {
      const planet = planetFor('census');
      const job = createSurvey(planet.terrain, planet.sea, 2500);
      let slices = 0;
      while (!job.step(0)) slices++;
      const s = job.result();
      equal(s.samples, 2500);
      assert(slices > 1, 'the work is split into slices');
      near(s.ocean - s.seaIce + s.frozen + s.land.wet + s.land.open + s.land.dry, 1, 1e-9);
      assert(s.peak > 0 && s.deepest > 0, 'there is land above and seabed below sea level');
    },
  },
  {
    name: 'ray and sphere intersections match hand-worked cases',
    fn() {
      near(raySphere(0, 0, 5, 0, 0, -1, 1), 4, 1e-12);
      near(raySphere(0, 0, 0, 0, 1, 0, 2), 2, 1e-12, 'from inside, the far side is hit');
      equal(raySphere(0, 0, 5, 0, 0, 1, 1), -1, 'a ray pointing away misses');
      equal(raySphere(0, 1.01, 5, 0, 0, -1, 1), -1, 'a ray passing just outside misses');
      near(raySphere(0, 1, 5, 0, 0, -1, 1), 5, 1e-6, 'a tangent ray touches at closest approach');
      const d = 6.2;
      near(distanceForRadius(discRadius(d, TAN_FOV), TAN_FOV), d, 1e-9);
      // the ray through the edge of the disc is tangent to the sphere
      const edge = viewRay([0, 0, 0], discRadius(d, TAN_FOV), 0, TAN_FOV);
      const b = d * edge[2];
      near(d * d - b * b, 1, 1e-9);
    },
  },
  {
    name: 'the trackball stays a pure rotation after thousands of drags',
    fn() {
      const orbit = createOrbit(TAN_FOV);
      const r = rng(3);
      let t = 0;
      for (let i = 0; i < 3000; i++) {
        orbit.grab(r.range(-1.2, 1.2), r.range(-1.2, 1.2), t);
        for (let k = 0; k < 3; k++) orbit.drag(r.range(-1.2, 1.2), r.range(-1.2, 1.2), (t += 8));
        orbit.release(t);
        orbit.update(0.016, true);
      }
      const m = orbit.rot;
      for (let c = 0; c < 3; c++) {
        for (let d = 0; d < 3; d++) {
          const dot = m[c * 3] * m[d * 3] + m[c * 3 + 1] * m[d * 3 + 1] + m[c * 3 + 2] * m[d * 3 + 2];
          near(dot, c === d ? 1 : 0, 1e-6, `columns ${c} and ${d}`);
        }
      }
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4]);
      near(det, 1, 1e-6, 'determinant');
    },
  },
  {
    name: 'a dragged point stays under the pointer',
    fn() {
      const orbit = createOrbit(TAN_FOV);
      orbit.reset(20, 1);
      const toPlanet = (v) => {
        const m = orbit.rot;
        return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
      };
      const grabbed = toPlanet(pickSphere([0, 0, 0], 0.1, -0.2, orbit.camDist, TAN_FOV));
      orbit.grab(0.1, -0.2, 0);
      orbit.drag(0.3, 0.05, 16);
      orbit.drag(-0.25, 0.4, 32);
      const now = toPlanet(pickSphere([0, 0, 0], -0.25, 0.4, orbit.camDist, TAN_FOV));
      for (let i = 0; i < 3; i++) near(now[i], grabbed[i], 1e-6);
    },
  },
  {
    name: 'a flick keeps the planet turning, then it comes to rest',
    fn() {
      const orbit = createOrbit(TAN_FOV);
      orbit.grab(0, 0, 0);
      orbit.drag(0.1, 0, 10);
      orbit.drag(0.2, 0, 20);
      orbit.release(21);
      equal(orbit.update(0.016, false), 2, 'still moving right after release');
      let frames = 0;
      while (orbit.update(0.016, false) !== 0 && frames < 2000) frames++;
      assert(frames > 10 && frames < 2000, `the flick lasts a while and ends (${frames} frames)`);
      orbit.grab(0, 0, 5000);
      orbit.drag(0.2, 0, 5010);
      orbit.release(5400);
      equal(orbit.update(0.016, false), 0, 'pausing before letting go leaves no spin');
    },
  },
  {
    name: 'the closed-form air column matches numerical integration',
    fn() {
      let worst = 0;
      for (const X of [45, 70]) {
        for (const h of [0, 0.5, 2, 5]) {
          for (const c of [1, 0.8, 0.6, 0.3, 0.15, 0.06, 0, -0.02, -0.05, -0.1]) {
            const exact = opticalDepthNumeric(X, h, c, 4000);
            if (!Number.isFinite(exact)) continue;
            worst = Math.max(worst, Math.abs(chapman(X, h, c) - exact) / exact);
          }
        }
      }
      assert(worst < 0.025, `worst relative error ${(100 * worst).toFixed(1)} %`);
      near(chapman(60, 0, 1), 1, 0.02, 'straight up is one scale height');
      assert(Math.exp(-0.04 * chapman(60, 0, -0.5)) < 1e-9, 'a ray through the planet carries no light');
    },
  },
  {
    name: 'the sun slider runs from behind the camera to behind the planet',
    fn() {
      const s = [0, 0, 0];
      for (let a = -180; a <= 180; a += 15) near(Math.hypot(...sunDirection(s, a)), 1, 1e-12);
      assert(sunDirection(s, 0)[2] > 0.95, 'at 0° the sun is behind the camera');
      assert(sunDirection(s, 90)[0] > 0.95, 'at +90° it is to the right');
      const back = sunDirection(s, 180);
      near(back[2], -1, 1e-9, 'at 180° it is exactly behind the planet');
      near(back[1], 0, 1e-9);
    },
  },
  {
    name: 'zooming in only ever brings the camera closer',
    fn() {
      let prev = Infinity;
      for (let z = 0; z <= 1.0001; z += 0.05) {
        const d = zoomDistance(z, 0.66, TAN_FOV);
        assert(d < prev && d > 1.5, `distance ${d} at zoom ${z}`);
        prev = d;
      }
      near(discRadius(zoomDistance(0, 0.66, TAN_FOV), TAN_FOV), 0.66, 1e-9);
    },
  },
  {
    name: 'resolution follows what the GPU can do, not the pace of the display',
    fn() {
      const q = createQuality({ min: 0.4 });
      let now = 0;
      // a 60 Hz display and a GPU that needs `cost` ms for a frame at full resolution
      const run = (cost, frames) => {
        for (let i = 0; i < frames; i++) {
          const interval = Math.max(1, Math.ceil((cost * q.scale * q.scale) / 16.7)) * 16.7;
          q.sample(interval, (now += interval));
        }
      };
      run(8, 200);
      equal(q.scale, 1, 'a fast GPU stays at full resolution');
      run(40, 300);
      assert(q.scale < 0.9, 'a GPU that needs 40 ms a frame is given fewer pixels');
      const low = q.scale;
      run(4, 3000);
      assert(q.scale > low, 'and gets them back when it speeds up');
      run(150, 600);
      near(q.scale, 0.4, 1e-9, 'it never goes below the floor');
      // Low Power Mode: the display runs at 30 Hz however little the GPU has to do
      const capped = createQuality({ min: 0.4 });
      now = 0;
      for (let i = 0; i < 600; i++) capped.sample(33.3, (now += 33.3));
      equal(capped.scale, 1, 'a 30 Hz display is not mistaken for a slow GPU');
    },
  },
  {
    name: 'a blue sky and a red sunset come from the same coefficients',
    fn() {
      const { sky, sunset } = skyColors(paramsFromSeed('fable').atmosphere);
      const earth = skyColors({ tau: [0.05, 0.11, 0.24], scaleHeight: 0.018 });
      assert(earth.sky[2] > earth.sky[1] && earth.sky[1] > earth.sky[0], 'air that scatters blue most makes a blue sky');
      assert(earth.sunset[0] > earth.sunset[1] && earth.sunset[1] > earth.sunset[2], 'and removes blue first, leaving a red sunset');
      for (const c of [...sky, ...sunset]) assert(c >= 0 && c <= 1, 'colours are normalised');
    },
  },
  {
    name: 'the planet shader compiles',
    browser: true,
    fn() {
      const renderer = gpu();
      if (!renderer) return;
      assert(!renderer.gl.isContextLost(), 'context is alive');
    },
  },
  {
    name: 'a rendered frame shows a lit planet on a dark sky',
    browser: true,
    fn() {
      const renderer = gpu();
      if (!renderer) return;
      const data = render(renderer, planetFor('fable'), { sun: sunDirection([0, 0, 0], 0) });
      const lum = (i, j) => {
        const k = (j * SIZE + i) * 4;
        return (data[k] + data[k + 1] + data[k + 2]) / 3;
      };
      let disc = 0;
      for (let j = 30; j < 42; j++) for (let i = 30; i < 42; i++) disc += lum(i, j) / 144;
      assert(disc > 40, `the middle of the disc is lit (mean ${disc.toFixed(1)} of 255)`);
      assert(lum(1, 1) + lum(SIZE - 2, 1) + lum(1, SIZE - 2) < 240, 'the corners are sky');
    },
  },
  {
    name: 'the same seed renders the same pixels, another seed does not',
    browser: true,
    fn() {
      const renderer = gpu();
      if (!renderer) return;
      const a = render(renderer, planetFor('fable'));
      const other = render(renderer, planetFor('elbaf'));
      const b = render(renderer, planetFor('fable'));
      equal(b, a);
      let differing = 0;
      for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - other[k]) + Math.abs(a[k + 1] - other[k + 1]) + Math.abs(a[k + 2] - other[k + 2]) > 24) differing++;
      assert(differing > SIZE * SIZE * 0.1, `${differing} pixels differ between two seeds`);
    },
  },
  {
    name: 'shader and JavaScript agree on the height of every visible point',
    browser: true,
    fn() {
      const renderer = gpu();
      if (!renderer) return;
      const planet = planetFor('fable');
      const frame = frameFor(planet, { debug: DEBUG.elevation, fixedOcts: [6, 4] });
      const data = render(renderer, planet, frame);
      let worst = 0;
      let checked = 0;
      let coastAgree = 0;
      for (let j = 0; j < SIZE; j++) {
        for (let i = 0; i < SIZE; i++) {
          const k = (j * SIZE + i) * 4;
          const p = pixelPoint(i, j, frame);
          if (!p || data[k + 2] === 0) continue;
          const js = planet.terrain.elevation(p[0], p[1], p[2], planet.sea);
          const gl = unpack16(data, k) / DEBUG_SCALE.elevation;
          worst = Math.max(worst, Math.abs(js - gl));
          if (js > 0 === gl > 0 || Math.abs(js) < 2e-3) coastAgree++;
          checked++;
        }
      }
      assert(checked > 400, `${checked} pixels on the disc`);
      assert(worst < 2e-3, `largest difference ${worst.toExponential(2)} terrain units`);
      equal(coastAgree, checked, 'land and sea are in the same places');
    },
  },
  {
    name: "the shader's analytic slope matches finite differences of the terrain",
    browser: true,
    fn() {
      const renderer = gpu();
      if (!renderer) return;
      const planet = planetFor('fable');
      const modes = [DEBUG.slopeX, DEBUG.slopeY, DEBUG.slopeZ];
      const frames = modes.map((debug) => frameFor(planet, { debug, fixedOcts: [6, 4] }));
      const images = frames.map((frame) => render(renderer, planet, frame));
      const elev = (x, y, z) => {
        const n = Math.hypot(x, y, z);
        return planet.terrain.elevation(x / n, y / n, z / n, planet.sea);
      };
      const h = 1e-4;
      let checked = 0;
      let close = 0;
      for (let j = 0; j < SIZE; j += 2) {
        for (let i = 0; i < SIZE; i += 2) {
          const k = (j * SIZE + i) * 4;
          const p = pixelPoint(i, j, frames[0]);
          if (!p || images[0][k + 2] === 0) continue;
          // gradient of the terrain along the surface, by central differences
          const g = [0, 1, 2].map((a) => {
            const d = [0, 0, 0];
            d[a] = h;
            return (elev(p[0] + d[0], p[1] + d[1], p[2] + d[2]) - elev(p[0] - d[0], p[1] - d[1], p[2] - d[2])) / (2 * h);
          });
          const radial = g[0] * p[0] + g[1] * p[1] + g[2] * p[2];
          let err = 0;
          let size = 0;
          for (let a = 0; a < 3; a++) {
            const expected = g[a] - radial * p[a];
            err = Math.max(err, Math.abs(unpack16(images[a], k) / DEBUG_SCALE.slope - expected));
            size = Math.max(size, Math.abs(expected));
          }
          checked++;
          if (err < 0.02 + 0.02 * size) close++;
        }
      }
      assert(checked > 100, `${checked} pixels compared`);
      // ridge crests are creases, where a finite difference straddles two slopes
      assert(close / checked > 0.97, `${close} of ${checked} slopes agree`);
    },
  },
  {
    name: 'city lights appear only on the night side',
    browser: true,
    fn() {
      const renderer = gpu();
      if (!renderer) return;
      const planet = planetFor('fable');
      const options = { clouds: false, atmosphere: false };
      const day = render(renderer, planet, { ...options, sun: sunDirection([0, 0, 0], 0) });
      const night = render(renderer, planet, { ...options, sun: sunDirection([0, 0, 0], 180) });
      let dayMean = 0;
      let nightMean = 0;
      let lamps = 0;
      let count = 0;
      for (let j = 24; j < 48; j++) {
        for (let i = 24; i < 48; i++) {
          const k = (j * SIZE + i) * 4;
          dayMean += day[k] + day[k + 1] + day[k + 2];
          nightMean += night[k] + night[k + 1] + night[k + 2];
          // a lamp is warm: clearly more red than blue
          if (night[k] > 60 && night[k] > night[k + 2] * 1.5) lamps++;
          count += 3;
        }
      }
      assert(nightMean / count < 0.3 * (dayMean / count), 'the night side is much darker than the day side');
      assert(planet.params.lights === 0 || lamps > 0, 'lamps are lit after dark');
    },
  },
  {
    name: 'clouds and atmosphere each change the picture when switched off',
    browser: true,
    fn() {
      const renderer = gpu();
      if (!renderer) return;
      const planet = planetFor('fable');
      const full = render(renderer, planet);
      const diff = (other) => {
        let n = 0;
        for (let k = 0; k < full.length; k += 4) if (Math.abs(full[k] - other[k]) + Math.abs(full[k + 2] - other[k + 2]) > 16) n++;
        return n;
      };
      assert(diff(render(renderer, planet, { clouds: false })) > 50, 'removing clouds uncovers the surface');
      assert(diff(render(renderer, planet, { atmosphere: false })) > 50, 'removing the atmosphere removes the haze');
      // release the test context so repeated runs do not pile up GPU contexts
      const lose = renderer.gl.getExtension('WEBGL_lose_context');
      renderer.dispose();
      if (lose) lose.loseContext();
      shared = null;
    },
  },
];
