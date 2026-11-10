// Tests of the ray maths: the JavaScript intersection mirror, the camera and the optics formulas.
// They run in Node and in the browser.
import { assert, equal, near } from '../../assets/js/check.js';
import { rng } from '../../assets/js/kit.js';
import { depthOf, focalLength, fieldOfView, lensRadius, lensRay, makeCamera, pinholeRay } from './camera.js';
import { KIND_QUAD, KIND_SPHERE, closestHit, hitBox, hitQuad, hitSphere } from './mirror.js';
import {
  fresnelDielectric, ggxD, ggxG1, ggxG2, ggxReflectPdf, reflect, refract, sampleGgxVndf,
} from './optics.js';
import { packScene } from './pack.js';
import { add, cross, dot, length, madd, normalize, scale, sub } from './vec.js';

const randomUnit = (r) => {
  const z = r.range(-1, 1);
  const phi = r.range(0, 2 * Math.PI);
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(phi), s * Math.sin(phi), z];
};

/** Midpoint quadrature of f(direction) over the upper hemisphere (z up). */
function integrateHemisphere(f, steps = 256) {
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const cosT = (i + 0.5) / steps;
    const sinT = Math.sqrt(1 - cosT * cosT);
    for (let j = 0; j < steps; j++) {
      const phi = ((j + 0.5) / steps) * 2 * Math.PI;
      sum += f([sinT * Math.cos(phi), sinT * Math.sin(phi), cosT]);
    }
  }
  return (sum * 2 * Math.PI) / (steps * steps);
}

const pose = { target: [0, 0, 0], yaw: 0.4, pitch: 0.3, distance: 10 };
const lens = { fovDeg: 30, aspect: 16 / 9, fNumber: 2, focus: 10 };

