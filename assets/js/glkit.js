// glkit.js — a thin WebGL2 layer for the GPU exhibits: context + capability probing,
// shader programs with readable compile errors, a full-screen triangle, and render targets.

/**
 * createGL(canvas, attrs?) → { gl, caps } or null when WebGL2 is unavailable.
 * caps.float32 / caps.float16: can render to RGBA32F / RGBA16F.
 * caps.linearFloat32: RGBA32F textures can use LINEAR filtering (16F always can in WebGL2).
 * caps.best: the best renderable float format name for target(): 'rgba16f' | 'rgba32f' | null.
 */
export function createGL(canvas, attrs = {}) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    ...attrs,
  });
  if (!gl) return null;
  const cbf = !!gl.getExtension('EXT_color_buffer_float');
  const cbhf = !!gl.getExtension('EXT_color_buffer_half_float');
  const caps = {
    float32: cbf,
    float16: cbf || cbhf,
    linearFloat32: !!gl.getExtension('OES_texture_float_linear'),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    best: cbf || cbhf ? 'rgba16f' : null,
  };
  return { gl, caps };
}

const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || 'unknown shader error';
    gl.deleteShader(sh);
    const m = /ERROR:\s*\d+:(\d+)/.exec(log);
    let context = '';
    if (m) {
      const n = +m[1];
      context =
        '\n' +
        source
          .split('\n')
          .map((line, i) => ({ line, n: i + 1 }))
          .filter((l) => Math.abs(l.n - n) <= 2)
          .map((l) => `${l.n === n ? '>' : ' '} ${String(l.n).padStart(4)} | ${l.line}`)
          .join('\n');
    }
    throw new Error(`Shader compile failed: ${log.trim()}${context}`);
  }
  return sh;
}

/**
 * program(gl, fragmentSource, vertexSource?) → a linked program wrapper.
 * The default vertex shader draws a full-screen triangle and provides `in vec2 vUv` (0..1).
 * Fragment sources must start with `#version 300 es` and declare their own precision.
 *
 *   const p = program(gl, fs);
 *   p.use();
 *   p.f('uTime', t); p.i('uFrame', n); p.v2('uRes', w, h); p.v3('uEye', x, y, z); p.v4(...);
 *   p.fv('uArray', float32Array, 3);   // 3 = components per element
 *   p.m3('uM', mat3); p.m4('uM', mat4);
 *   p.tex('uTex', texture, 0);
 */
export function program(gl, fragmentSource, vertexSource = FULLSCREEN_VS) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const handle = gl.createProgram();
  gl.attachShader(handle, vs);
  gl.attachShader(handle, fs);
  gl.linkProgram(handle);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(handle);
    gl.deleteProgram(handle);
    throw new Error(`Program link failed: ${log}`);
  }
  const locs = new Map();
  const loc = (name) => {
    if (!locs.has(name)) locs.set(name, gl.getUniformLocation(handle, name));
    return locs.get(name);
  };
  return {
    handle,
    loc,
    use() {
      gl.useProgram(handle);
      return this;
    },
    f(name, x) {
      gl.uniform1f(loc(name), x);
      return this;
    },
    i(name, x) {
      gl.uniform1i(loc(name), x);
      return this;
    },
    v2(name, x, y) {
      gl.uniform2f(loc(name), x, y);
      return this;
    },
    v3(name, x, y, z) {
      gl.uniform3f(loc(name), x, y, z);
      return this;
    },
    v4(name, x, y, z, w) {
      gl.uniform4f(loc(name), x, y, z, w);
      return this;
    },
    fv(name, array, components = 1) {
      const l = loc(name);
      if (components === 1) gl.uniform1fv(l, array);
      else if (components === 2) gl.uniform2fv(l, array);
      else if (components === 3) gl.uniform3fv(l, array);
      else gl.uniform4fv(l, array);
      return this;
    },
    m3(name, m) {
      gl.uniformMatrix3fv(loc(name), false, m);
      return this;
    },
    m4(name, m) {
      gl.uniformMatrix4fv(loc(name), false, m);
      return this;
    },
    tex(name, texture, unit = 0) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(loc(name), unit);
      return this;
    },
    dispose() {
      gl.deleteProgram(handle);
    },
  };
}

const vaos = new WeakMap();
/** Draw the full-screen triangle with the currently bound program. */
export function fullscreen(gl) {
  let vao = vaos.get(gl);
  if (!vao) {
    vao = gl.createVertexArray();
    vaos.set(gl, vao);
  }
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

const FORMATS = (gl) => ({
  rgba8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
  rgba16f: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
  rgba32f: [gl.RGBA32F, gl.RGBA, gl.FLOAT],
  rg16f: [gl.RG16F, gl.RG, gl.HALF_FLOAT],
  rg32f: [gl.RG32F, gl.RG, gl.FLOAT],
  r16f: [gl.R16F, gl.RED, gl.HALF_FLOAT],
  r32f: [gl.R32F, gl.RED, gl.FLOAT],
  r8: [gl.R8, gl.RED, gl.UNSIGNED_BYTE],
});

/**
 * texture(gl, w, h, { format = 'rgba8', filter = 'nearest' | 'linear', wrap = 'clamp' | 'repeat', data })
 * → WebGLTexture (immutable storage; pass `data` as the matching typed array to fill it).
 */
export function texture(gl, w, h, { format = 'rgba8', filter = 'nearest', wrap = 'clamp', data = null } = {}) {
  const [internal, fmt, type] = FORMATS(gl)[format];
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
  if (data) {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt, type, data);
  }
  const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
  const wr = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
  return tex;
}

/**
 * target(gl, w, h, opts) → { tex, fbo, w, h, bind(), dispose() } — a texture you can render into.
 * Same opts as texture(). Throws if the framebuffer is incomplete (format not renderable).
 * target.bind() binds the framebuffer and sets the viewport.
 */
export function target(gl, w, h, opts = {}) {
  const tex = texture(gl, w, h, opts);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    throw new Error(`Render target ${opts.format || 'rgba8'} ${w}×${h} is not renderable on this GPU`);
  }
  return {
    tex,
    fbo,
    w,
    h,
    bind() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
    },
    dispose() {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
    },
  };
}

/** Ping-pong pair: { read, write, swap(), dispose() } */
export function doubleTarget(gl, w, h, opts = {}) {
  let a = target(gl, w, h, opts);
  let b = target(gl, w, h, opts);
  return {
    get read() {
      return a;
    },
    get write() {
      return b;
    },
    w,
    h,
    swap() {
      [a, b] = [b, a];
    },
    dispose() {
      a.dispose();
      b.dispose();
    },
  };
}

/** Bind the canvas (default framebuffer) and set the viewport to its full backing size. */
export function toScreen(gl) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
}

/** onContextLoss(canvas, { lost(), restored() }) — pause on loss, rebuild GPU resources on restore. */
export function onContextLoss(canvas, { lost, restored } = {}) {
  const onLost = (e) => {
    e.preventDefault();
    if (lost) lost();
  };
  const onRestored = () => restored && restored();
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  return () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
  };
}
