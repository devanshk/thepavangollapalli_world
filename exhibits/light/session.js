// The render schedule: what to trace each frame, at which resolution, and when to stop.
//
// Two accumulation buffers exist. While anything is changing, every frame traces a fresh,
// low-resolution image into `moving`. Once things have been still for a moment, `still` restarts
// at the planned resolution and averages samples until the budget is reached; then the loop ends
// and the GPU goes idle until the next change.
//
// Each traced frame is followed by a fence in the GPU's command stream. A new frame is only
// submitted once the previous fence has passed, so a slow GPU is never handed a backlog, and the
// time a fence takes to pass is the measurement the quality controller runs on.
import { createQuality } from './quality.js';

const SETTLE_MS = 140;
/** GPU time to spend on the frame shown before start(), and the sample range it must land in. */
const REST_MS = 350;
const REST_MIN = 8;
const REST_MAX = 32;
/** A timing probe shorter than this is too close to the timer's resolution to trust. */
const PROBE_MS = 12;
/** Fence times longer than this are a tab switch or a hiccup, not a measurement. */
const STALL_MS = 500;
/** Only this early in a still image may it restart at a lower resolution if the GPU is struggling. */
const RETHINK_BEFORE = 24;

const browserClock = {
  now: () => performance.now(),
  request: (fn) => requestAnimationFrame(fn),
  cancel: (id) => cancelAnimationFrame(id),
  pause: () => new Promise((resolve) => setTimeout(resolve, 0)),
};

/**
 * createSession({ view, renderer, sampleBudget, animate, report, onError, clock? })
 *   animate(dt) → boolean   advance camera easing, hand the renderer its camera, true while moving
 *   report({ samples, w, h })   called after every traced frame
 *   onError(err)            the GPU refused to render; the session has stopped itself
 *   clock                   time source and frame scheduler; the tests substitute a manual one
 */