const intersections = [
  {
    name: 'a ray aimed at a sphere hits its near surface',
    fn() {
      near(hitSphere([0, 0, 5], [0, 0, -1], [0, 0, 0], 1), 4, 1e-12);
      near(hitSphere([0, 3, 4], normalize([0, -3, -4]), [0, 0, 0], 2), 3, 1e-12);
    },
  },
  {
    name: 'a ray starting inside a sphere hits the far side',
    fn() {
      near(hitSphere([0, 0, 0], [1, 0, 0], [0, 0, 0], 1), 1, 1e-12);
      near(hitSphere([0.5, 0, 0], [1, 0, 0], [0, 0, 0], 1), 0.5, 1e-12);
    },
  },
  {
    name: 'a ray that passes beside or points away from a sphere misses',
    fn() {
      equal(hitSphere([1.001, 0, 5], [0, 0, -1], [0, 0, 0], 1), Infinity);
      equal(hitSphere([0, 0, 5], [0, 0, 1], [0, 0, 0], 1), Infinity);
    },
  },
  {
    name: 'ray-sphere distances agree with the quadratic formula',
    fn() {
      const r = rng(3);
      for (let i = 0; i < 400; i++) {
        const c = [r.range(-3, 3), r.range(-3, 3), r.range(-3, 3)];
        const radius = r.range(0.2, 2);
        const ro = [r.range(-8, 8), r.range(-8, 8), r.range(-8, 8)];
        const rd = randomUnit(r);
        const oc = sub(ro, c);
        const b = dot(oc, rd);
        const disc = b * b - (dot(oc, oc) - radius * radius);
        const roots = disc < 0 ? [] : [-b - Math.sqrt(disc), -b + Math.sqrt(disc)].filter((t) => t > 1e-4);
        const expected = roots.length ? roots[0] : Infinity;
        const got = hitSphere(ro, rd, c, radius);
        if (expected === Infinity) equal(got, Infinity);
        else near(got, expected, 1e-9);
      }
    },
  },
  {
    name: 'a ray hits an upright box on the face it is aimed at',
    fn() {
      const side = hitBox([5, 0.2, 0.3], [-1, 0, 0], [0, 0, 0], [1, 2, 3], 1, 0);
      near(side.t, 4, 1e-12);
      equal(side.n, [1, 0, 0]);
      const top = hitBox([0.5, 9, -1], [0, -1, 0], [0, 0, 0], [1, 2, 3], 1, 0);
      near(top.t, 7, 1e-12);
      equal(top.n, [0, 1, 0]);
      equal(hitBox([5, 2.01, 0], [-1, 0, 0], [0, 0, 0], [1, 2, 3], 1, 0).t, Infinity);
    },
  },
  {
    name: 'a box turned 45 degrees is hit corner-first',
    fn() {
      const c = Math.SQRT1_2;
      const hit = hitBox([5, 0, 0.25], [-1, 0, 0], [0, 0, 0], [1, 1, 1], c, c);
      near(hit.t, 5 - (Math.SQRT2 - 0.25), 1e-12);
      near(Math.abs(hit.n[0]), c, 1e-12);
      near(Math.abs(hit.n[2]), c, 1e-12);
      assert(hit.n[0] > 0, 'the normal faces the ray');
    },
  },
  {
    name: 'a ray from inside a box leaves through the wall ahead',
    fn() {
      const hit = hitBox([0.2, 0, 0], [0, 0, -1], [0, 0, 0], [1, 1, 2], 1, 0);
      near(hit.t, 2, 1e-12);
      equal(hit.n, [0, 0, -1]);
    },
  },
  {
    name: 'every hit on a rotated box lies on its surface with a face normal',
    fn() {
      const r = rng(9);
      const half = [0.8, 1.7, 1.2];
      let hits = 0;
      for (let i = 0; i < 500; i++) {
        const angle = r.range(-3, 3);
        const [cs, sn] = [Math.cos(angle), Math.sin(angle)];
        const centre = [r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)];
        const ro = add(centre, scale(randomUnit(r), r.range(3, 6)));
        const rd = normalize(sub(add(centre, scale(randomUnit(r), r.range(0, 2))), ro));
        const hit = hitBox(ro, rd, centre, half, cs, sn);
        if (hit.t === Infinity) continue;
        hits++;
        const p = sub(madd(ro, rd, hit.t), centre);
        const local = [cs * p[0] - sn * p[2], p[1], sn * p[0] + cs * p[2]];
        const nLocal = [cs * hit.n[0] - sn * hit.n[2], hit.n[1], sn * hit.n[0] + cs * hit.n[2]];
        const axis = nLocal.findIndex((x) => Math.abs(x) > 0.5);
        near(Math.abs(local[axis]), half[axis], 1e-9, 'on the face');
        near(local[axis] * nLocal[axis], half[axis], 1e-9, 'normal points outward');
        for (let k = 0; k < 3; k++) assert(Math.abs(local[k]) <= half[k] + 1e-9, 'inside the other slabs');
        assert(dot(rd, hit.n) < 0, 'outside rays meet a front face');
      }
      assert(hits > 100, 'enough rays hit the box');
    },
  },
  {
    name: 'a ray meets a quad at height over cosine and misses beyond its edges',
    fn() {
      const quad = [[0, 1, 0], 0, [0, 0, 0], [0.5, 0, 0], [0, 0, 1], false];
      const rd = normalize([1, -2, 0.5]);
      near(hitQuad([0, 4, 0], rd, ...quad), 4 / (2 / length([1, -2, 0.5])), 1e-12);
      equal(hitQuad([0, 4, 0], normalize([2.1, -4, 0]), ...quad), Infinity);
      near(hitQuad([0, 4, 0], normalize([1.9, -4, 0]), ...quad), length([1.9, 4, 0]), 1e-12);
      equal(hitQuad([0, 4, 0], [1, 0, 0], ...quad), Infinity);
      equal(hitQuad([0, 4, 0], [0, 1, 0], ...quad), Infinity);
    },
  },
  {
    name: 'a one-sided quad is invisible from behind',
    fn() {
      const oneSided = [[0, 1, 0], 0, [0, 0, 0], [1, 0, 0], [0, 0, 1], true];
      near(hitQuad([0, 2, 0], [0, -1, 0], ...oneSided), 2, 1e-12);
      equal(hitQuad([0, -2, 0], [0, 1, 0], ...oneSided), Infinity);
    },
  },
  {
    name: 'the nearest of several objects wins',
    fn() {
      const data = packScene({
        materials: { a: { type: 'diffuse', color: [1, 1, 1] }, b: { type: 'metal', color: [1, 1, 1] } },
        spheres: [{ c: [0, 0, -6], r: 1, mat: 'a' }, { c: [0, 0, -3], r: 1, mat: 'b' }],
        boxes: [{ c: [0, 0, -9], h: [1, 1, 1], mat: 'a' }],
        quads: [{ c: [0, 0, -12], u: [4, 0, 0], v: [0, 4, 0], mat: 'a' }],
      });
      const hit = closestHit(data, [0, 0, 0], [0, 0, -1]);
      equal([hit.kind, hit.index, hit.material], [KIND_SPHERE, 1, 1]);
      near(hit.t, 2, 1e-6);
      equal(closestHit(data, [3, 0, 0], [0, 0, -1]).kind, KIND_QUAD);
      equal(closestHit(data, [0, 0, 0], [0, 0, 1]), null);
    },
  },
];

