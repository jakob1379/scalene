/**
 * Footprint series helpers (DESIGN.md §4.0.7). Series are flat
 * `Float64Array`s `[t0, mb0, t1, mb1, …]` with t in seconds, sorted by t.
 */

export interface PeakInfo {
  t: number;
  mb: number;
  /** Pair index (sample number) of the peak. */
  index: number;
}

/** The max-footprint point (first one on ties), or null for an empty series. */
export function peakInfo(samples: Float64Array): PeakInfo | null {
  let best = -1;
  for (let i = 1; i < samples.length; i += 2) {
    if (best < 0 || samples[i] > samples[best]) best = i;
  }
  return best < 0 ? null : { t: samples[best - 1], mb: samples[best], index: (best - 1) / 2 };
}

/** Index of the last pair with t ≤ `t` (−1 when `t` precedes the series). */
export function pairAtOrBefore(samples: Float64Array, t: number): number {
  let lo = 0;
  let hi = samples.length / 2 - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[2 * mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface FootprintAt {
  mb: number;
  /** False when `t` hits a sample exactly. */
  interpolated: boolean;
}

/**
 * Footprint at time `t` by linear interpolation between neighbouring samples
 * (label it "interpolated"); null outside the sampled range ("not sampled").
 */
export function footprintAt(samples: Float64Array, t: number): FootprintAt | null {
  const m = samples.length / 2;
  if (m === 0 || t < samples[0] || t > samples[2 * (m - 1)]) return null;
  const i = pairAtOrBefore(samples, t);
  const t0 = samples[2 * i];
  const v0 = samples[2 * i + 1];
  if (t0 === t || i === m - 1) return { mb: v0, interpolated: t0 !== t };
  const t1 = samples[2 * i + 2];
  const v1 = samples[2 * i + 3];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  return { mb: v0 + (v1 - v0) * f, interpolated: true };
}

/**
 * M4 downsampling: per pixel column keep first, min, max and last points
 * (in time order). Returns the input unchanged when it has ≤ 2 × `px`
 * points. Points outside `[t0, t1]` are dropped except one on each side, so
 * lines still reach the plot edges.
 */
export function m4(samples: Float64Array, t0: number, t1: number, px: number): Float64Array {
  const m = samples.length / 2;
  const cols = Math.max(1, Math.floor(px));
  if (m <= 2 * cols || !(t1 > t0)) return samples;
  const out = new Float64Array(Math.min(m, cols * 4 + 2) * 2);
  let n = 0;
  const push = (k: number): void => {
    out[n++] = samples[2 * k];
    out[n++] = samples[2 * k + 1];
  };
  const scale = cols / (t1 - t0);
  let k = 0;
  while (k < m && samples[2 * k] < t0) k++;
  if (k > 0) push(k - 1);
  while (k < m && samples[2 * k] <= t1) {
    const col = Math.min(cols - 1, Math.floor((samples[2 * k] - t0) * scale));
    const first = k;
    let lo = k;
    let hi = k;
    let last = k;
    for (; k < m && samples[2 * k] <= t1; k++) {
      if (Math.min(cols - 1, Math.floor((samples[2 * k] - t0) * scale)) !== col) break;
      if (samples[2 * k + 1] < samples[2 * lo + 1]) lo = k;
      if (samples[2 * k + 1] > samples[2 * hi + 1]) hi = k;
      last = k;
    }
    const picks = [first, lo, hi, last].sort((a, b) => a - b);
    let prev = -1;
    for (const p of picks) {
      if (p !== prev) push(p);
      prev = p;
    }
  }
  if (k < m) push(k);
  return out.slice(0, n);
}

/** Times (seconds) of a series, i.e. the even entries. */
export function sampleTimes(samples: Float64Array): Float64Array {
  const out = new Float64Array(samples.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = samples[2 * i];
  return out;
}

/** Largest value of a series (0 for empty). */
export function seriesMax(samples: Float64Array): number {
  let max = 0;
  for (let i = 1; i < samples.length; i += 2) if (samples[i] > max) max = samples[i];
  return max;
}
