// Turning a cleaned f0 track into the things a singer actually cares about.
//
// Range is the easy part and every tool does it. The measures that decide a
// voice type are tessitura (where the voice lives comfortably) and the
// passaggio (where it changes register) -- both come out of the same track.

import { hzToMidi, midiToNote, midiToHz, VOICE_TYPES } from './notes.js';

/** Percentile over a sorted-on-the-fly copy. p in 0..1, linear interpolation. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = p * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Range in MIDI semitones.
 *
 * We report the 5th-95th percentile as the *usable* range and keep the true
 * extremes separately. One cracked note at the top should not be sold back to
 * the singer as an extra third of range -- that is the single most common way
 * these tools lie.
 */
export function computeRange(midiValues) {
  if (!midiValues.length) return null;
  return {
    lowMidi: percentile(midiValues, 0.05),
    highMidi: percentile(midiValues, 0.95),
    absoluteLowMidi: Math.min(...midiValues),
    absoluteHighMidi: Math.max(...midiValues),
  };
}

/**
 * Tessitura: the band the voice both spends time in and is stable in.
 *
 * Histogram the track into semitone bins, weight each bin by how steady the
 * pitch was there (low local deviation = comfortable, wobbling = straining),
 * then take the narrowest contiguous band holding `coverage` of that weight.
 * This is the measure that tracks voice type more closely than range does.
 */
export function computeTessitura(frames, opts = {}) {
  const coverage = opts.coverage ?? 0.68;
  const voiced = frames.filter((f) => f.hz !== null);
  if (voiced.length < 10) return null;

  const bins = new Map();
  for (let i = 0; i < voiced.length; i++) {
    const midi = hzToMidi(voiced[i].hz);
    const bin = Math.round(midi);
    // Stability: how far this frame sits from its immediate neighbours.
    const previous = i > 0 ? hzToMidi(voiced[i - 1].hz) : midi;
    const next = i < voiced.length - 1 ? hzToMidi(voiced[i + 1].hz) : midi;
    const wobble = (Math.abs(midi - previous) + Math.abs(midi - next)) / 2;
    const weight = (voiced[i].probability ?? 1) / (1 + wobble);
    bins.set(bin, (bins.get(bin) ?? 0) + weight);
  }

  const keys = [...bins.keys()].sort((a, b) => a - b);
  const total = [...bins.values()].reduce((a, b) => a + b, 0);
  const target = total * coverage;

  // Narrowest window of bins whose weight reaches the target.
  let best = null;
  for (let start = 0; start < keys.length; start++) {
    let sum = 0;
    for (let end = start; end < keys.length; end++) {
      sum += bins.get(keys[end]);
      if (sum >= target) {
        const width = keys[end] - keys[start];
        if (best === null || width < best.width) {
          best = { width, lowMidi: keys[start], highMidi: keys[end] };
        }
        break;
      }
    }
  }
  if (!best) return null;

  // Centre of mass inside the band -- the single note the voice sits on.
  let weighted = 0;
  let weightSum = 0;
  for (const key of keys) {
    if (key >= best.lowMidi && key <= best.highMidi) {
      weighted += key * bins.get(key);
      weightSum += bins.get(key);
    }
  }

  return {
    lowMidi: best.lowMidi,
    highMidi: best.highMidi,
    centerMidi: weightSum ? weighted / weightSum : null,
  };
}

/**
 * Passaggio candidate: where the voice changes register.
 *
 * Across a rising glissando the register shift shows up as an abrupt change in
 * timbre and loudness at a particular pitch, not as a pitch jump. We look for
 * the largest discontinuity in RMS relative to the local trend, and report the
 * pitch it happened at. Called a *candidate* on purpose: a clean sweep gives a
 * real answer, a ragged one gives noise, so it carries its own strength.
 */