export function createSession({ view, renderer, sampleBudget, animate, report, onError, clock = browserClock }) {
  const quality = createQuality();
  let plan = null;
  let running = false;
  let suspended = false;
  let ended = false;
  let raf = 0;
  let lastTick = 0;
  let inFlight = null; // fence behind the most recently traced frame
  let submittedAt = 0;
  let submittedWork = 0;
  let changedAt = -Infinity;
  let wasMoving = false;
  let stale = true;

  function replan() {
    const { pw, ph } = view.size;
    plan = quality.plan(pw, ph);
    if (renderer.buffer('still', plan.still.w, plan.still.h)) stale = true;
    renderer.buffer('moving', plan.moving.w, plan.moving.h);
  }

  function submitted(work) {
    inFlight = renderer.fence();
    submittedAt = clock.now();
    submittedWork = work;
  }

  function traceMoving() {
    if (!wasMoving || !plan) replan();
    const { w, h, spf } = plan.moving;
    renderer.reset('moving');
    renderer.accumulate('moving', spf);
    renderer.present('moving');
    submitted(w * h * spf);
    report({ samples: spf, w, h });
  }

  function traceStill(fixedSpf) {
    if (stale || !plan) {
      replan();
      renderer.reset('still');
      stale = false;
    }
    const { w, h } = plan.still;
    const spf = Math.min(sampleBudget - renderer.samples('still'), fixedSpf || quality.spf(w, h));
    const samples = renderer.accumulate('still', spf);
    renderer.present('still');
    submitted(w * h * spf);
    report({ samples, w, h });
    // a GPU slower than the probe suggested: drop the resolution while little work would be lost
    if (!fixedSpf && samples < RETHINK_BEFORE && quality.plan(view.size.pw, view.size.ph).still.w < w) stale = true;
  }

  const converged = () => !stale && renderer.samples('still') >= sampleBudget;

  /** Run GPU work; a failure stops the session instead of escaping as an uncaught exception. */
  function guarded(work) {
    try {
      work();
    } catch (err) {
      suspended = true;
      clock.cancel(raf);
      raf = 0;
      // a lost context announces itself through its own event; anything else is reported
      if (!renderer.contextLost()) onError(err);
    }
  }

  function schedule() {
    if (running && !suspended && !raf) raf = clock.request(tick);
  }

  function tick(now) {
    raf = 0;
    if (!running || suspended) return;
    const dt = lastTick ? now - lastTick : 0;
    lastTick = now;
    if (animate(Math.min(dt, 50) / 1000)) changedAt = now;

    if (inFlight) {
      if (!inFlight.done()) {
        schedule();
        return;
      }
      const took = now - submittedAt;
      if (took < STALL_MS) quality.feedback(took, submittedWork);
      inFlight = null;
    }

    const moving = now - changedAt < SETTLE_MS;
    guarded(() => {
      if (moving) traceMoving();
      else if (!converged()) traceStill();
    });
    wasMoving = moving;
    if (moving || !converged()) schedule();
    else {
      lastTick = 0;
      inFlight = null;
    }
  }

  /** Draw immediately, outside the frame loop: a few still samples so the stage is never blank. */
  function drawNow() {
    if (suspended || !view.size.pw) return;
    guarded(() => {
      animate(0);
      stale = true;
      traceStill(REST_MIN);
    });
  }

  /** Wait, without blocking the page, until the GPU has finished what was submitted. */
  async function gpuIdle() {
    const fence = renderer.fence();
    while (!fence.done() && !ended && !suspended) await clock.pause();
  }

  /** Time the GPU on growing workloads until one takes long enough to measure. → ms per pixel-sample */
  async function probe() {
    const { pw, ph } = view.size;
    let scale = 1 / 6;
    let spf = 1;
    let cost = 0;
    for (let attempt = 0; attempt < 8 && !ended && !suspended; attempt++) {
      const w = Math.max(8, Math.round(pw * scale));
      const h = Math.max(8, Math.round(ph * scale));
      renderer.buffer('moving', w, h);
      if (attempt === 0) {
        // the first draw pays for shader translation; keep it out of the measurement
        renderer.accumulate('moving', 1);
        await gpuIdle();
      }
      renderer.reset('moving');
      const t0 = clock.now();
      renderer.accumulate('moving', spf);
      await gpuIdle();
      const ms = clock.now() - t0;
      cost = Math.max(ms, 0.5) / (w * h * spf);
      if (ms >= PROBE_MS) break;
      if (scale < 1) scale = Math.min(1, scale * 2);
      else if (spf < 8) spf *= 2;
      else break;
    }
    return cost;
  }

  return {
    /** Something that affects the picture changed. */
    invalidate() {
      stale = true;
      changedAt = clock.now();
      schedule();
    },
    /** Time the GPU, plan the resolution and trace the frame shown before start(). */
    async prime() {
      try {
        animate(0);
        const cost = await probe();
        if (ended || suspended) return;
        quality.calibrate(cost);
        replan();
        renderer.reset('still');
        stale = false;
        const { w, h } = plan.still;
        const perSample = cost * w * h;
        const total = Math.min(REST_MAX, Math.max(REST_MIN, Math.floor(REST_MS / perSample)));
        const chunk = Math.min(8, Math.max(1, Math.floor(20 / perSample)));
        while (!ended && !suspended && !stale && renderer.samples('still') < total) {
          const samples = renderer.accumulate('still', Math.min(chunk, total - renderer.samples('still')));
          renderer.present('still');
          report({ samples, w, h });
          await gpuIdle();
        }
      } catch (err) {
        guarded(() => {
          throw err;
        });
      }
    },
    start() {
      if (running) return;
      running = true;
      // the browser may have dropped the canvas contents while the exhibit was off screen
      if (!suspended && plan && !stale) guarded(() => renderer.present('still'));
      schedule();
    },
    stop() {
      running = false;
      clock.cancel(raf);
      raf = 0;
      lastTick = 0;
      inFlight = null;
    },
    /** The canvas changed size: its contents were cleared, so redraw before the next paint. */
    resized() {
      changedAt = clock.now();
      stale = true;
      if (!running) drawNow();
      else if (!suspended) {
        guarded(() => {
          animate(0);
          traceMoving();
        });
        wasMoving = true;
        schedule();
      }
    },
    /** The WebGL context was lost: stop touching it. */
    suspend() {
      suspended = true;
      clock.cancel(raf);
      raf = 0;
      inFlight = null;
    },
    /** The context is back and the renderer has been rebuilt. */
    resume() {
      suspended = false;
      plan = null;
      stale = true;
      lastTick = 0;
      if (running) schedule();
      else drawNow();
    },
    end() {
      ended = true;
      running = false;
      clock.cancel(raf);
    },
  };
}