const cameraTests = [
  {
    name: 'the centre ray passes through the look-at point',
    fn() {
      const cam = makeCamera(pose, lens);
      const ray = pinholeRay(cam, 0.5, 0.5);
      const reached = madd(ray.o, ray.d, pose.distance);
      for (let k = 0; k < 3; k++) near(reached[k], pose.target[k], 1e-12);
      near(length(cam.right), 1, 1e-12);
      near(dot(cam.right, cam.up), 0, 1e-12);
      assert(cam.up[1] > 0, 'up points up');
    },
  },
  {
    name: 'edge rays span the field of view',
    fn() {
      const cam = makeCamera(pose, lens);
      const top = pinholeRay(cam, 0.5, 0).d;
      const bottom = pinholeRay(cam, 0.5, 1).d;
      near((Math.acos(dot(top, bottom)) * 180) / Math.PI, 30, 1e-9);
      const left = pinholeRay(cam, 0, 0.5).d;
      const right = pinholeRay(cam, 1, 0.5).d;
      near(Math.tan(Math.acos(dot(left, right)) / 2), Math.tan((15 * Math.PI) / 180) * (16 / 9), 1e-12);
      assert(dot(right, cam.right) > 0 && dot(top, cam.up) > 0, 'image is not mirrored');
    },
  },
  {
    name: 'a narrow canvas widens the view to keep the scene in frame',
    fn() {
      const wide = fieldOfView(30, 16 / 9, 0.4);
      near(wide.tanV, Math.tan((15 * Math.PI) / 180), 1e-12);
      const square = fieldOfView(30, 1, 0.4);
      near(square.tanH, 0.4, 1e-12);
      near(square.tanV, 0.4, 1e-12);
    },
  },
  {
    name: 'every ray through the lens meets at one point on the focus plane',
    fn() {
      const cam = makeCamera(pose, { ...lens, focus: 7 });
      const r = rng(5);
      const through = pinholeRay(cam, 0.3, 0.8);
      const focusPoint = madd(through.o, through.d, 7 / dot(through.d, cam.fwd));
      for (let i = 0; i < 50; i++) {
        const ray = lensRay(cam, 0.3, 0.8, r.range(-1, 1), r.range(-1, 1));
        const t = (7 - depthOf(cam, ray.o)) / dot(ray.d, cam.fwd);
        const p = madd(ray.o, ray.d, t);
        for (let k = 0; k < 3; k++) near(p[k], focusPoint[k], 1e-9);
      }
    },
  },
  {
    name: 'the f-number sets the aperture diameter',
    fn() {
      const { tanV } = fieldOfView(30, 1);
      near(focalLength(tanV), 0.12 / Math.tan((15 * Math.PI) / 180), 1e-12);
      near(2 * lensRadius(tanV, 2.8) * 2.8, focalLength(tanV), 1e-12);
      near(lensRadius(tanV, 1.4) / lensRadius(tanV, 2.8), 2, 1e-12);
    },
  },
  {
    name: 'a tap on an object returns its depth as the focus distance',
    fn() {
      const data = packScene({
        materials: { a: { type: 'diffuse', color: [1, 1, 1] } },
        spheres: [{ c: [0, 0, 0], r: 1.5, mat: 'a' }],
        quads: [{ c: [0, -1.5, 0], u: [50, 0, 0], v: [0, 0, -50], mat: 'a' }],
      });
      const cam = makeCamera(pose, lens);
      const centre = pinholeRay(cam, 0.5, 0.5);
      near(depthOf(cam, closestHit(data, centre.o, centre.d).point), pose.distance - 1.5, 1e-6);
      const low = pinholeRay(cam, 0.5, 0.95);
      const floor = closestHit(data, low.o, low.d);
      equal(floor.kind, KIND_QUAD);
      near(floor.point[1], -1.5, 1e-6);
      assert(depthOf(cam, floor.point) < pose.distance, 'the foreground floor is nearer than the sphere');
    },
  },
];

