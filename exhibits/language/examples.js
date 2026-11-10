// Example programs, written in Sable. Each one shows a different corner of the language.

const RAYTRACER = `// A ray tracer. Three spheres on a checkered floor, one orbiting light,
// hard shadows, and a mirror ball. Every pixel of every frame is computed
// by this program, compiled to WebAssembly in your browser as you type.

array sx: float[3];
array sy: float[3];
array sz: float[3];
array sr: float[3];

// What the last trace() struck: a sphere index, -1 for the floor, -2 for sky.
var hit: int = 0;
// The colour computed by the last shade().
var cr: float = 0.0;
var cg: float = 0.0;
var cb: float = 0.0;

// Distance along a ray to sphere i, or -1.0 if the ray misses it.
fn sphere(ox: float, oy: float, oz: float, dx: float, dy: float, dz: float, i: int) -> float {
  let lx = ox - sx[i];
  let ly = oy - sy[i];
  let lz = oz - sz[i];
  let b = lx * dx + ly * dy + lz * dz;
  let c = lx * lx + ly * ly + lz * lz - sr[i] * sr[i];
  let disc = b * b - c;
  if disc < 0.0 { return -1.0; }
  let t = -b - sqrt(disc);
  if t > 0.001 { return t; }
  return -1.0;
}

// The nearest thing along a ray. Returns its distance and records it in "hit".
fn trace(ox: float, oy: float, oz: float, dx: float, dy: float, dz: float) -> float {
  var best = 1.0e9;
  hit = -2;
  for i in 0..3 {
    let t = sphere(ox, oy, oz, dx, dy, dz, i);
    if t > 0.0 && t < best { best = t; hit = i; }
  }
  if dy < -0.0001 {
    let t = -(oy + 1.0) / dy;
    if t > 0.001 && t < best { best = t; hit = -1; }
  }
  return best;
}

fn shade(ox: float, oy: float, oz: float, dx: float, dy: float, dz: float,
         lx: float, ly: float, lz: float, bounces: int) {
  let d = trace(ox, oy, oz, dx, dy, dz);
  let what = hit;
  if what == -2 {
    let k = 0.5 + 0.5 * dy;
    cr = 0.10 + 0.25 * k; cg = 0.13 + 0.35 * k; cb = 0.22 + 0.55 * k;
    return;
  }
  let px = ox + dx * d;
  let py = oy + dy * d;
  let pz = oz + dz * d;
  var nx = 0.0; var ny = 1.0; var nz = 0.0;
  var r = 0.92; var g = 0.92; var b = 0.92;
  if what == -1 {
    if ((int(floor(px)) + int(floor(pz))) & 1) == 0 { r = 0.25; g = 0.27; b = 0.30; }
  } else {
    nx = (px - sx[what]) / sr[what];
    ny = (py - sy[what]) / sr[what];
    nz = (pz - sz[what]) / sr[what];
    if what == 0 { r = 0.95; g = 0.35; b = 0.25; }
    if what == 2 { r = 0.30; g = 0.55; b = 0.95; }
  }
  if what == 1 && bounces > 0 {
    // the middle sphere is a mirror: follow the reflected ray
    let k = 2.0 * (dx * nx + dy * ny + dz * nz);
    shade(px + nx * 0.001, py + ny * 0.001, pz + nz * 0.001,
          dx - k * nx, dy - k * ny, dz - k * nz, lx, ly, lz, bounces - 1);
    cr = 0.06 + 0.86 * cr; cg = 0.06 + 0.86 * cg; cb = 0.06 + 0.86 * cb;
    return;
  }
  var tx = lx - px; var ty = ly - py; var tz = lz - pz;
  let dist = sqrt(tx * tx + ty * ty + tz * tz);
  tx = tx / dist; ty = ty / dist; tz = tz / dist;
  var diffuse = max(0.0, nx * tx + ny * ty + nz * tz);
  if diffuse > 0.0 {
    let s = trace(px + nx * 0.001, py + ny * 0.001, pz + nz * 0.001, tx, ty, tz);
    if hit != -2 && s < dist { diffuse = 0.0; }
  }
  let lightness = 0.16 + 0.84 * diffuse;
  cr = r * lightness; cg = g * lightness; cb = b * lightness;
}

fn frame(t: float) {
  sx[0] = -1.9; sy[0] = -0.3 + 0.5 * abs(sin(t * 1.9)); sz[0] = -0.4; sr[0] = 0.7;
  sx[1] = 0.0;  sy[1] = 0.0;  sz[1] = -1.2; sr[1] = 1.0;
  sx[2] = 1.8;  sy[2] = -0.45; sz[2] = 0.2;  sr[2] = 0.55;
  let lx = 5.0 * cos(t * 0.6);
  let ly = 6.0;
  let lz = 5.0 * sin(t * 0.6) + 2.0;
  let w = width();
  let h = height();
  for py in 0..h {
    for px in 0..w {
      var dx = (float(px) + 0.5 - float(w) * 0.5) / float(h);
      var dy = (float(h) * 0.5 - float(py) - 0.5) / float(h) - 0.18;
      var dz = -1.25;
      let n = sqrt(dx * dx + dy * dy + dz * dz);
      dx = dx / n; dy = dy / n; dz = dz / n;
      shade(0.0, 0.9, 4.6, dx, dy, dz, lx, ly, lz, 2);
      // a square root is a cheap gamma curve
      pixel(px, py, int(255.0 * sqrt(cr)), int(255.0 * sqrt(cg)), int(255.0 * sqrt(cb)));
    }
  }
}
`;

