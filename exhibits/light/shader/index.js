// Assembles the two fragment shaders of the path tracer.
import { BSDF } from './bsdf.js';
import { COMMON, PRELUDE } from './common.js';
import { DISPLAY } from './display.js';
import { INTEGRATE } from './integrate.js';
import { SCENE } from './scene.js';

export { MAX_BOUNCES, MAX_SPF } from './common.js';

export const TRACE_SOURCE = PRELUDE + COMMON + SCENE + BSDF + INTEGRATE;
export const DISPLAY_SOURCE = PRELUDE + DISPLAY;
