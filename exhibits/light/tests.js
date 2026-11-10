// The suite: ray maths, scene and controller logic (Node and browser), then GPU checks (browser only).
import app from './tests-app.js';
import core from './tests-core.js';
import gpu from './tests-gpu.js';

export default [...core, ...app, ...gpu];
