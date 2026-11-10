// The worker that runs visitors' programs, so that an endless loop can be stopped from outside.
import { createHost } from './machine.js';

const handle = createHost();
self.onmessage = async (event) => {
  const reply = await handle(event.data);
  self.postMessage(reply, reply.pixels ? [reply.pixels] : []);
};
