// The page's side of running a program: talks to the worker, enforces a time limit by
// terminating it, and falls back to an interpreter on the page if no worker can be created.

const LIMIT = { load: 4000, frame: 3000, bench: 45000 };

/**
 * createRunner({ onReset, onLoaded, onPixels, onPrints, onFrameTime, onError }) →
 *   load(source, { optimise }, t)   compile and run main() and one frame
 *   frame(t)                        run frame(t) unless a request is already in flight
 *   bench(source, { optimise })     → { ok, name, wasmMs, interpMs }
 *   hasFrame, busy, dispose()
 */
export function createRunner(h) {
  let worker = null;
  let localHost = null;
  let useLocal = false;
  let seq = 0;
  let generation = 0;
  let busy = false;
  let hasFrame = false;
  const waiting = new Map();

  function dropWorker(error) {
    if (worker) worker.terminate();
    worker = null;
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.resolve({ ok: false, error, lost: true });
    }
    waiting.clear();
  }

  function ensureWorker() {
    if (worker || useLocal) return;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => {
        const w = waiting.get(event.data.id);
        if (!w) return;
        waiting.delete(event.data.id);
        clearTimeout(w.timer);
        w.resolve(event.data);
      };
      // the worker script itself failed to load or run: do without it from now on
      worker.onerror = (event) => {
        if (event.preventDefault) event.preventDefault();
        useLocal = true;
        dropWorker('the worker could not start');
      };
    } catch {
      useLocal = true;
      worker = null;
    }
  }

  async function send(message) {
    message.id = ++seq;
    ensureWorker();
    if (useLocal) {
      if (!localHost) localHost = (await import('./machine.js')).createHost({ interpretOnly: true, fuel: 6e6 });
      return localHost(message);
    }
    const limit = LIMIT[message.type];
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(message.id);
        dropWorker('superseded');
        resolve({ ok: false, error: `it ran for more than ${limit / 1000} seconds and was stopped (is there an endless loop?)` });
      }, limit);
      waiting.set(message.id, { resolve, timer });
      worker.postMessage(message);
    });
  }

  /** Send, and if the worker was stopped or died underneath the request, send it once more. */
  async function request(message) {
    const reply = await send(message);
    return reply.lost && reply.error !== 'closed' ? send(message) : reply;
  }

  function apply(reply, isLoad) {
    if (isLoad) h.onReset();
    if (reply.prints && reply.prints.length) h.onPrints(reply.prints);
    if (!reply.ok) {
      hasFrame = false;
      if (!reply.lost) h.onError(reply.error);
      return;
    }
    if (isLoad) {
      hasFrame = reply.hasFrame;
      h.onLoaded(reply);
    }
    if (reply.pixels) h.onPixels(new Uint8ClampedArray(reply.pixels));
    if (reply.frameMs != null) h.onFrameTime(reply.frameMs);
    if (useLocal && hasFrame && reply.frameMs > 30) {
      // no worker thread: animating this on the page itself would freeze it, so keep the still frame
      hasFrame = false;
      h.onPrints(['Showing one still frame: without a worker thread this program is too slow to animate here.']);
    }
  }

  return {
    get hasFrame() {
      return hasFrame;
    },
    get busy() {
      return busy;
    },
    async load(source, { optimise }, t = 0) {
      const mine = ++generation;
      busy = true;
      const reply = await request({ type: 'load', source, optimise, t });
      if (mine !== generation) return; // a newer program has been loaded since
      busy = false;
      apply(reply, true);
    },
    async frame(t) {
      if (busy || !hasFrame) return;
      const mine = generation;
      busy = true;
      const reply = await request({ type: 'frame', t });
      if (mine !== generation) return;
      busy = false;
      apply(reply, false);
    },
    async bench(source, { optimise }) {
      while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
      busy = true;
      const reply = await request({ type: 'bench', source, optimise });
      busy = false;
      return reply;
    },
    dispose() {
      generation++;
      dropWorker('closed');
    },
  };
}