const PLASMA = `// Plasma: four sine waves summed at every pixel, sixty times a second.
// Change a number and the picture changes as you type.

fn frame(t: float) {
  let w = width();
  let h = height();
  for y in 0..h {
    for x in 0..w {
      let u = float(x) / float(w) * 6.0;
      let v = float(y) / float(h) * 4.0;
      var s = sin(u + t);
      s += sin(v * 1.3 - t * 0.7);
      s += sin((u + v) * 0.8 + t * 0.5);
      let cx = u - 3.0 + 1.5 * sin(t * 0.3);
      let cy = v - 2.0 + 1.5 * cos(t * 0.4);
      s += sin(sqrt(cx * cx + cy * cy + 1.0) * 2.0 - t);
      let r = int(128.0 + 127.0 * sin(s * 1.6));
      let g = int(128.0 + 127.0 * sin(s * 1.6 + 2.1));
      let b = int(128.0 + 127.0 * sin(s * 1.6 + 4.2));
      pixel(x, y, r, g, b);
    }
  }
}
`;

const MANDELBROT = `// The Mandelbrot set, with smooth colouring and a slow dive toward
// a spiral near the edge. Up to 96 iterations per pixel, every frame.

const MAX_ITER = 96;

fn shade(n: float, phase: float) -> int {
  return int(127.5 + 127.5 * cos(6.2831853 * (n * 0.021 + phase)));
}

fn frame(t: float) {
  let w = width();
  let h = height();
  let zoom = 1.6 * exp(-2.2 * (1.0 - cos(t * 0.15)));
  let cx = -0.743643887;
  let cy = 0.131825904;
  for py in 0..h {
    for px in 0..w {
      let x0 = cx + (float(px) / float(w) - 0.5) * 3.0 * zoom;
      let y0 = cy + (float(py) / float(h) - 0.5) * 2.0 * zoom;
      var x = 0.0;
      var y = 0.0;
      var i = 0;
      while i < MAX_ITER && x * x + y * y < 64.0 {
        let next = x * x - y * y + x0;
        y = 2.0 * x * y + y0;
        x = next;
        i += 1;
      }
      if i == MAX_ITER {
        pixel(px, py, 8, 6, 16);
      } else {
        // a fractional iteration count removes the colour bands
        let n = float(i) + 1.0 - log(log(x * x + y * y) * 0.5) / 0.6931472;
        pixel(px, py, shade(n, 0.0), shade(n, 0.1), shade(n, 0.2));
      }
    }
  }
}
`;

const LIFE = `// Conway's Game of Life on a grid that wraps at the edges. The cells live
// in two arrays in linear memory; cells born this generation are drawn brighter.

const W = 240;
const H = 160;
array cells: int[W * H];
array next: int[W * H];
var seed: int = 20260;
var age: int = 0;

fn random() -> int {
  seed = seed * 1103515245 + 12345;
  return (seed >> 16) & 32767;
}

fn at(x: int, y: int) -> int {
  return cells[((y + H) % H) * W + (x + W) % W];
}

fn frame(t: float) {
  if age % 900 == 0 {
    for i in 0..len(cells) {
      cells[i] = if random() % 100 < 30 { 1 } else { 0 };
    }
  }
  age += 1;
  for y in 0..H {
    for x in 0..W {
      let n = at(x - 1, y - 1) + at(x, y - 1) + at(x + 1, y - 1)
            + at(x - 1, y) + at(x + 1, y)
            + at(x - 1, y + 1) + at(x, y + 1) + at(x + 1, y + 1);
      let alive = cells[y * W + x] == 1;
      next[y * W + x] = if n == 3 || (alive && n == 2) { 1 } else { 0 };
    }
  }
  for i in 0..len(cells) {
    let born = next[i] == 1 && cells[i] == 0;
    cells[i] = next[i];
    if cells[i] == 0 {
      pixel(i % W, i / W, 10, 14, 12);
    } else if born {
      pixel(i % W, i / W, 255, 240, 200);
    } else {
      pixel(i % W, i / W, 182, 227, 116);
    }
  }
}
`;

const PRIMES = `// The sieve of Eratosthenes: cross out the multiples of every prime.
// What is left below one million is counted and printed.

const LIMIT = 1000000;
array crossed: int[LIMIT];

fn main() {
  var count = 0;
  var largest = 0;
  for n in 2..LIMIT {
    if crossed[n] == 0 {
      count += 1;
      largest = n;
      var m = n * 2;
      while m < LIMIT {
        crossed[m] = 1;
        m += n;
      }
    }
  }
  print(count);    // 78498 primes below one million
  print(largest);  // the largest is 999983
}
`;

const QUEENS = `// In how many ways can N queens stand on an N-by-N board so that none
// attacks another? A recursive search over bit masks. Press "Race both
// back ends" to time the compiled WebAssembly against the interpreter.

const N = 11;

fn solve(cols: int, left: int, right: int, full: int) -> int {
  if cols == full { return 1; }
  var count = 0;
  var free = ~(cols | left | right) & full;
  while free != 0 {
    let bit = free & -free;       // the lowest free square in this row
    free = free ^ bit;
    count += solve(cols | bit, (left | bit) << 1, (right | bit) >> 1, full);
  }
  return count;
}

fn main() {
  print(solve(0, 0, 0, (1 << N) - 1));  // 2680 for N = 11
}
`;

export const EXAMPLES = [
  { id: 'raytracer', name: 'Ray tracer', source: RAYTRACER },
  { id: 'plasma', name: 'Plasma', source: PLASMA },
  { id: 'mandelbrot', name: 'Mandelbrot dive', source: MANDELBROT },
  { id: 'life', name: 'Game of Life', source: LIFE },
  { id: 'primes', name: 'Prime sieve', source: PRIMES },
  { id: 'queens', name: 'N queens', source: QUEENS },
];
