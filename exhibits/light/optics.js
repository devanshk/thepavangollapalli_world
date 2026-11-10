// The reflection, refraction and microfacet formulas of the shader (shader/bsdf.js), written once
// more in JavaScript so they can be checked against closed-form optics in the tests.
import { cross, dot, madd, normalize, scale } from './vec.js';

/** Mirror direction of an incoming direction d about the unit normal n. */
export const reflect = (d, n) => madd(d, n, -2 * dot(d, n));

/**
 * Snell refraction of the incoming unit direction d at a surface with unit normal n (facing the
 * incoming side). eta = n_incident / n_transmitted. Returns null on total internal reflection.
 */
export function refract(d, n, eta) {
  const cosI = -dot(d, n);
  const sin2T = eta * eta * (1 - cosI * cosI);
  if (sin2T >= 1) return null;
  return normalize(madd(scale(d, eta), n, eta * cosI - Math.sqrt(1 - sin2T)));
}

/** Unpolarised Fresnel reflectance of a dielectric boundary. eta = n_incident / n_transmitted. */
export function fresnelDielectric(cosI, eta) {
  const sin2T = eta * eta * (1 - cosI * cosI);
  if (sin2T >= 1) return 1;
  const cosT = Math.sqrt(1 - sin2T);
  const rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  const rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

/** Schlick's approximation: reflectance f0 at normal incidence rising to 1 at grazing. */
export const schlick = (f0, cos) => f0 + (1 - f0) * (1 - cos) ** 5;

/** Reflectance at normal incidence of a dielectric with the given index of refraction. */
export const f0FromIor = (ior) => ((ior - 1) / (ior + 1)) ** 2;

/* GGX microfacet model in the local frame where z is the surface normal. */

/** Density of microfacet normals whose cosine to the surface normal is nh. */
export function ggxD(nh, alpha) {
  const a2 = alpha * alpha;
  const d = nh * nh * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}

/** Smith's Λ for a direction whose cosine to the normal is c. */
export function ggxLambda(c, alpha) {
  const c2 = Math.max(c * c, 1e-8);
  return 0.5 * (Math.sqrt(1 + (alpha * alpha * (1 - c2)) / c2) - 1);
}

export const ggxG1 = (c, alpha) => 1 / (1 + ggxLambda(c, alpha));
/** Height-correlated masking–shadowing for an outgoing/incoming pair. */
export const ggxG2 = (co, ci, alpha) => 1 / (1 + ggxLambda(co, alpha) + ggxLambda(ci, alpha));

/**
 * Sample a microfacet normal from the distribution of normals visible from wo (Heitz 2018).
 * u1, u2 are uniform in [0, 1).
 */
export function sampleGgxVndf(wo, alpha, u1, u2) {
  const vh = normalize([alpha * wo[0], alpha * wo[1], wo[2]]);
  const len2 = vh[0] * vh[0] + vh[1] * vh[1];
  const t1 = len2 > 1e-12 ? scale([-vh[1], vh[0], 0], 1 / Math.sqrt(len2)) : [1, 0, 0];
  const t2 = cross(vh, t1);
  const r = Math.sqrt(u1);
  const phi = 2 * Math.PI * u2;
  const p1 = r * Math.cos(phi);
  const s = 0.5 * (1 + vh[2]);
  const p2 = (1 - s) * Math.sqrt(Math.max(0, 1 - p1 * p1)) + s * r * Math.sin(phi);
  const p3 = Math.sqrt(Math.max(0, 1 - p1 * p1 - p2 * p2));
  const nh = [p1 * t1[0] + p2 * t2[0] + p3 * vh[0], p1 * t1[1] + p2 * t2[1] + p3 * vh[1], p1 * t1[2] + p2 * t2[2] + p3 * vh[2]];
  return normalize([alpha * nh[0], alpha * nh[1], Math.max(0, nh[2])]);
}

/** Solid-angle density of the reflected direction wi produced by sampleGgxVndf + reflect. */
export function ggxReflectPdf(wo, wi, alpha) {
  if (wo[2] <= 0 || wi[2] <= 0) return 0;
  const h = normalize([wo[0] + wi[0], wo[1] + wi[1], wo[2] + wi[2]]);
  return (ggxG1(wo[2], alpha) * ggxD(h[2], alpha)) / (4 * wo[2]);
}
