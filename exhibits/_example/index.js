// Reference exhibit: the smallest thing that follows the contract in exhibits/README.md.
import { view, bar, slider, toggle, segmented, button, stat, spacer, hint, loop, pointer, cssVar, fpsMeter, TAU } from '../../assets/js/kit.js';
import { createField, stepField } from './field.js';

export function mount(root, env) {
  const v = view(root, { aspect: 16 / 9, aspectNarrow: 1, label: 'Dots orbiting the pointer' });
  const ctx = v.canvas.getContext('2d');
  const accent = cssVar(root, '--st-accent');
  const bg = cssVar(root, '--st-bg');

  let field = createField(240, 7);
  let pull = 1;
  let trails = true;
  const target = { x: 0.5, y: 0.5 };
  const fps = fpsMeter();

  const fpsStat = stat({ label: 'fps' });
  bar(
    root,
    button({ label: 'Reseed', onClick: () => { field = createField(field.n, (Math.random() * 1e9) | 0); draw(); } }),
    slider({ label: 'Pull', min: 0, max: 3, step: 0.05, value: pull, format: (x) => x.toFixed(2), onInput: (x) => (pull = x) }),
    segmented({ label: 'Count', options: [120, 240, 480], value: 240, onChange: (n) => { field = createField(n, 7); draw(); } }),
    toggle({ label: 'Trails', value: trails, onChange: (on) => (trails = on) }),
    spacer(),
    hint(env.coarse ? 'Drag to lead the swarm' : 'Move the pointer to lead the swarm'),
    fpsStat,
  );

  const follow = (p) => { target.x = p.nx; target.y = p.ny; };
  const offPointer = pointer(v.canvas, { down: follow, move: follow, hover: follow }, { touchAction: 'pan-y' });

  function draw() {
    const { pw, ph, dpr } = v.size;
    if (!pw) return;
    ctx.globalAlpha = trails ? 0.18 : 1;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, pw, ph);
    ctx.globalAlpha = 1;
    ctx.fillStyle = accent;
    for (let i = 0; i < field.n; i++) {
      ctx.beginPath();
      ctx.arc(field.x[i] * pw, field.y[i] * ph, 1.6 * dpr, 0, TAU);
      ctx.fill();
    }
  }

  const anim = loop((dt) => {
    stepField(field, target, pull, dt);
    draw();
    fpsStat.set(Math.round(fps.tick(dt)));
  });
  v.onResize(draw); // complete at rest: a first frame exists before start()

  return {
    start: () => anim.start(),
    stop: () => anim.stop(),
    destroy() { anim.stop(); offPointer(); v.destroy(); },
  };
}