export function findPassaggio(frames, opts = {}) {
  const minStrength = opts.minStrength ?? 0.25;
  // Index into the original track, so gaps (breaths, pauses) stay visible.
  const voiced = [];
  frames.forEach((f, index) => {
    if (f.hz !== null && f.rms > 0) voiced.push({ ...f, index });
  });
  if (voiced.length < 30) return null;

  // Compare the loudness *plateau* on each side of a candidate point rather
  // than adjacent frames. A register break is a step between two levels, and a
  // step spread over a dozen frames leaves almost nothing between neighbours --
  // measuring frame-to-frame finds the right place but reports a change far
  // smaller than the step actually is.
  const side = Math.max(6, Math.floor(voiced.length * 0.04));
  const mean = (from, to) => {
    let sum = 0;
    let count = 0;
    for (let i = Math.max(0, from); i < Math.min(voiced.length, to); i++) {
      sum += voiced[i].rms;
      count++;
    }
    return count ? sum / count : 0;
  };

  /** Spread of a window, relative to its own level: a plateau scores near 0. */
  const relativeSpread = (from, to) => {
    const values = [];
    for (let i = Math.max(0, from); i < Math.min(voiced.length, to); i++) {
      values.push(voiced[i].rms);
    }
    if (values.length < 2) return Infinity;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    if (!avg) return Infinity;
    const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length;
    return Math.sqrt(variance) / avg;
  };

  /** True if the voice cut out anywhere inside this stretch. */
  const hasGap = (from, to) => {
    const a = Math.max(0, from);
    const b = Math.min(voiced.length - 1, to);
    for (let i = a; i < b; i++) {
      // Consecutive entries whose original indices are not adjacent mean
      // unvoiced frames sat between them -- a breath or a pause.
      if (voiced[i + 1].index - voiced[i].index > 2) return true;
    }
    return false;
  };

  let best = null;
  const edge = Math.max(side, Math.floor(voiced.length * 0.15)); // skip onset and release
  for (let i = edge; i < voiced.length - edge; i++) {
    const before = mean(i - side * 2, i - side);
    const after = mean(i + side, i + side * 2);
    if (!before || !after) continue;

    // A breath produces a loudness step too, and it is not a register change.
    // Requiring both sides to be steady plateaus with continuous voicing is
    // what separates the two.
    if (hasGap(i - side * 2, i + side * 2)) continue;
    if (relativeSpread(i - side * 2, i - side) > 0.25) continue;
    if (relativeSpread(i + side, i + side * 2) > 0.25) continue;

    const change = Math.abs(Math.log2(after / before));
    if (best === null || change > best.change) {
      best = { change, midi: hzToMidi(voiced[i].hz) };
    }
  }
  if (!best || best.change < minStrength) return null;
  return {
    midi: best.midi,
    note: midiToNote(best.midi),
    strength: Number(best.change.toFixed(3)),
  };
}

/**
 * Score each conventional voice type against the measured voice.
 *
 * Tessitura carries most of the weight, because that is what the classification
 * convention actually keys on; range overlap is a weaker secondary signal.
 * Scores are relative rankings within a group, not probabilities.
 */
export function classify(range, tessitura, opts = {}) {
  if (!range) return [];
  const group = opts.group ?? null;
  const candidates = group ? VOICE_TYPES.filter((t) => t.group === group) : VOICE_TYPES;

  const scored = candidates.map((type) => {
    const rangeScore = overlap(range.lowMidi, range.highMidi, type.lowMidi, type.highMidi);
    let tessituraScore = rangeScore;
    if (tessitura) {
      // A tessitura should sit in the middle of its type's band, not at an edge.
      const typeCenter = (type.lowMidi + type.highMidi) / 2;
      const distance = Math.abs((tessitura.centerMidi ?? typeCenter) - typeCenter);
      tessituraScore = Math.max(0, 1 - distance / 12);
    }
    const score = tessitura ? 0.7 * tessituraScore + 0.3 * rangeScore : rangeScore;
    return { ...type, score: Number(score.toFixed(3)) };
  });

  return scored.sort((a, b) => b.score - a.score);
}

