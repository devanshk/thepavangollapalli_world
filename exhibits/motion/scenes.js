// scenes.js — the five demonstration scenes. Pure: builds worlds, never touches the DOM.
// Every scene is laid out from the view's aspect ratio, so it fills a wide desktop stage and a
// tall phone stage alike, and every random choice comes from a seeded generator.
import { rng } from '../../assets/js/kit.js';
import { World, DT, STATIC, KINEMATIC } from './world.js';
import { RevoluteJoint, DistanceJoint } from './joints.js';

/** Metres of ground shown below the floor line (y = 0). */
export const GROUND = 0.6;

const TAU = Math.PI * 2;

/** One random convex shape of roughly `size` metres in radius. */
export function randomShape(world, rnd, x, y, size, opts = {}) {
  const o = Object.assign({ angle: rnd.range(0, TAU), color: rnd.int(6), restitution: 0.15 }, opts);
  const kind = rnd.int(5);
  if (kind === 0) return world.addCircle(x, y, size, o);
  if (kind === 1) return world.addBox(x, y, size * 1.9, size * rnd.range(1.1, 1.9), o);
  const sides = kind === 2 ? 3 : kind === 3 ? 5 : 6;
  const r = size * (sides === 3 ? 1.35 : 1.1);
  const pts = [];
  for (let k = 0; k < sides; k++) pts.push(r * Math.cos((k / sides) * TAU), r * Math.sin((k / sides) * TAU));
  return world.addPolygon(x, y, pts, o);
}

/** Floor, side walls and ceiling just outside the visible area, thick enough that nothing tunnels out. */
function addBounds(world, W, top) {
  const o = { type: STATIC, hidden: true, friction: 0.6 };
  world.addBox(W / 2, -2, W + 8, 4, o);
  world.addBox(-2, top / 2, 4, top + 12, o);
  world.addBox(W + 2, top / 2, 4, top + 12, o);
  world.addBox(W / 2, top + 2, W + 8, 4, o);
}

function pyramid(world, v) {
  const rows = 12;
  const pitch = 1.07;
  for (let r = 0; r < rows; r++) {
    const n = rows - r;
    for (let i = 0; i < n; i++) {
      world.addBox(v.W / 2 + (i - (n - 1) / 2) * pitch, 0.5 + r, 1, 1, { color: r % 6, friction: 0.6 });
    }
  }
  if (!v.tall) world.addCircle(2.8, 0.7, 0.7, { color: 4, density: 2, friction: 0.6, restitution: 0.2 });
}

function wrecking(world, v) {
  const bw = v.tall ? 1 : 1.2;
  const bh = bw / 2;
  const cols = v.tall ? 4 : 5;
  const rows = 12;
  const right = v.W - (v.tall ? 1.2 : 3);
  const left = right - cols * bw;
  const brick = (x, y, w, color) => world.addBox(x, y, w, bh, { color, friction: 0.6 });
  for (let r = 0; r < rows; r++) {
    const y = bh / 2 + r * bh;
    if (r % 2 === 0) {
      for (let i = 0; i < cols; i++) brick(left + (i + 0.5) * bw, y, bw, r % 3);
    } else {
      brick(left + bw / 4, y, bw / 2, r % 3);
      for (let i = 0; i < cols - 1; i++) brick(left + (i + 1) * bw, y, bw, r % 3);
      brick(right - bw / 4, y, bw / 2, r % 3);
    }
  }

  const R = v.tall ? 0.9 : 1.1;
  const ax = left - R - (v.tall ? 1.6 : 1.9);
  const ay = v.top - 0.9;
  const L = ay - (rows * bh * 0.5 + 0.4);
  const swing = Math.min(1.13, Math.asin(Math.min(0.99, (ax - R - 0.4) / L)));
  const dx = -Math.sin(swing);
  const dy = -Math.cos(swing);
  const chain = L - R;
  const n = Math.round(chain / 0.5);
  const link = chain / n;
  const bracket = world.addBox(ax, ay + 0.2, 0.9, 0.4, { type: STATIC });
  let prev = bracket;
  for (let i = 0; i < n; i++) {
    const body = world.addBox(ax + dx * link * (i + 0.5), ay + dy * link * (i + 0.5), link, 0.14, {
      angle: Math.atan2(dy, dx),
      density: 4,
    });
    world.addJoint(new RevoluteJoint(prev, body, ax + dx * link * i, ay + dy * link * i));
    prev = body;
  }
  const ball = world.addCircle(ax + dx * L, ay + dy * L, R, { density: 3, color: 4, friction: 0.4, restitution: 0.1 });
  const ex = ax + dx * chain;
  const ey = ay + dy * chain;
  world.addJoint(new RevoluteJoint(prev, ball, ex, ey));
  // The links are far lighter than the ball. A rope from the bracket to the ball carries the
  // load directly, so the chain cannot stretch however hard the ball pulls.
  world.addJoint(new DistanceJoint(bracket, ball, ax, ay, ex, ey, { rope: true, length: chain * 1.005, hidden: true }));
}

