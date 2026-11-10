import { assert, equal, near } from '../../assets/js/check.js';
import { Body, STATIC, DYNAMIC, boxShape, circleShape, polygonShape } from './body.js';
import { Contact, updateManifold } from './collide.js';
import { RevoluteJoint, DistanceJoint } from './joints.js';
import { World, DT } from './world.js';
import { createScene } from './scenes.js';

const box = (x, y, w, h, angle = 0) => new Body(1, boxShape(w, h), DYNAMIC, x, y, angle, {});
const disc = (x, y, r) => new Body(2, circleShape(r), DYNAMIC, x, y, 0, {});
const manifold = (a, b) => {
  const c = new Contact();
  c.a = a;
  c.b = b;
  updateManifold(c);
  return c;
};
const run = (world, steps) => {
  for (let i = 0; i < steps; i++) world.step(DT);
};
const ground = (world, opts = {}) => world.addBox(0, -0.5, 40, 1, Object.assign({ type: STATIC }, opts));

export default [
  {
    name: 'a box has mass w·h·density and inertia m(w² + h²)/12',
    fn() {
      const b = new Body(1, boxShape(2, 0.5), DYNAMIC, 0, 0, 0, { density: 3 });
      near(b.mass, 3, 1e-12);
      near(b.inertia, (3 * (4 + 0.25)) / 12, 1e-12);
    },
  },
  {
    name: 'a clockwise, off-centre triangle gets the right area, centroid and inertia',
    fn() {
      const s = polygonShape([10, 5, 10, 8, 14, 5]);
      near(s.area, 6, 1e-12);
      near(s.cx, 10 + 4 / 3, 1e-12);
      near(s.cy, 6, 1e-12);
      near(s.inertia, (4 * 3 * (16 + 9)) / 36, 1e-9);
    },
  },
  {
    name: 'separated boxes produce no contact',
    fn() {
      equal(manifold(box(0, 0, 1, 1), box(1.1, 0, 1, 1)).count, 0);
      equal(manifold(box(0, 0, 1, 1), box(0.2, 1.3, 1, 1, 0.4)).count, 0);
    },
  },
  {
    name: 'overlapping boxes give the push-out normal, depth and two clipped points',
    fn() {
      const c = manifold(box(0, 0, 1, 1), box(0.9, 0.2, 1, 1));
      equal(c.count, 2);
      near(c.nx, 1, 1e-12);
      near(c.ny, 0, 1e-12);
      near(c.p0.sep, -0.1, 1e-12);
      near(c.p1.sep, -0.1, 1e-12);
      const ys = [c.p0.y, c.p1.y].sort((p, q) => p - q);
      near(ys[0], -0.3, 1e-12);
      near(ys[1], 0.5, 1e-12);
    },
  },
  {
    name: 'touching boxes report zero depth on two points',
    fn() {
      const c = manifold(box(0, 0, 1, 1), box(0, 1, 1, 1));
      equal(c.count, 2);
      near(c.ny, 1, 1e-12);
      near(c.p0.sep, 0, 1e-12);
      near(c.p1.sep, 0, 1e-12);
    },
  },
  {
    name: 'a box rotated 45° meets a face at one corner',
    fn() {
      const c = manifold(box(0, 0, 4, 1), box(0.3, 0.5 + Math.SQRT1_2 - 0.05, 1, 1, Math.PI / 4));
      equal(c.count, 1);
      near(c.nx, 0, 1e-12);
      near(c.ny, 1, 1e-12);
      near(c.p0.sep, -0.05, 1e-9);
      near(c.p0.x, 0.3, 1e-9);
    },
  },
  {
    name: 'a circle on a face is pushed along the face normal',
    fn() {
      const c = manifold(box(0, 0, 2, 2), disc(0.3, 1.4, 0.5));
      equal(c.count, 1);
      near(c.nx, 0, 1e-12);
      near(c.ny, 1, 1e-12);
      near(c.p0.sep, -0.1, 1e-12);
      near(c.p0.x, 0.3, 1e-12);
      near(c.p0.y, 0.95, 1e-12);
    },
  },
  {
    name: 'a circle at a corner is pushed straight away from the vertex',
    fn() {
      const c = manifold(box(0, 0, 2, 2), disc(1.3, 1.3, 0.5));
      equal(c.count, 1);
      near(c.nx, Math.SQRT1_2, 1e-12);
      near(c.ny, Math.SQRT1_2, 1e-12);
      near(c.p0.sep, Math.hypot(0.3, 0.3) - 0.5, 1e-12);
      equal(manifold(box(0, 0, 2, 2), disc(1.5, 1.5, 0.5)).count, 0, 'beyond reach of the corner');
    },
  },
  {
    name: 'two circles collide along the line of centres',
    fn() {
      const a = disc(0, 0, 0.5);
      const c = manifold(a, disc(0.54, 0.72, 0.5));
      equal(c.count, 1);
      near(c.nx, 0.6, 1e-12);
      near(c.ny, 0.8, 1e-12);
      near(c.p0.sep, -0.1, 1e-12);
    },
  },
  {
    name: 'contact points keep their ids and impulses as a box slides',
    fn() {
      const a = box(0, 0, 4, 1);
      const b = box(0.2, 0.99, 1, 1);
      const c = manifold(a, b);
      equal(c.count, 2);
      const ids = [c.p0.id, c.p1.id];
      assert(ids[0] !== ids[1], 'the two points have distinct ids');
      c.p0.jn = 3;
      c.p1.jn = 5;
      b.x += 0.05;
      b.sync();
      updateManifold(c);
      equal([c.p0.id, c.p1.id], ids);
      equal([c.p0.jn, c.p1.jn], [3, 5]);
    },
  },
  {
    name: 'a stack of ten boxes comes to rest and stays at rest',
    fn() {
      const world = new World({ allowSleep: false });
      ground(world);
      const boxes = [];
      for (let i = 0; i < 10; i++) boxes.push(world.addBox(0, 0.5 + i, 1, 1));
      run(world, 600);
      for (let i = 0; i < 10; i++) {
        const b = boxes[i];
        assert(Math.hypot(b.vx, b.vy) < 0.01 && Math.abs(b.w) < 0.01, `box ${i} is still moving`);
        near(b.y, 0.5 + i, 0.05, `box ${i} height`);
        near(b.x, 0, 0.01, `box ${i} sideways`);
      }
      const before = boxes.map((b) => [b.x, b.y, b.a]);
      run(world, 600);
      boxes.forEach((b, i) => {
        near(b.x, before[i][0], 0.002, `box ${i} x drift`);
        near(b.y, before[i][1], 0.002, `box ${i} y drift`);
        near(b.a, before[i][2], 0.002, `box ${i} rotation drift`);
      });
    },
  },
  {
    name: 'a 12-row pyramid stands without creeping and goes to sleep',
    fn() {
      const scene = createScene('pyramid', 0.9);
      const boxes = scene.world.bodies.filter((b) => b.type === DYNAMIC);
      equal(boxes.length, 78);
      const start = boxes.map((b) => [b.x, b.y]);
      run(scene.world, 240);
      const mid = boxes.map((b) => [b.x, b.y]);
      run(scene.world, 240);
      boxes.forEach((b, i) => {
        near(b.x, start[i][0], 0.02, 'sideways movement since the start');
        near(b.y, start[i][1], 0.08, 'sinking since the start');
        near(Math.hypot(b.x - mid[i][0], b.y - mid[i][1]), 0, 0.001, 'creep in the last two seconds');
      });
      equal(scene.world.awakeCount, 0, 'every box is asleep');
    },
  },
  {
    name: 'a frictionless elastic collision conserves momentum and energy',
    fn() {
      const world = new World({ gravity: 0 });
      const o = { friction: 0, restitution: 1 };
      const a = world.addCircle(0, 0, 0.5, Object.assign({ vx: 3 }, o));
      const b = world.addCircle(4, 0.4, 0.8, Object.assign({ vx: -2, vy: 0.1, density: 2 }, o));
      const px = () => a.mass * a.vx + b.mass * b.vx;
      const py = () => a.mass * a.vy + b.mass * b.vy;
      const px0 = px();
      const py0 = py();
      const e0 = world.energy();
      run(world, 240);
      assert(a.vx < 0, 'the bodies actually collided');
      near(px(), px0, 1e-9);
      near(py(), py0, 1e-9);
      near(world.energy(), e0, 1e-9);
    },
  },
  {
    name: 'a pendulum on a revolute joint swings with period 2π√(L/g)',
    fn() {
      const world = new World({ allowSleep: false });
      const L = 2;
      const bob = world.addCircle(L * Math.sin(0.1), -L * Math.cos(0.1), 0.1);
      world.addJoint(new RevoluteJoint(world.fixed, bob, 0, 0));
      const crossings = [];
      let prev = bob.x;
      for (let i = 1; i <= 1400 && crossings.length < 3; i++) {
        world.step(DT);
        if (prev < 0 && bob.x >= 0) crossings.push((i - 1 + -prev / (bob.x - prev)) * DT);
        prev = bob.x;
      }
      equal(crossings.length, 3);
      const expected = 2 * Math.PI * Math.sqrt(L / 9.8);
      near(crossings[1] - crossings[0], expected, 0.02 * expected);
      near(crossings[2] - crossings[1], expected, 0.02 * expected);
      near(Math.hypot(bob.x, bob.y), L, 0.005, 'the joint holds its length');
    },
  },
  {
    name: 'a box on an incline slides if and only if tan θ exceeds the friction coefficient',
    fn() {
      const mu = 0.5;
      const slide = (degrees) => {
        const t = (degrees * Math.PI) / 180;
        const world = new World();
        world.addBox(0, 0, 40, 1, { type: STATIC, angle: t, friction: mu });
        const b = world.addBox(-0.75 * Math.sin(t), 0.75 * Math.cos(t), 1, 0.5, { angle: t, friction: mu });
        const x0 = b.x;
        const y0 = b.y;
        run(world, 240);
        return Math.hypot(b.x - x0, b.y - y0);
      };
      assert(slide(24) < 0.01, 'tan 24° = 0.445 < 0.5: it must hold');
      const t = (29 * Math.PI) / 180;
      const expected = 0.5 * 9.8 * (Math.sin(t) - mu * Math.cos(t)) * 2 * 2;
      near(slide(29), expected, 0.1, 'tan 29° = 0.554 > 0.5: it slides at g(sin θ − μ cos θ)');
    },
  },
  {
    name: 'a ball dropped with restitution e rebounds to e² of its height',
    fn() {
      const e = 0.7;
      const world = new World();
      ground(world);
      const ball = world.addCircle(0, 4.25, 0.25, { restitution: e });
      let bounced = false;
      let peak = 0;
      for (let i = 0; i < 800; i++) {
        world.step(DT);
        if (!bounced && ball.vy > 0) bounced = true;
        if (bounced) {
          if (ball.vy < 0) break;
          peak = Math.max(peak, ball.y - 0.25);
        }
      }
      assert(bounced, 'the ball bounced');
      near(peak, e * e * 4, 0.1);
    },
  },
  {
    name: 'a hinge limit stops rotation at its bound',
    fn() {
      const world = new World({ allowSleep: false });
      const bar = world.addBox(1, 0, 2, 0.2);
      world.addJoint(new RevoluteJoint(world.fixed, bar, 0, 0, { lower: -0.5, upper: 0.5 }));
      run(world, 600);
      near(bar.a, -0.5, 0.02);
      assert(Math.abs(bar.w) < 0.05, 'the bar is at rest against the limit');
    },
  },
  {
    name: 'a rope goes taut under a heavy ball without stretching',
    fn() {
      const world = new World({ allowSleep: false });
      const ball = world.addCircle(1.5, 0, 0.5, { density: 20 });
      world.addJoint(new DistanceJoint(world.fixed, ball, 0, 0, 1.5, 0, { rope: true, length: 3 }));
      let longest = 0;
      for (let i = 0; i < 600; i++) {
        world.step(DT);
        longest = Math.max(longest, Math.hypot(ball.x, ball.y));
      }
      assert(longest > 2.95, 'the rope went taut');
      assert(longest < 3.03, `the rope stretched to ${longest}`);
    },
  },
  {
    name: 'a sleeping box wakes when it is struck',
    fn() {
      const world = new World();
      ground(world);
      const target = world.addBox(0, 0.5, 1, 1);
      run(world, 240);
      assert(!target.awake, 'the box fell asleep');
      world.addCircle(-3, 0.3, 0.3, { vx: 8 });
      let woke = false;
      for (let i = 0; i < 120; i++) {
        world.step(DT);
        woke = woke || target.awake;
      }
      assert(woke, 'the box woke up');
      assert(target.x > 0.01, 'and was pushed along');
    },
  },
  {
    name: 'the wrecking-ball scene is bit-for-bit identical over 1000 steps',
    fn() {
      const simulate = () => {
        const scene = createScene('wrecking', 16 / 9);
        for (let i = 0; i < 1000; i++) scene.advance();
        return scene.world.bodies.map((b) => [b.x, b.y, b.a, b.vx, b.vy, b.w]).flat();
      };
      const first = simulate();
      assert(first.every(Number.isFinite), 'every coordinate is finite');
      equal(simulate(), first);
    },
  },
];
