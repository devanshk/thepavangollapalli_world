// A small analytic daylight model: single scattering by air molecules (Rayleigh) and haze (Mie)
// with closed-form optical depths. It is a plausible approximation, not a measured sky. The
// formulas here produce the uniforms; shader/integrate.js evaluates the same model per ray.
import { normalize } from './vec.js';

/** Vertical optical depth of the molecular atmosphere for red, green and blue light. */
export const RAYLEIGH = [0.046, 0.108, 0.265];
/** Vertical optical depth of haze (wavelength-independent). */
export const MIE = 0.06;
/** How much of the sun's own extinction also dims the light that the sky scatters. */
const SKY_SUN_EXTINCTION = 0.35;

/** Relative optical air mass toward a direction with the given cosine to the zenith (Rozenberg). */
export const airMass = (cosZenith) => 1 / (cosZenith + 0.025 * Math.exp(-11 * cosZenith));

/**
 * Uniform values for an environment description.
 *   { color: [r, g, b] }                                            a constant-radiance backdrop
 *   { sun: { azimuth, elevation, radius }, intensity, skyGain }     sun and sky (angles in degrees)
 */
export function environment(env) {
  if (!env.sun) {
    return { mode: 0, color: env.color, sunDir: [0, 1, 0], sunRadiance: [0, 0, 0], sunCone: [1, 0], skySource: [0, 0, 0] };
  }
  const rad = Math.PI / 180;
  const el = env.sun.elevation * rad;
  const az = env.sun.azimuth * rad;
  const sunDir = normalize([Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]);
  const mass = airMass(sunDir[1]);
  const transmittance = RAYLEIGH.map((tau) => Math.exp(-(tau + MIE) * mass));
  const oneMinusCos = 2 * Math.sin((env.sun.radius * rad) / 2) ** 2;
  const solidAngle = 2 * Math.PI * oneMinusCos;
  return {
    mode: 1,
    color: [0, 0, 0],
    sunDir,
    sunRadiance: transmittance.map((t) => (env.intensity * t) / solidAngle),
    sunCone: [1 - oneMinusCos, oneMinusCos],
    skySource: transmittance.map((t) => env.intensity * env.skyGain * t ** SKY_SUN_EXTINCTION),
  };
}