function bridge(world, v) {
  const bank = v.tall ? 2.4 : 5;
  const deck = v.tall ? 6 : 5;
  const thick = 0.22;
  const leftBank = world.addBox(bank / 2, deck / 2, bank, deck, { type: STATIC, friction: 0.6 });
  const rightBank = world.addBox(v.W - bank / 2, deck / 2, bank, deck, { type: STATIC, friction: 0.6 });
  const span = v.W - 2 * bank;
  const n = Math.round(span / (v.tall ? 0.92 : 1));
  const hinge = { lower: -0.9, upper: 0.9 };
  // The deck is hung along a shallow parabola, so it is a little longer than the gap it
  // crosses. A deck of exactly the span could only sag by stretching its hinges.
  const sag = 0.05 * span;
  const hx = (i) => bank + (i / n) * span;
  const hy = (i) => deck - thick / 2 - 4 * sag * (i / n) * (1 - i / n);
  let prev = leftBank;
  for (let i = 0; i < n; i++) {
    const dx = hx(i + 1) - hx(i);
    const dy = hy(i + 1) - hy(i);
    const plank = world.addBox(hx(i) + dx / 2, hy(i) + dy / 2, Math.hypot(dx, dy), thick, {
      angle: Math.atan2(dy, dx),
      density: 2,
      friction: 0.6,
    });
    world.addJoint(new RevoluteJoint(prev, plank, hx(i), hy(i), hinge));
    prev = plank;
  }
  world.addJoint(new RevoluteJoint(prev, rightBank, v.W - bank, deck - thick / 2, hinge));

  const rnd = rng(11);
  const drop = (y) => randomShape(world, rnd, bank + span * (0.15 + 0.7 * rnd()), y, rnd.range(0.32, 0.5));
  for (let k = 0; k < 4; k++) drop(deck + 2 + k * 1.6);
  const later = v.tall ? 7 : 12;
  let dropped = 0;
  return () => {
    if (dropped < later && world.stepCount > 0 && world.stepCount % 70 === 0) {
      drop(v.top - 1);
      dropped++;
    }
    return dropped < later;
  };
}