const opticsTests = [
  {
    name: 'refraction obeys Snell\'s law',
    fn() {
      const r = rng(1);
      const n = [0, 0, 1];
      for (let i = 0; i < 200; i++) {
        const theta = r.range(0, 1.55);
        const phi = r.range(0, 6.28);
        const d = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), -Math.cos(theta)];
        const t = refract(d, n, 1 / 1.5);
        near(length(t), 1, 1e-12);
        near(1.5 * length(cross(t, n)), Math.sin(theta), 1e-12, 'n1 sin θ1 = n2 sin θ2');
        near(dot(cross(d, n), t), 0, 1e-12, 'stays in the plane of incidence');
        assert(t[2] < 0, 'continues through the surface');
      }
    },
  },
  {
    name: 'refracting in and back out restores the direction',
    fn() {
      const d = normalize([0.6, -0.2, -0.7]);
      const inside = refract(d, [0, 0, 1], 1 / 1.33);
      const out = refract(inside, [0, 0, 1], 1.33);
      for (let k = 0; k < 3; k++) near(out[k], d[k], 1e-12);
    },
  },
  {
    name: 'light inside glass is totally reflected beyond the critical angle',
    fn() {
      const critical = Math.asin(1 / 1.5);
      const at = (theta) => [Math.sin(theta), 0, -Math.cos(theta)];
      assert(refract(at(critical - 0.01), [0, 0, 1], 1.5) !== null, 'just inside the cone refracts');
      equal(refract(at(critical + 0.01), [0, 0, 1], 1.5), null);
      equal(fresnelDielectric(Math.cos(critical + 0.01), 1.5), 1);
      const mirrored = reflect(at(1), [0, 0, 1]);
      near(mirrored[0], Math.sin(1), 1e-12);
      near(mirrored[2], Math.cos(1), 1e-12);
    },
  },
  {
    name: 'glass reflects 4% head-on, everything at grazing, and never more than it receives',
    fn() {
      near(fresnelDielectric(1, 1 / 1.5), 0.04, 1e-12);
      near(fresnelDielectric(1, 1.5), 0.04, 1e-12);
      near(fresnelDielectric(1e-9, 1 / 1.5), 1, 1e-6);
      let previous = 0;
      for (let i = 0; i <= 1000; i++) {
        const f = fresnelDielectric(1 - i / 1000, 1 / 1.5);
        assert(f >= previous - 1e-12 && f <= 1, 'rises monotonically toward 1');
        previous = f;
      }
    },
  },
  {
    name: 'Fresnel reflectance is the same from either side of the surface',
    fn() {
      for (let i = 1; i < 50; i++) {
        const cosI = i / 50;
        const sinT = Math.sqrt(1 - cosI * cosI) / 1.5;
        const cosT = Math.sqrt(1 - sinT * sinT);
        near(fresnelDielectric(cosI, 1 / 1.5), fresnelDielectric(cosT, 1.5), 1e-12);
      }
    },
  },
  {
    name: 'the GGX distribution of microfacets projects to unit area',
    fn() {
      // D depends only on the polar angle, so the hemisphere integral reduces to one dimension
      const steps = 20000;
      for (const alpha of [0.02, 0.1, 0.3, 0.8]) {
        let sum = 0;
        for (let i = 0; i < steps; i++) {
          const theta = ((i + 0.5) / steps) * (Math.PI / 2);
          sum += ggxD(Math.cos(theta), alpha) * Math.cos(theta) * Math.sin(theta);
        }
        near((sum * 2 * Math.PI * (Math.PI / 2)) / steps, 1, 1e-4);
      }
    },
  },
  {
    name: 'the GGX sampling density integrates to one',
    fn() {
      for (const [alpha, cosO] of [[0.25, 0.9], [0.5, 0.3]]) {
        const wo = [Math.sqrt(1 - cosO * cosO), 0, cosO];
        // some sampled normals reflect below the horizon; the rest must account for all other mass
        const r = rng(4);
        let below = 0;
        const count = 20000;
        for (let i = 0; i < count; i++) {
          const h = sampleGgxVndf(wo, alpha, r(), r());
          if (reflect(scale(wo, -1), h)[2] <= 0) below++;
        }
        const above = integrateHemisphere((wi) => ggxReflectPdf(wo, wi, alpha), 400);
        near(above + below / count, 1, 0.01);
      }
    },
  },
  {
    name: 'sampled GGX directions follow their density',
    fn() {
      const alpha = 0.4;
      const wo = normalize([0.5, 0.2, 0.7]);
      const r = rng(8);
      let sum = 0;
      const count = 40000;
      for (let i = 0; i < count; i++) {
        const wi = reflect(scale(wo, -1), sampleGgxVndf(wo, alpha, r(), r()));
        if (wi[2] > 0) sum += wi[2] + wi[0];
      }
      const expected = integrateHemisphere((wi) => (wi[2] + wi[0]) * ggxReflectPdf(wo, wi, alpha), 400);
      near(sum / count, expected, 0.01);
    },
  },
  {
    name: 'a rough white mirror never reflects more than it receives',
    fn() {
      const r = rng(6);
      for (const alpha of [0.05, 0.3, 0.7]) {
        for (const cosO of [0.95, 0.5, 0.15]) {
          const wo = [Math.sqrt(1 - cosO * cosO), 0, cosO];
          let sum = 0;
          const count = 4000;
          for (let i = 0; i < count; i++) {
            const wi = reflect(scale(wo, -1), sampleGgxVndf(wo, alpha, r(), r()));
            if (wi[2] <= 0) continue;
            const weight = ggxG2(cosO, wi[2], alpha) / ggxG1(cosO, alpha);
            assert(weight <= 1 + 1e-12, 'each sample weighs at most 1');
            sum += weight;
          }
          const albedo = sum / count;
          assert(albedo <= 1 && albedo > 0.4, `albedo ${albedo} for alpha ${alpha}, cos ${cosO}`);
        }
      }
    },
  },
];

export default [...intersections, ...cameraTests, ...opticsTests];
