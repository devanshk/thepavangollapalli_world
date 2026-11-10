// The scene is described once as plain data (scenes.js) and packed here into one row of RGBA
// float texels. The fragment shader reads those texels with texelFetch; mirror.js intersects the
// very same array in JavaScript, so a tap on the canvas and a ray on the GPU agree on what is hit.
//
// Texel layout (each texel is four floats):
//   header    [spheres, boxes, quads, materials] [lights, 0, 0, 0]
//   sphere    [centre.xyz, radius] [material, 0, 0, 0]
//   box       [centre.xyz, cos(rotY)] [halfSize.xyz, sin(rotY)] [material, 0, 0, 0]
//   quad      [normal.xyz, normal·centre] [centre.xyz, material] [u/|u|², oneSided] [v/|v|², 0]
//   material  [colour.rgb, type] [alpha, ior, tile size, tile shade]
//   light     [kind, primitive index, 0, 0]
import { cross, dot, length, normalize, scale } from './vec.js';

export const TEX_WIDTH = 512;
export const HEADER_TEXELS = 2;
export const STRIDE = { sphere: 2, box: 3, quad: 4, material: 2, light: 1 };
export const LIMITS = { spheres: 64, boxes: 8, quads: 12, materials: 32, lights: 8 };
export const MATERIAL_TYPES = ['diffuse', 'metal', 'glass', 'emissive', 'plastic'];
export const LIGHT_QUAD = 0;
export const LIGHT_SPHERE = 1;

/** First texel of every section for the given primitive counts. */
export function layout(counts) {
  const spheres = HEADER_TEXELS;
  const boxes = spheres + counts.spheres * STRIDE.sphere;
  const quads = boxes + counts.boxes * STRIDE.box;
  const materials = quads + counts.quads * STRIDE.quad;
  const lights = materials + counts.materials * STRIDE.material;
  const end = lights + counts.lights * STRIDE.light;
  return { spheres, boxes, quads, materials, lights, end };
}

/** Counts and section offsets of a packed scene. */
export function readHeader(data) {
  const counts = { spheres: data[0], boxes: data[1], quads: data[2], materials: data[3], lights: data[4] };
  return { counts, offsets: layout(counts) };
}

const put = (data, texel, x = 0, y = 0, z = 0, w = 0) => {
  data[texel * 4] = x;
  data[texel * 4 + 1] = y;
  data[texel * 4 + 2] = z;
  data[texel * 4 + 3] = w;
};

/**
 * Pack a scene description into a Float32Array of TEX_WIDTH RGBA texels.
 * Throws a plain-language error when the description is malformed or exceeds LIMITS.
 */
