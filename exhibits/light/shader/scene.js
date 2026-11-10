// GLSL ray–scene intersection, material look-up and light sampling. mirror.js repeats the three
// intersection routines in JavaScript, formula for formula.

export const SCENE = `
struct Hit {
  float t;
  vec3 n;      // geometric normal, pointing out of the surface
  int mat;
  int kind;    // 1 sphere, 2 box, 3 quad
  int index;
};

struct Material {
  int type;
  vec3 color;
  float alpha;
  float ior;
};

struct LightSample {
  vec3 wi;
  float dist;
  vec3 radiance;
  float pdf;   // density over solid angle, including the choice of light
};

vec4 texel(int i) { return texelFetch(uScene, ivec2(i, 0), 0); }

// Material at a surface point. A tiled material darkens every other square of a horizontal
// checkerboard: b.z is the tile size, b.w the factor applied to the darker tiles.
Material material(int id, vec3 p) {
  int at = uOffsets.z + id * MATERIAL_STRIDE;
  vec4 a = texel(at);
  vec4 b = texel(at + 1);
  vec3 color = a.rgb;
  if (b.z > 0.0) {
    vec2 cell = floor(p.xz / b.z);
    if (mod(cell.x + cell.y, 2.0) > 0.5) color *= b.w;
  }
  return Material(int(a.w + 0.5), color, b.x, b.y);
}

// Emitted radiance of a light's material (lights are never tiled).
vec3 emission(int id) { return texel(uOffsets.z + id * MATERIAL_STRIDE).rgb; }

float hitSphere(vec3 ro, vec3 rd, vec4 s) {
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd);
  // distance from the centre to the ray, computed without the cancellation of b*b - c
  vec3 q = oc - b * rd;
  float h = s.w * s.w - dot(q, q);
  if (h < 0.0) return INF;
  h = sqrt(h);
  float t = -b - h;
  if (t < T_MIN) t = -b + h;
  return t < T_MIN ? INF : t;
}

vec3 safeInverse(vec3 d) {
  vec3 s = vec3(d.x < 0.0 ? -1.0 : 1.0, d.y < 0.0 ? -1.0 : 1.0, d.z < 0.0 ? -1.0 : 1.0);
  return s / max(abs(d), vec3(1e-8));
}

// Slab test in the frame of a box rotated about the vertical axis.
// a = [centre, cos], b = [half size, sin].
float hitBox(vec3 ro, vec3 rd, vec4 a, vec4 b, out vec3 n) {
  n = vec3(0.0, 1.0, 0.0);
  float cs = a.w;
  float sn = b.w;
  vec3 oc = ro - a.xyz;
  vec3 o = vec3(cs * oc.x - sn * oc.z, oc.y, sn * oc.x + cs * oc.z);
  vec3 d = vec3(cs * rd.x - sn * rd.z, rd.y, sn * rd.x + cs * rd.z);
  vec3 inv = safeInverse(d);
  vec3 t0 = (-b.xyz - o) * inv;
  vec3 t1 = (b.xyz - o) * inv;
  vec3 lo = min(t0, t1);
  vec3 hi = max(t0, t1);
  float tNear = max(lo.x, max(lo.y, lo.z));
  float tFar = min(hi.x, min(hi.y, hi.z));
  if (tNear > tFar || tFar < T_MIN) return INF;
  vec3 dirSign = vec3(d.x > 0.0 ? 1.0 : -1.0, d.y > 0.0 ? 1.0 : -1.0, d.z > 0.0 ? 1.0 : -1.0);
  vec3 local = vec3(0.0);
  float t = tNear;
  if (tNear >= T_MIN) {
    if (lo.x >= lo.y && lo.x >= lo.z) local.x = -dirSign.x;
    else if (lo.y >= lo.z) local.y = -dirSign.y;
    else local.z = -dirSign.z;
  } else {
    t = tFar;
    if (hi.x <= hi.y && hi.x <= hi.z) local.x = dirSign.x;
    else if (hi.y <= hi.z) local.y = dirSign.y;
    else local.z = dirSign.z;
  }
  n = vec3(cs * local.x + sn * local.z, local.y, -sn * local.x + cs * local.z);
  return t;
}

// Rectangle starting at texel q. A one-sided quad is invisible from behind.
float hitQuad(vec3 ro, vec3 rd, int q, float tMax) {
  vec4 plane = texel(q);
  float denom = dot(rd, plane.xyz);
  if (abs(denom) < 1e-7) return INF;
  float t = (plane.w - dot(ro, plane.xyz)) / denom;
  if (t < T_MIN || t >= tMax) return INF;
  vec4 u = texel(q + 2);
  if (u.w > 0.5 && denom > 0.0) return INF;
  vec3 p = ro + rd * t - texel(q + 1).xyz;
  if (abs(dot(p, u.xyz)) > 1.0 || abs(dot(p, texel(q + 3).xyz)) > 1.0) return INF;
  return t;
}

bool closestHit(vec3 ro, vec3 rd, out Hit hit) {
  float best = INF;
  int kind = 0;
  int index = 0;
  vec3 normal = vec3(0.0, 1.0, 0.0);
  for (int i = 0; i < MAX_SPHERES; i++) {
    if (i >= uCounts.x) break;
    float t = hitSphere(ro, rd, texel(SPHERES + i * SPHERE_STRIDE));
    if (t < best) {
      best = t;
      kind = 1;
      index = i;
    }
  }
  for (int i = 0; i < MAX_BOXES; i++) {
    if (i >= uCounts.y) break;
    int b = uOffsets.x + i * BOX_STRIDE;
    vec3 n = vec3(0.0);
    float t = hitBox(ro, rd, texel(b), texel(b + 1), n);
    if (t < best) {
      best = t;
      kind = 2;
      index = i;
      normal = n;
    }
  }
  for (int i = 0; i < MAX_QUADS; i++) {
    if (i >= uCounts.z) break;
    float t = hitQuad(ro, rd, uOffsets.y + i * QUAD_STRIDE, best);
    if (t < best) {
      best = t;
      kind = 3;
      index = i;
    }
  }
  int mat = 0;
  if (kind == 1) {
    int s = SPHERES + index * SPHERE_STRIDE;
    vec4 sphere = texel(s);
    normal = (ro + rd * best - sphere.xyz) / sphere.w;
    mat = int(texel(s + 1).x + 0.5);
  } else if (kind == 2) {
    mat = int(texel(uOffsets.x + index * BOX_STRIDE + 2).x + 0.5);
  } else if (kind == 3) {
    int q = uOffsets.y + index * QUAD_STRIDE;
    normal = texel(q).xyz;
    mat = int(texel(q + 1).w + 0.5);
  }
  hit = Hit(best, normal, mat, kind, index);
  return kind != 0;
}

// Shadow ray: is anything in the way before tMax? Glass counts as opaque here; light that
// reaches a surface through glass is found by BSDF sampling instead.
bool occluded(vec3 ro, vec3 rd, float tMax) {
  for (int i = 0; i < MAX_SPHERES; i++) {
    if (i >= uCounts.x) break;
    if (hitSphere(ro, rd, texel(SPHERES + i * SPHERE_STRIDE)) < tMax) return true;
  }
  for (int i = 0; i < MAX_BOXES; i++) {
    if (i >= uCounts.y) break;
    int b = uOffsets.x + i * BOX_STRIDE;
    vec3 n = vec3(0.0);
    if (hitBox(ro, rd, texel(b), texel(b + 1), n) < tMax) return true;
  }
  for (int i = 0; i < MAX_QUADS; i++) {
    if (i >= uCounts.z) break;
    if (hitQuad(ro, rd, uOffsets.y + i * QUAD_STRIDE, tMax) < tMax) return true;
  }
  return false;
}

/* Lights: emissive quads and spheres, plus the sun when there is a sky. One is picked uniformly. */

// The stored edges are u/|u|^2 and v/|v|^2, so the area 4|u||v| is 4 / (|u'||v'|).
float quadArea(vec3 ui, vec3 vi) { return 4.0 * inversesqrt(dot(ui, ui) * dot(vi, vi)); }

// 1 - cos of the half angle a sphere subtends from a point outside it.
float sphereCone(vec3 from, vec4 s) {
  vec3 dc = s.xyz - from;
  float sin2 = min(s.w * s.w / max(dot(dc, dc), 1e-12), 1.0);
  return sin2 / (1.0 + sqrt(1.0 - sin2));
}

float sunPdf(float lightCount) { return 1.0 / (TAU * uSunCone.y * lightCount); }

// Density with which sampleLight would have produced the direction that found this emitter.
float emitterPdf(Hit hit, vec3 ro, vec3 rd, float lightCount) {
  if (hit.kind == 3) {
    int q = uOffsets.y + hit.index * QUAD_STRIDE;
    float cosL = max(abs(dot(rd, hit.n)), 1e-6);
    return hit.t * hit.t / (cosL * quadArea(texel(q + 2).xyz, texel(q + 3).xyz) * lightCount);
  }
  if (hit.kind == 1) {
    return 1.0 / (TAU * max(sphereCone(ro, texel(SPHERES + hit.index * SPHERE_STRIDE)), 1e-12) * lightCount);
  }
  return 0.0;
}

bool sampleLight(vec3 p, float lightCount, out LightSample ls) {
  ls = LightSample(vec3(0.0, 1.0, 0.0), 0.0, vec3(0.0), 0.0);
  int pick = min(int(rnd() * lightCount), int(lightCount) - 1);
  vec2 u = rnd2();
  if (pick >= uCounts.w) {
    ls.wi = sampleCone(uSunDir, uSunCone.y, u);
    ls.dist = INF;
    ls.radiance = uSunRadiance;
    ls.pdf = sunPdf(lightCount);
    return true;
  }
  vec4 light = texel(uOffsets.w + pick);
  int index = int(light.y + 0.5);
  if (light.x < 0.5) {
    int q = uOffsets.y + index * QUAD_STRIDE;
    vec4 centre = texel(q + 1);
    vec3 ui = texel(q + 2).xyz;
    vec3 vi = texel(q + 3).xyz;
    vec3 onLight = centre.xyz + (2.0 * u.x - 1.0) * ui / dot(ui, ui) + (2.0 * u.y - 1.0) * vi / dot(vi, vi);
    vec3 d = onLight - p;
    float d2 = dot(d, d);
    if (d2 < 1e-10) return false;
    vec3 wi = d * inversesqrt(d2);
    float cosL = -dot(wi, texel(q).xyz);
    if (cosL < 1e-5) return false;
    ls.wi = wi;
    ls.dist = sqrt(d2);
    ls.radiance = emission(int(centre.w + 0.5));
    ls.pdf = d2 / (cosL * quadArea(ui, vi) * lightCount);
    return true;
  }
  int s = SPHERES + index * SPHERE_STRIDE;
  vec4 sphere = texel(s);
  vec3 dc = sphere.xyz - p;
  float d2 = dot(dc, dc);
  if (d2 <= sphere.w * sphere.w * 1.0001) return false;
  float oneMinusCos = sphereCone(p, sphere);
  vec3 wi = sampleCone(dc * inversesqrt(d2), oneMinusCos, u);
  float t = hitSphere(p, wi, sphere);
  ls.wi = wi;
  ls.dist = t < INF ? t : dot(dc, wi);
  ls.radiance = emission(int(texel(s + 1).x + 0.5));
  ls.pdf = 1.0 / (TAU * oneMinusCos * lightCount);
  return true;
}
`;
