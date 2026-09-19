// Cleaning the raw YIN track.
//
// YIN's known failure is the octave error: a frame lands on a subharmonic and
// reports half (or double) the true f0. On a glissando that error is easy to
// catch, because we are expecting a smooth slide -- a sudden jump is by
// definition wrong. Three passes, cheapest first.

import { hzToSemitones } from './notes.js';

/** Drop frames that are too quiet or too aperiodic to be a sung note. */
export function gateFrames(frames, opts = {}) {
  const minProbability = opts.minProbability ?? 0.5;
  const minRms = opts.minRms ?? 0.01;
  return frames.map((f) =>
    f.hz !== null && f.probability >= minProbability && f.rms >= minRms
      ? f
      : { ...f, hz: null }
  );
}

/**
 * Snap octave-jumped frames back onto the local trend.
 *
 * For each voiced frame we compare it against the median of the surrounding
 * voiced frames. If it sits within a quarter tone of exactly +/-12 or +/-24
 * semitones from that median, it is an octave error and we transpose it back.
 * A jump that is large but *not* octave-shaped is left alone here -- the
 * continuity pass below decides whether to keep it.
 */
export function repairOctaves(frames, opts = {}) {
  const window = opts.window ?? 5;
  const tolerance = opts.tolerance ?? 0.5; // semitones
  const out = frames.map((f) => ({ ...f }));

  for (let i = 0; i < out.length; i++) {
    if (out[i].hz === null) continue;
    const neighbours = [];
    for (let j = Math.max(0, i - window); j <= Math.min(out.length - 1, i + window); j++) {
      if (j !== i && frames[j].hz !== null) neighbours.push(frames[j].hz);
    }
    if (neighbours.length < 3) continue;

    const reference = median(neighbours);
    const delta = hzToSemitones(out[i].hz, reference);
    for (const shift of [12, -12, 24, -24]) {
      if (Math.abs(delta - shift) < tolerance) {
        out[i].hz = out[i].hz / Math.pow(2, shift / 12);
        out[i].repaired = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Reject frames that break continuity with their neighbours.
 *
 * A voice cannot move a seventh between two frames 12 ms apart. Anything that
 * does is an artefact, so we drop it rather than let it widen the range.
 */
export function enforceContinuity(frames, opts = {}) {
  const maxJump = opts.maxJump ?? 6; // semitones between consecutive voiced frames
  const out = frames.map((f) => ({ ...f }));
  let previous = null;

  for (let i = 0; i < out.length; i++) {
    if (out[i].hz === null) continue;
    if (previous !== null) {
      const jump = Math.abs(hzToSemitones(out[i].hz, previous));
      if (jump > maxJump) {
        // Look ahead: if the next voiced frame agrees with this one, the jump
        // is real (a register leap) and the outlier was the previous frame.
        const next = nextVoiced(out, i + 1);
        const agrees =
          next !== null && Math.abs(hzToSemitones(next, out[i].hz)) <= maxJump;
        if (!agrees) {
          out[i].hz = null;
          out[i].rejected = true;
          continue;
        }
      }
    }
    previous = out[i].hz;
  }
  return out;
}

/** Median filter over voiced frames; smooths residual jitter. */
export function medianSmooth(frames, window = 5) {
  const half = Math.floor(window / 2);
  return frames.map((f, i) => {
    if (f.hz === null) return { ...f };
    const values = [];
    for (let j = Math.max(0, i - half); j <= Math.min(frames.length - 1, i + half); j++) {
      if (frames[j].hz !== null) values.push(frames[j].hz);
    }
    return { ...f, hz: values.length ? median(values) : f.hz };
  });
}

/** The whole cleaning chain, in the order that matters. */
export function cleanTrack(frames, opts = {}) {
  let out = gateFrames(frames, opts);
  out = repairOctaves(out, opts);
  out = enforceContinuity(out, opts);
  out = medianSmooth(out, opts.smoothWindow ?? 5);
  return out;
}

function nextVoiced(frames, from) {
  for (let i = from; i < frames.length; i++) {
    if (frames[i].hz !== null) return frames[i].hz;
  }
  return null;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