export function packScene(scene) {
  const names = Object.keys(scene.materials);
  const spheres = scene.spheres || [];
  const boxes = scene.boxes || [];
  const quads = scene.quads || [];
  const materialIndex = (name) => {
    const i = names.indexOf(name);
    if (i < 0) throw new Error(`Unknown material "${name}"`);
    return i;
  };
  const isEmissive = (name) => scene.materials[name] && scene.materials[name].type === 'emissive';

  const lights = [];
  quads.forEach((q, i) => isEmissive(q.mat) && lights.push([LIGHT_QUAD, i]));
  spheres.forEach((s, i) => isEmissive(s.mat) && lights.push([LIGHT_SPHERE, i]));
  if (boxes.some((b) => isEmissive(b.mat))) throw new Error('Boxes cannot be light sources');

  const counts = {
    spheres: spheres.length,
    boxes: boxes.length,
    quads: quads.length,
    materials: names.length,
    lights: lights.length,
  };
  for (const key of Object.keys(LIMITS))
    if (counts[key] > LIMITS[key]) throw new Error(`Too many ${key}: ${counts[key]} (limit ${LIMITS[key]})`);

  const at = layout(counts);
  const data = new Float32Array(TEX_WIDTH * 4);
  put(data, 0, counts.spheres, counts.boxes, counts.quads, counts.materials);
  put(data, 1, counts.lights);

  spheres.forEach((s, i) => {
    if (!(s.r > 0)) throw new Error('A sphere needs a positive radius');
    const t = at.spheres + i * STRIDE.sphere;
    put(data, t, s.c[0], s.c[1], s.c[2], s.r);
    put(data, t + 1, materialIndex(s.mat));
  });

  boxes.forEach((b, i) => {
    if (!(Math.min(b.h[0], b.h[1], b.h[2]) > 0)) throw new Error('A box needs positive half-sizes');
    const t = at.boxes + i * STRIDE.box;
    const angle = b.rotY || 0;
    put(data, t, b.c[0], b.c[1], b.c[2], Math.cos(angle));
    put(data, t + 1, b.h[0], b.h[1], b.h[2], Math.sin(angle));
    put(data, t + 2, materialIndex(b.mat));
  });

  quads.forEach((q, i) => {
    const lu = length(q.u);
    const lv = length(q.v);
    if (!(lu > 0 && lv > 0)) throw new Error('A quad needs two non-zero edges');
    if (Math.abs(dot(q.u, q.v)) > 1e-6 * lu * lv) throw new Error('Quad edges must be perpendicular');
    const n = normalize(cross(q.u, q.v));
    const ui = scale(q.u, 1 / (lu * lu));
    const vi = scale(q.v, 1 / (lv * lv));
    const t = at.quads + i * STRIDE.quad;
    put(data, t, n[0], n[1], n[2], dot(n, q.c));
    put(data, t + 1, q.c[0], q.c[1], q.c[2], materialIndex(q.mat));
    put(data, t + 2, ui[0], ui[1], ui[2], q.oneSided ? 1 : 0);
    put(data, t + 3, vi[0], vi[1], vi[2]);
  });

  names.forEach((name, i) => {
    const m = scene.materials[name];
    const type = MATERIAL_TYPES.indexOf(m.type);
    if (type < 0) throw new Error(`Unknown material type "${m.type}"`);
    const roughness = m.roughness || 0;
    const t = at.materials + i * STRIDE.material;
    const [tileSize, tileShade] = m.tiles || [0, 1];
    put(data, t, m.color[0], m.color[1], m.color[2], type);
    put(data, t + 1, roughness * roughness, m.ior || 1.5, tileSize, tileShade);
  });

  lights.forEach(([kind, index], i) => put(data, at.lights + i, kind, index));
  return data;
}

/** Inverse of packScene. Materials come back as an array and are referenced by index. */
export function unpackScene(data) {
  const { counts, offsets: at } = readHeader(data);
  const texel = (t) => [data[t * 4], data[t * 4 + 1], data[t * 4 + 2], data[t * 4 + 3]];
  const xyz = (t) => texel(t).slice(0, 3);
  const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

  return {
    spheres: range(counts.spheres, (i) => {
      const t = at.spheres + i * STRIDE.sphere;
      return { c: xyz(t), r: texel(t)[3], mat: texel(t + 1)[0] };
    }),
    boxes: range(counts.boxes, (i) => {
      const t = at.boxes + i * STRIDE.box;
      return { c: xyz(t), h: xyz(t + 1), rotY: Math.atan2(texel(t + 1)[3], texel(t)[3]), mat: texel(t + 2)[0] };
    }),
    quads: range(counts.quads, (i) => {
      const t = at.quads + i * STRIDE.quad;
      const ui = xyz(t + 2);
      const vi = xyz(t + 3);
      return {
        c: xyz(t + 1),
        u: scale(ui, 1 / dot(ui, ui)),
        v: scale(vi, 1 / dot(vi, vi)),
        mat: texel(t + 1)[3],
        oneSided: texel(t + 2)[3] > 0.5,
      };
    }),
    materials: range(counts.materials, (i) => {
      const t = at.materials + i * STRIDE.material;
      const [alpha, ior, tileSize, tileShade] = texel(t + 1);
      return { type: MATERIAL_TYPES[texel(t)[3]], color: xyz(t), roughness: Math.sqrt(alpha), ior, tiles: [tileSize, tileShade] };
    }),
    lights: range(counts.lights, (i) => {
      const [kind, index] = texel(at.lights + i);
      return { kind, index };
    }),
  };
}
