// GLSL surface scattering. Directions are in the local frame where z is the shading normal,
// wo points back along the path and wi toward the next vertex. optics.js mirrors the formulas.

export const BSDF = `
float schlick(float f0, float c) {
  float m = clamp(1.0 - c, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}

vec3 schlick(vec3 f0, float c) {
  float m = clamp(1.0 - c, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}

float f0FromIor(float ior) {
  float r = (ior - 1.0) / (ior + 1.0);
  return r * r;
}

// Unpolarised Fresnel reflectance of a dielectric boundary; eta = n_incident / n_transmitted.
float fresnelDielectric(float cosI, float cosT, float eta) {
  float rs = (eta * cosI - cosT) / max(eta * cosI + cosT, 1e-8);
  float rp = (cosI - eta * cosT) / max(cosI + eta * cosT, 1e-8);
  return 0.5 * (rs * rs + rp * rp);
}

float ggxD(float nh, float alpha) {
  float a2 = alpha * alpha;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-20);
}

float ggxLambda(float c, float alpha) {
  float c2 = max(c * c, 1e-8);
  return 0.5 * (sqrt(1.0 + alpha * alpha * (1.0 - c2) / c2) - 1.0);
}

// A microfacet normal drawn from the distribution of normals visible from wo (Heitz 2018).
vec3 sampleGgxVndf(vec3 wo, float alpha, vec2 u) {
  vec3 vh = normalize(vec3(alpha * wo.x, alpha * wo.y, wo.z));
  float len2 = vh.x * vh.x + vh.y * vh.y;
  vec3 t1 = len2 > 1e-12 ? vec3(-vh.y, vh.x, 0.0) * inversesqrt(len2) : vec3(1.0, 0.0, 0.0);
  vec3 t2 = cross(vh, t1);
  float r = sqrt(u.x);
  float phi = TAU * u.y;
  float p1 = r * cos(phi);
  float s = 0.5 * (1.0 + vh.z);
  float p2 = (1.0 - s) * sqrt(max(0.0, 1.0 - p1 * p1)) + s * r * sin(phi);
  vec3 nh = p1 * t1 + p2 * t2 + sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2)) * vh;
  return normalize(vec3(alpha * nh.x, alpha * nh.y, max(1e-6, nh.z)));
}

// Probability of choosing the glossy coat (rather than the diffuse base) of a plastic surface.
float coatProbability(Material m, float cosO) {
  float f = schlick(f0FromIor(m.ior), cosO);
  return clamp(f / max(f + (1.0 - f) * maxc(m.color), 1e-6), 0.1, 0.9);
}

// BSDF times cos(theta_i) for a pair of directions, and the density with which sampleBsdf
// produces wi. Mirror-smooth metal and glass are delta lobes and never reach this function.
vec3 evalBsdf(Material m, vec3 wo, vec3 wi, out float pdf) {
  pdf = 0.0;
  if (wo.z <= 0.0 || wi.z <= 0.0) return vec3(0.0);
  if (m.type == DIFFUSE) {
    pdf = wi.z * INV_PI;
    return m.color * (wi.z * INV_PI);
  }
  vec3 h = normalize(wo + wi);
  float d = ggxD(h.z, m.alpha);
  float lo = ggxLambda(wo.z, m.alpha);
  float li = ggxLambda(wi.z, m.alpha);
  float cosO = max(wo.z, 1e-4);
  float pdfGloss = d / ((1.0 + lo) * 4.0 * cosO);
  // D * G2 / (4 cos_o cos_i) * cos_i, with the height-correlated Smith G2
  float gloss = d / ((1.0 + lo + li) * 4.0 * cosO);
  float oh = dot(wo, h);
  if (m.type == METAL) {
    pdf = pdfGloss;
    return schlick(m.color, oh) * gloss;
  }
  // Plastic: a dielectric GGX coat over a diffuse base (Ashikhmin-Shirley coupling, which is
  // reciprocal and never reflects more than it receives).
  float f0 = f0FromIor(m.ior);
  float coat = coatProbability(m, wo.z);
  pdf = coat * pdfGloss + (1.0 - coat) * wi.z * INV_PI;
  float ko = 1.0 - 0.5 * wo.z;
  float ki = 1.0 - 0.5 * wi.z;
  float ko2 = ko * ko;
  float ki2 = ki * ki;
  float base = (28.0 / (23.0 * PI)) * (1.0 - f0) * (1.0 - ko2 * ko2 * ko) * (1.0 - ki2 * ki2 * ki);
  return vec3(schlick(f0, oh) * gloss) + m.color * (base * wi.z);
}

// Draw wi for the next segment. weight = BSDF * cos / pdf. Returns false when the path ends.
bool sampleBsdf(Material m, vec3 wo, out vec3 wi, out vec3 weight, out float pdf, out bool isDelta) {
  wi = vec3(0.0, 0.0, 1.0);
  weight = vec3(0.0);
  pdf = 0.0;
  isDelta = false;
  if (m.type == METAL && m.alpha < MIRROR_ALPHA) {
    wi = vec3(-wo.x, -wo.y, wo.z);
    weight = schlick(m.color, wo.z);
    pdf = 1.0;
    isDelta = true;
    return true;
  }
  bool gloss = m.type == METAL;
  if (m.type == PLASTIC) gloss = rnd() < coatProbability(m, wo.z);
  vec2 u = rnd2();
  if (gloss) wi = reflect(-wo, sampleGgxVndf(wo, m.alpha, u));
  else wi = cosineHemisphere(u);
  if (wi.z <= 0.0) return false;
  vec3 f = evalBsdf(m, wo, wi, pdf);
  if (pdf <= 1e-12) return false;
  weight = f / pdf;
  return true;
}
`;
