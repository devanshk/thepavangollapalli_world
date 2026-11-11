// runner.js — drives a training session in short slices and reports back with messages.
// The same code runs inside the Worker (worker.js) and, when no Worker can be created, on the
// main thread (engine.js); only the slice length, the scheduler and the chunk sizes differ.
//
// Messages in:  config { id, config, target, warmup } · target { target } · run { on, final }
//               continue · lr { lr } · lens { x0, y0, span }
// Messages out: frame { id, step, mse, sps, losses, lossStart, image, tiles, tileSize, units,
//                       halted, training } · lens { id, x0, y0, span, res, image }
import { createSession, TILE_COUNT } from './trainer.js';

const MIN_FRAME_MS = 110;
const LOSS_CAP = 2048;

/**
 * createRunner({ post, schedule, now, sliceMs, chunkRows, lensRes, budget, plateauWindow,
 *                plateauPatience, minImprove })
 *   post(message, transferables)   delivers a message to the page
 *   schedule(fn)                   runs fn in a later task
 *   sliceMs                        how long one slice of training may take
 *   chunkRows                      picture rows predicted per slice (Infinity = whole picture)
 *   budget                         steps after which training pauses itself
 *   plateauWindow/Patience         pause when this many windows in a row fail to improve the
 *                                  best window-mean loss by minImprove
 */
export function createRunner(options) {
  const {
    post,
    schedule,
    now,
    sliceMs = 24,
    chunkRows = Infinity,
    lensRes = 96,
    budget = 2500,
    plateauWindow = 250,
    plateauPatience = 4,
    minImprove = 0.01,
  } = options;

  let session = null;
  let configId = 0;
  let disposed = false;
  let pumping = false;
  let wantRun = false;
  let halted = null;
  let limit = 0;
  let warmupEnd = 0;
  let frameDue = false;
  let lastFrameAt = 0;
  let frameEvery = MIN_FRAME_MS;
  let preview = null;
  let lensRequest = null;
  const lossBuffer = new Float32Array(LOSS_CAP);
  let lossCount = 0;
  let lossStart = 0;
  let rateStart = null;
  let rateSteps = 0;
  let windowSum = 0;
  let windowCount = 0;
  let bestWindow = Infinity;
  let staleWindows = 0;

  const isActive = () => session !== null && (session.steps < warmupEnd || (wantRun && halted === null));

  function resetPlateau() {
    windowSum = 0;
    windowCount = 0;
    bestWindow = Infinity;
    staleWindows = 0;
  }

  function kick() {
    if (pumping || disposed) return;
    pumping = true;
    schedule(pump);
  }

  function trainStep() {
    const loss = session.step();
    if (lossCount === 0) lossStart = session.steps - 1;
    lossBuffer[lossCount++] = loss;
    rateSteps += 1;
    windowSum += loss;
    windowCount += 1;
    if (windowCount === plateauWindow) {
      const mean = windowSum / windowCount;
      windowSum = 0;
      windowCount = 0;
      if (mean < bestWindow * (1 - minImprove)) {
        bestWindow = mean;
        staleWindows = 0;
      } else staleWindows += 1;
    }
    if (session.steps === warmupEnd) frameDue = true;
    if (halted === null && session.steps >= warmupEnd) {
      if (session.steps >= limit) halted = 'budget';
      else if (staleWindows >= plateauPatience) halted = 'plateau';
      if (halted !== null) frameDue = true;
    }
  }

  function trainSlice(t0) {
    if (rateStart === null) {
      rateStart = t0;
      rateSteps = 0;
    }
    do trainStep();
    while (isActive() && !frameDue && lossCount < LOSS_CAP && now() - t0 < sliceMs);
  }

  function frameWanted(t) {
    if (frameDue || lossCount >= LOSS_CAP) return true;
    return lossCount > 0 && session.steps >= warmupEnd && isActive() && t - lastFrameAt >= frameEvery;
  }

  // A preview is always computed from one state of the weights: no training runs between chunks.
  function advancePreview() {
    const t0 = now();
    if (preview === null) {
      preview = { row: 0, rgba: new Uint8ClampedArray(session.size * session.size * 4), cost: 0 };
      session.beginPredict();
      frameDue = false;
    }
    const y1 = Math.min(session.size, preview.row + chunkRows);
    session.predictRows(preview.row, y1, preview.rgba);
    preview.row = y1;
    preview.cost += now() - t0;
    if (y1 === session.size) finishFrame();
  }

  function finishFrame() {
    const tiles = new Float32Array(TILE_COUNT * session.tileSize * session.tileSize);
    const mse = session.endPredict(tiles);
    const t = now();
    const training = isActive();
    // Wall-clock throughput since the previous frame, previews included.
    const sps = rateStart !== null && rateSteps > 0 && t > rateStart ? (rateSteps * 1000) / (t - rateStart) : null;
    rateStart = training ? t : null;
    rateSteps = 0;
    const losses = lossBuffer.slice(0, lossCount);
    const image = preview.rgba;
    post(
      {
        type: 'frame',
        id: configId,
        step: session.steps,
        mse,
        sps,
        losses,
        lossStart,
        image,
        tiles,
        tileSize: session.tileSize,
        units: session.tileUnits,
        halted,
        training,
      },
      [image.buffer, tiles.buffer, losses.buffer],
    );
    // Keep previews to roughly a quarter of the time so most of it goes to training.
    frameEvery = Math.max(MIN_FRAME_MS, 3 * preview.cost);
    lastFrameAt = t;
    lossCount = 0;
    preview = null;
  }

  function renderLens() {
    const { x0, y0, span } = lensRequest;
    lensRequest = null;
    const image = new Uint8ClampedArray(lensRes * lensRes * 4);
    session.renderPatch(x0, y0, span, lensRes, image);
    post({ type: 'lens', id: configId, x0, y0, span, res: lensRes, image }, [image.buffer]);
  }

  // One unit of work per task, so incoming messages are never kept waiting for long.
  function pump() {
    pumping = false;
    if (disposed || session === null) return;
    const t0 = now();
    if (lensRequest !== null) renderLens();
    else if (preview !== null || frameWanted(t0)) advancePreview();
    else if (isActive()) trainSlice(t0);
    if (lensRequest !== null || preview !== null || frameDue || isActive()) kick();
  }

  function handle(message) {
    if (disposed) return;
    switch (message.type) {
      case 'config':
        session = createSession(message.config);
        session.setTargetRGBA(message.target);
        configId = message.id;
        warmupEnd = message.warmup || 0;
        limit = budget;
        halted = null;
        preview = null;
        lossCount = 0;
        rateStart = null;
        resetPlateau();
        frameDue = warmupEnd === 0;
        lastFrameAt = now();
        break;
      case 'target':
        if (session === null) break;
        session.setTargetRGBA(message.target);
        resetPlateau();
        // A changed picture is worth learning again, even after an automatic pause.
        if (halted !== null) {
          halted = null;
          limit = session.steps + budget;
        }
        if (!isActive()) frameDue = true;
        break;
      case 'run':
        wantRun = !!message.on;
        if (!wantRun) {
          rateStart = null;
          if (message.final && session !== null && lossCount > 0) frameDue = true;
        }
        break;
      case 'continue':
        if (session === null) break;
        halted = null;
        limit = session.steps + budget;
        resetPlateau();
        break;
      case 'lr':
        if (session === null) break;
        session.lr = message.lr;
        resetPlateau();
        break;
      case 'lens':
        lensRequest = message;
        break;
      default:
        break;
    }
    kick();
  }

  return {
    handle,
    dispose() {
      disposed = true;
      session = null;
    },
  };
}
