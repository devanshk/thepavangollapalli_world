// The GPU layer: owns the WebGL2 context and the one shader program, and turns a planet
// description plus a camera/sun/time state into a frame.
import { createGL, program, fullscreen, toScreen } from '../../assets/js/glkit.js';
import { FRAGMENT_SHADER, DEBUG } from './shader.js';

/** Tangent of half the field of view across the smaller canvas side. */
export const TAN_FOV = 0.25;
/** How strongly terrain slope tilts the shading normal (relief is exaggerated, as in most orbital imagery). */
const RELIEF = 0.05;
/** The atmosphere is integrated up to this many scale heights. */
const ATMO_TOP = 7;
const LAVA_GLOW = 1.35;

/**
 * createRenderer(canvas) → renderer, or null when WebGL2 is unavailable.
 * Throws if the shader fails to compile.
 *
 *   renderer.setPlanet(params, seaLevel)
 *   renderer.draw({ rot, sun, camDist, shift, cssMin, clouds, atmosphere, cloudAngle, cloudMorph, lodBias })
 */
export function createRenderer(canvas) {
  const ctx = createGL(canvas);
  if (!ctx) return null;
  const { gl } = ctx;
  let prog = program(gl, FRAGMENT_SHADER);
  let planet = null;
  const tauExt = [0, 0, 0];
  const skyLight = [0, 0, 0];

  function setPlanet(params, sea) {
    const a = params.atmosphere;
    const peak = Math.max(a.tau[0], a.tau[1], a.tau[2]);
    for (let i = 0; i < 3; i++) {
      tauExt[i] = a.tau[i] + 1.1 * a.mie;
      skyLight[i] = 0.075 * (0.35 + 0.65 * (a.tau[i] / peak)) * Math.min(a.thickness, 1.2);
    }
    planet = { params, sea };
  }

  function draw(frame) {
    if (!planet || gl.isContextLost()) return;
    const { params, sea } = planet;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const minSide = Math.min(w, h);
    const a = params.atmosphere;
    const c = params.clouds;
    const atmo = frame.atmosphere !== false;
    const debug = frame.debug || DEBUG.off;
    toScreen(gl);
    prog.use();
    prog.v2('uRes', w, h);
    prog.f('uPix', (2 * TAN_FOV) / minSide);
    prog.f('uStarSize', Math.max(1.7 / (frame.cssMin || minSide), 1.3 / minSide));
    prog.f('uCamDist', frame.camDist);
    prog.f('uTanFov', TAN_FOV);
    prog.v2('uShift', frame.shift ? frame.shift[0] : 0, frame.shift ? frame.shift[1] : 0);
    prog.m3('uRot', frame.rot);
    prog.v3('uSun', frame.sun[0], frame.sun[1], frame.sun[2]);
    gl.uniform1ui(prog.loc('uSeed'), params.hash >>> 0);

    prog.f('uSea', sea);
    prog.f('uContFreq', params.contFreq);
    prog.f('uWarp', params.warp);
    prog.f('uGain', params.gain);
    prog.f('uMtnAmp', params.mtnAmp);
    prog.f('uMtnFreq', params.mtnFreq);
    prog.f('uBump', RELIEF);
    prog.f('uTempBase', params.tempBase);
    prog.f('uTempLat', params.tempLat);
    prog.f('uMoistBase', params.moistBase);
    prog.fv('uPal', params.palette, 3);
    prog.f('uLava', params.lava ? 1 : 0);
    prog.f('uLavaGlow', LAVA_GLOW);
    prog.f('uLights', params.lights);

    prog.v3('uCloud', frame.clouds === false ? 0 : c.cover, c.freq, c.swirl);
    prog.v2('uCloudTime', frame.cloudAngle || 0, frame.cloudMorph || 0);
    prog.v3('uCloudColor', c.color[0], c.color[1], c.color[2]);

    prog.f('uAtmoOn', atmo ? 1 : 0);
    prog.v3('uTauR', a.tau[0], a.tau[1], a.tau[2]);
    prog.f('uTauM', a.mie);
    prog.v3('uTauExt', tauExt[0], tauExt[1], tauExt[2]);
    prog.f('uX', 1 / a.scaleHeight);
    prog.f('uTop', 1 + ATMO_TOP * a.scaleHeight);
    prog.v3('uSkyLight', atmo ? skyLight[0] : 0, atmo ? skyLight[1] : 0, atmo ? skyLight[2] : 0);

    const ring = params.ring;
    prog.v3('uRing', ring ? ring.inner : 1, ring ? ring.outer : 2, ring ? ring.opacity : 0);
    prog.v3('uRingColor', ring ? ring.color[0] : 0, ring ? ring.color[1] : 0, ring ? ring.color[2] : 0);

    prog.f('uLodBias', frame.lodBias || 0);
    prog.v2('uFixedOcts', frame.fixedOcts ? frame.fixedOcts[0] : 0, frame.fixedOcts ? frame.fixedOcts[1] : 0);
    prog.i('uDebug', debug);
    fullscreen(gl);
  }

  return {
    gl,
    setPlanet,
    draw,
    /** RGBA bytes of the frame just drawn, bottom row first. Call right after draw(). */
    readPixels() {
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const out = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return { data: out, w, h };
    },
    /** Recompile after the browser restores a lost context. */
    rebuild() {
      prog = program(gl, FRAGMENT_SHADER);
    },
    dispose() {
      if (!gl.isContextLost()) prog.dispose();
    },
  };
}
