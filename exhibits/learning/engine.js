// engine.js — the page's handle on training. Starts the module Worker; if that cannot be
// created, fails to load or dies, the same runner is run on the main thread in short slices.
import { createRunner } from './runner.js';

const READY_TIMEOUT_MS = 4000;

/**
 * createEngine(onMessage) → { send(message), destroy(), mode }
 * onMessage receives the runner's messages plus { type: 'mode', mode: 'worker' | 'main' }.
 */
export function createEngine(onMessage) {
  let worker = null;
  let runner = null;
  let mode = 'pending';
  let dead = false;
  let readyTimer = 0;
  let lastConfig = null;
  let lastRun = null;
  const backlog = [];

  const deliver = (message) => {
    if (mode === 'worker') worker.postMessage(message);
    else runner.handle(message);
  };

  function useMainThread() {
    if (dead || mode === 'main') return;
    clearTimeout(readyTimer);
    // Before the handshake nothing was delivered; after it, replay what defines the session.
    const replay = mode === 'pending' ? backlog.splice(0) : [lastConfig, lastRun].filter(Boolean);
    if (worker) {
      worker.terminate();
      worker = null;
    }
    mode = 'main';
    runner = createRunner({
      post: (message) => {
        if (!dead) onMessage(message);
      },
      schedule: (fn) => setTimeout(fn, 0),
      now: () => performance.now(),
      sliceMs: 10,
      chunkRows: 16,
      lensRes: 60,
    });
    onMessage({ type: 'mode', mode });
    for (const message of replay) runner.handle(message);
  }

  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      if (dead) return;
      if (event.data.type !== 'ready') {
        onMessage(event.data);
        return;
      }
      clearTimeout(readyTimer);
      mode = 'worker';
      onMessage({ type: 'mode', mode });
      for (const message of backlog.splice(0)) deliver(message);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      useMainThread();
    };
    readyTimer = setTimeout(useMainThread, READY_TIMEOUT_MS);
  } catch {
    useMainThread();
  }

  return {
    get mode() {
      return mode;
    },
    send(message) {
      if (dead) return;
      if (message.type === 'config') lastConfig = message;
      if (message.type === 'run') lastRun = message;
      if (mode === 'pending') backlog.push(message);
      else deliver(message);
    },
    destroy() {
      dead = true;
      clearTimeout(readyTimer);
      if (worker) worker.terminate();
      if (runner) runner.dispose();
      worker = null;
      runner = null;
    },
  };
}