/** Fraction of [aLow,aHigh] covered by [bLow,bHigh]. */
function overlap(aLow, aHigh, bLow, bHigh) {
  const span = aHigh - aLow;
  if (span <= 0) return 0;
  const shared = Math.min(aHigh, bHigh) - Math.max(aLow, bLow);
  return Math.max(0, shared) / span;
}

/**
 * How much the result deserves to be trusted.
 *
 * Reported alongside every measurement rather than hidden, so a bad recording
 * announces itself instead of quietly producing a confident wrong answer.
 */
export function confidence(frames, range) {
  const total = frames.length;
  const voiced = frames.filter((f) => f.hz !== null);
  const voicedRatio = total ? voiced.length / total : 0;
  const meanProbability = voiced.length
    ? voiced.reduce((a, f) => a + (f.probability ?? 0), 0) / voiced.length
    : 0;
  const spanSemitones = range ? range.highMidi - range.lowMidi : 0;
  // A sweep narrower than an octave has not explored enough to classify.
  const spanScore = Math.min(1, spanSemitones / 12);

  const score = 0.4 * voicedRatio + 0.3 * meanProbability + 0.3 * spanScore;
  const reasons = [];
  if (voicedRatio < 0.4) reasons.push('recording is mostly silence or noise');
  if (meanProbability < 0.6) reasons.push('pitch was hard to track');
  if (spanSemitones < 7) {
    reasons.push(
      spanSemitones < 2
        ? 'that was one held note, not a slide — start low and climb'
        : 'range explored is too narrow to classify'
    );
  }

  return {
    score: Number(score.toFixed(3)),
    voicedRatio: Number(voicedRatio.toFixed(3)),
    meanProbability: Number(meanProbability.toFixed(3)),
    spanSemitones: Number(spanSemitones.toFixed(1)),
    direction: sweepDirection(voiced),
    usable: score >= 0.5 && spanSemitones >= 7,
    reasons,
  };
}

/**
 * Which way the sweep actually went.
 *
 * The measurement works either way -- a range is a range -- but a singer who
 * slid downward did not follow the guide, and telling them so is more useful
 * than silently accepting it.
 */
function sweepDirection(voiced) {
  if (voiced.length < 20) return 'unknown';
  const chunk = Math.floor(voiced.length / 4);
  const meanMidi = (from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += hzToMidi(voiced[i].hz);
    return sum / (to - from);
  };
  const start = meanMidi(0, chunk);
  const end = meanMidi(voiced.length - chunk, voiced.length);
  const delta = end - start;
  if (Math.abs(delta) < 3) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

/** Full analysis over a cleaned track. */
export function analyze(frames, opts = {}) {
  const voiced = frames.filter((f) => f.hz !== null);
  const midiValues = voiced.map((f) => hzToMidi(f.hz));
  const range = computeRange(midiValues);
  const tessitura = computeTessitura(frames, opts);
  const passaggio = findPassaggio(frames, opts);
  const ranking = classify(range, tessitura, opts);

  return {
    range: range && {
      low: midiToNote(range.lowMidi),
      high: midiToNote(range.highMidi),
      lowHz: Number(midiToHz(range.lowMidi).toFixed(1)),
      highHz: Number(midiToHz(range.highMidi).toFixed(1)),
      absoluteLow: midiToNote(range.absoluteLowMidi),
      absoluteHigh: midiToNote(range.absoluteHighMidi),
      semitones: Number((range.highMidi - range.lowMidi).toFixed(1)),
      octaves: Number(((range.highMidi - range.lowMidi) / 12).toFixed(2)),
    },
    tessitura: tessitura && {
      low: midiToNote(tessitura.lowMidi),
      high: midiToNote(tessitura.highMidi),
      center: midiToNote(tessitura.centerMidi),
      semitones: tessitura.highMidi - tessitura.lowMidi,
    },
    passaggio,
    ranking,
    best: ranking[0] ?? null,
    confidence: confidence(frames, range),
  };
}
