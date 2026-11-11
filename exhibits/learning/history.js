// history.js — a loss history of bounded size. Each stored point is the mean of `stride`
// consecutive samples; when the buffer fills, neighbouring points are averaged in pairs and the
// stride doubles, so any number of steps fits in a fixed number of points.

export function createHistory(capacity = 512) {
  const values = new Float32Array(capacity);
  let count = 0;
  let stride = 1;
  let sum = 0;
  let pending = 0;

  function compact() {
    const half = capacity >> 1;
    for (let i = 0; i < half; i++) values[i] = 0.5 * (values[2 * i] + values[2 * i + 1]);
    count = half;
    stride *= 2;
  }

  return {
    values,
    get count() {
      return count;
    },
    get stride() {
      return stride;
    },
    push(x) {
      sum += x;
      pending += 1;
      if (pending < stride) return;
      values[count++] = sum / pending;
      sum = 0;
      pending = 0;
      if (count === capacity) compact();
    },
    clear() {
      count = 0;
      stride = 1;
      sum = 0;
      pending = 0;
    },
  };
}
