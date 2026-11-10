// The GPU layer: two shader programs, the packed scene texture and the float accumulation
// buffers. It knows nothing about the page; index.js drives it, and the browser tests use it
// directly on an off-screen canvas.
import { doubleTarget, fullscreen, program, target, texture, toScreen } from '../../assets/js/glkit.js';
import { TEX_WIDTH, packScene, readHeader } from './pack.js';
import { DISPLAY_SOURCE, MAX_BOUNCES, MAX_SPF, TRACE_SOURCE } from './shader/index.js';
import { MIE, RAYLEIGH, environment } from './sky.js';

/** Largest tone-mapped-scale value an indirect light path may contribute (see integrate.js). */
const FIREFLY_CLAMP = 24;
const NO_CLAMP = 1e30;

/** The best accumulation format this GPU can render to, or null. Float32 is preferred. */
export function pickFormat(gl, caps) {
  const candidates = [caps.float32 && 'rgba32f', caps.float16 && 'rgba16f'].filter(Boolean);
  for (const format of candidates) {
    try {
      target(gl, 4, 4, { format }).dispose();
      return format;
    } catch {
      // not renderable on this GPU: try the next format
    }
  }
  return null;
}

/**
 * createRenderer(gl, format) → renderer. Throws if a shader fails to compile.
 *   setScene(scene)                 pack and upload a scene description
 *   setCamera(camera)               from camera.js makeCamera()
 *   setOptions({ bounces, clamp, strategy })
 *   buffer(name, w, h)              make sure an accumulation buffer of that size exists;
 *                                   returns true when it had to be (re)created, which empties it
 *   reset(name)                     forget its samples
 *   accumulate(name, spf)           trace spf more samples per pixel into it → total samples
 *   samples(name)
 *   present(name)                   tone-map it to the canvas
 *   fence()                         → { done() }: true once the GPU has finished everything
 *                                   submitted so far; polled, never waited on
 *   contextLost()
 *   read(name)                      → Float32Array of RGBA radiance, or null if unsupported
 *   probe(w, h)                     → Float32Array of [distance, kind, index, 1] per pixel, or null
 *   rebuild()                       recreate every GPU object after a restored context
 */
export function createRenderer(gl, format) {
  let trace = null;
  let display = null;
  let sceneTex = null;
  let buffers = new Map();
  let epoch = 1;

  let packed = null;
  let header = null;
  let env = null;
  let exposure = 1;
  let camera = null;
  const options = { bounces: 6, clamp: null, strategy: 0 };

  function uploadScene() {
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_WIDTH, 1, gl.RGBA, gl.FLOAT, packed);
  }

  function build() {
    // extensions have to be enabled again on a restored context
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    trace = program(gl, TRACE_SOURCE);
    display = program(gl, DISPLAY_SOURCE);
    sceneTex = texture(gl, TEX_WIDTH, 1, { format: 'rgba32f' });
    buffers = new Map();
    if (packed) uploadScene();
  }

  function setUniforms(w, h, sampleBase, spf, mode) {
    const { counts, offsets } = header;
    const clamp = options.clamp == null ? FIREFLY_CLAMP / exposure : options.clamp;
    trace.use();
    trace.tex('uScene', sceneTex, 0);
    gl.uniform4i(trace.loc('uCounts'), counts.spheres, counts.boxes, counts.quads, counts.lights);
    gl.uniform4i(trace.loc('uOffsets'), offsets.boxes, offsets.quads, offsets.materials, offsets.lights);
    trace
      .v2('uRes', w, h)
      .i('uSampleBase', sampleBase)
      .i('uSpf', spf)
      .i('uEpoch', epoch)
      .i('uMode', mode)
      .i('uStrategy', options.strategy)
      .i('uMaxBounces', Math.min(options.bounces, MAX_BOUNCES))
      .f('uClamp', Math.min(clamp, NO_CLAMP))
      .f('uHalfSteps', format === 'rgba16f' && mode === 0 ? 1 : 0)
      .v3('uEye', ...camera.eye)
      .v3('uRight', ...camera.right)
      .v3('uUp', ...camera.up)
      .v3('uFwd', ...camera.fwd)
      .v2('uTan', camera.tanH, camera.tanV)
      .f('uLensRadius', camera.lensRadius)
      .f('uFocus', camera.focus)
      .i('uEnvMode', env.mode)
      .v3('uEnvColor', ...env.color)
      .v3('uSunDir', ...env.sunDir)
      .v3('uSunRadiance', ...env.sunRadiance)
      .v2('uSunCone', ...env.sunCone)
      .v3('uSkySource', ...env.skySource)
      .v3('uSkyRayleigh', ...RAYLEIGH)
      .f('uSkyMie', MIE);
  }

  function readFloats(fbo, w, h) {
    const out = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    while (gl.getError() !== gl.NO_ERROR);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
    const ok = gl.getError() === gl.NO_ERROR;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? out : null;
  }

  build();

  return {
    format,
    setScene(scene) {
      packed = packScene(scene);
      header = readHeader(packed);
      env = environment(scene.env);
      exposure = scene.exposure;
      uploadScene();
      epoch++;
    },
    setCamera(next) {
      camera = next;
    },
    setOptions(next) {
      Object.assign(options, next);
    },
    buffer(name, w, h) {
      const old = buffers.get(name);
      if (old && old.pair.w === w && old.pair.h === h) return false;
      if (old) old.pair.dispose();
      buffers.set(name, { pair: doubleTarget(gl, w, h, { format }), samples: 0 });
      return true;
    },
    reset(name) {
      buffers.get(name).samples = 0;
      epoch++;
    },
    samples(name) {
      return buffers.get(name).samples;
    },
    accumulate(name, spf) {
      const buf = buffers.get(name);
      const n = Math.max(1, Math.min(MAX_SPF, spf));
      buf.pair.write.bind();
      setUniforms(buf.pair.w, buf.pair.h, buf.samples, n, 0);
      trace.tex('uPrev', buf.pair.read.tex, 1);
      fullscreen(gl);
      buf.pair.swap();
      buf.samples += n;
      return buf.samples;
    },
    present(name) {
      const { pair } = buffers.get(name);
      toScreen(gl);
      display.use();
      display.tex('uAccum', pair.read.tex, 0).v2('uAccumSize', pair.w, pair.h).f('uExposure', exposure);
      fullscreen(gl);
    },
    fence() {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      let finished = !sync;
      return {
        done() {
          if (finished) return true;
          if (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) return false;
          gl.deleteSync(sync);
          finished = true;
          return true;
        },
      };
    },
    contextLost() {
      return gl.isContextLost();
    },
    read(name) {
      const { pair } = buffers.get(name);
      return readFloats(pair.read.fbo, pair.w, pair.h);
    },
    probe(w, h) {
      if (format !== 'rgba32f') return null;
      const out = target(gl, w, h, { format });
      out.bind();
      setUniforms(w, h, 0, 1, 1);
      trace.tex('uPrev', sceneTex, 1);
      fullscreen(gl);
      const data = readFloats(out.fbo, w, h);
      out.dispose();
      return data;
    },
    rebuild() {
      build();
    },
    dispose() {
      for (const { pair } of buffers.values()) pair.dispose();
      buffers.clear();
      trace.dispose();
      display.dispose();
      gl.deleteTexture(sceneTex);
    },
  };
}