function hopper(world, v) {
  const cx = v.W / 2;
  // about five shape widths: narrower outlets let the shapes lock into a standing arch
  const gap = v.tall ? 2.3 : 2.6;
  const yTop = v.top - 1.6;
  const yNeck = v.top - (v.tall ? 5.6 : 5.8);
  const xOut = v.tall ? 0.7 : 4.2;
  const thick = 0.45;
  for (const side of [-1, 1]) {
    const x1 = cx + side * (cx - xOut);
    const x2 = cx + (side * gap) / 2;
    world.addPolygon(0, 0, [x1, yTop, x2, yNeck, x2, yNeck - thick, x1, yTop - thick], { type: STATIC, friction: 0.1 });
  }
  world.addBox(cx, yNeck - (v.tall ? 2.6 : 2.8), v.tall ? 2.6 : 3.4, 0.3, { type: KINEMATIC, w: 1.2 });

  const total = v.tall ? 280 : 400;
  const spread = v.tall ? 3.2 : 4.5;
  const rnd = rng(7);
  let made = 0;
  let tries = 0;
  return () => {
    if (made < total && world.stepCount % 2 === 0) {
      // golden-ratio stepping keeps consecutive shapes apart without any randomness
      const x = cx + (2 * ((tries++ * 0.618034) % 1) - 1) * spread;
      const y = v.top - 0.7;
      if (world.pick(x, y, 0.3) === null) {
        randomShape(world, rnd, x, y, rnd.range(0.17, 0.27), { vy: -4, friction: 0.3 });
        made++;
      }
    }
    return made < total;
  };
}

function dominoes(world, v) {
  const grow = v.tall ? 1.1 : 1.085;
  const x0 = v.tall ? 3.1 : 3.6;
  const h0 = v.tall ? 0.55 : 0.62;
  const limit = v.W - (v.tall ? 1.6 : 2.4);
  let x = x0;
  let h = h0;
  for (let i = 0; x + h * 0.5 < limit; i++) {
    world.addBox(x, h / 2, h * 0.16, h, { color: i % 6 });
    x += h * 0.52;
    h *= grow;
  }
  // a small pendulum that hangs just touching the first domino, released from one side
  const R = 0.22;
  const L = 3.2;
  const ax = x0 - R - h0 * 0.08 - 0.02;
  const ay = h0 * 0.8 + L;
  const pivot = world.addBox(ax, ay + 0.12, 0.5, 0.24, { type: STATIC });
  const bx = ax - L * Math.sin(0.55);
  const by = ay - L * Math.cos(0.55);
  const ball = world.addCircle(bx, by, R, { color: 4, restitution: 0.1 });
  world.addJoint(new DistanceJoint(pivot, ball, ax, ay, bx, by, { rope: true }));
}

/**
 * wide / tall: metres across the view on a landscape / portrait stage.
 * replay: seconds after which an untouched scene starts over (0 = never).
 * warm: steps simulated before the first paint, so the still frame already shows the scene at work.
 */
export const SCENES = [
  { id: 'wrecking', label: 'Wrecking ball', wide: 26, tall: 14, build: wrecking, replay: 16, warm: 0 },
  { id: 'pyramid', label: 'Pyramid', wide: 26, tall: 14, build: pyramid, replay: 0, warm: 0 },
  { id: 'bridge', label: 'Plank bridge', wide: 26, tall: 14, build: bridge, replay: 24, warm: 0 },
  { id: 'hopper', label: 'Hopper', wide: 26, tall: 14, build: hopper, replay: 40, warm: 240 },
  { id: 'dominoes', label: 'Dominoes', wide: 26, tall: 14, build: dominoes, replay: 14, warm: 0 },
];

/**
 * Build a scene for a view of the given aspect ratio (width / height).
 * Returns { id, world, W, H, top, replay, busy, advance() }: W × H is the visible area in metres,
 * `top` the highest visible y, `busy` whether the scene still has shapes of its own to release.
 */
export function createScene(id, aspect, gravity = 9.8) {
  const def = SCENES.find((s) => s.id === id) || SCENES[0];
  const tall = aspect < 1.2;
  const W = tall ? def.tall : def.wide;
  const H = W / aspect;
  const top = H - GROUND;
  const world = new World({ gravity, angularDamping: 0.2 });
  addBounds(world, W, top);
  const tick = def.build(world, { W, H, top, tall }) || null;
  const scene = {
    id: def.id,
    world,
    W,
    H,
    top,
    replay: def.replay,
    busy: tick !== null,
    advance() {
      if (tick !== null) this.busy = tick();
      world.step(DT);
    },
  };
  for (let i = 0; i < def.warm; i++) scene.advance();
  return scene;
}
