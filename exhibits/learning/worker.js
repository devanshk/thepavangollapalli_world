// worker.js — module Worker: runs the training loop off the main thread.
import { createRunner } from './runner.js';

// A MessageChannel yields to the event loop without the clamping that nested timers get,
// so messages from the page are handled between slices and no time is wasted waiting.
const channel = new MessageChannel();
let queued = null;
channel.port1.onmessage = () => {
  const fn = queued;
  queued = null;
  if (fn) fn();
};

const runner = createRunner({
  post: (message, transfer) => self.postMessage(message, transfer),
  schedule: (fn) => {
    queued = fn;
    channel.port2.postMessage(0);
  },
  now: () => performance.now(),
  sliceMs: 24,
  chunkRows: Infinity,
  lensRes: 96,
});

self.onmessage = (event) => runner.handle(event.data);
self.postMessage({ type: 'ready' });
