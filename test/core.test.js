import test from 'node:test';
import assert from 'node:assert/strict';

import { detectPitch, trackPitch } from '../src/pitch.js';
import { cleanTrack, repairOctaves, enforceContinuity } from '../src/clean.js';
import { hzToNote, noteToHz, noteToMidi, midiToNote, centsOff, hzToMidi } from '../src/notes.js';
import { percentile, computeRange, computeTessitura, analyze, confidence } from '../src/analyze.js';

const SR = 44100;

// A sawtooth, not a sine: a sine has no harmonics, and a pitch tracker that
// only works on sines proves nothing about a voice.
function saw(hz, seconds, sampleRate = SR, amplitude = 0.5) {
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    const phase = (i * hz / sampleRate) % 1;
    out[i] = amplitude * (2 * phase - 1);
  }
  return out;
}

/** Sawtooth sweeping exponentially from lowHz to highHz -- a glissando. */
function sweep(lowHz, highHz, seconds, sampleRate = SR, amplitude = 0.5) {
  const out = new Float32Array(Math.floor(seconds * sampleRate));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / out.length;
    const hz = lowHz * Math.pow(highHz / lowHz, t);
    phase = (phase + hz / sampleRate) % 1;
    out[i] = amplitude * (2 * phase - 1);
  }
  return out;
}

function silence(seconds, sampleRate = SR) {
  return new Float32Array(Math.floor(seconds * sampleRate));
}

function concat(...parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------- notes

test('note conversion round-trips', () => {
  for (const note of ['E2', 'A2', 'C3', 'F3', 'A3', 'C4', 'A4', 'C5', 'F5', 'C6']) {
    assert.equal(hzToNote(noteToHz(note)), note);
    assert.equal(midiToNote(noteToMidi(note)), note);
  }
});

test('A4 is 440 Hz and middle C is C4', () => {
  assert.equal(noteToHz('A4'), 440);
  assert.ok(Math.abs(noteToHz('C4') - 261.63) < 0.01);
  assert.equal(hzToNote(440), 'A4');
});

test('centsOff reports deviation from the nearest note', () => {
  assert.equal(centsOff(440), 0);
  assert.ok(centsOff(440 * Math.pow(2, 25 / 1200)) === 25);
  assert.ok(centsOff(440 * Math.pow(2, -25 / 1200)) === -25);
});

// ---------------------------------------------------------------- pitch

test('detectPitch finds a known pitch within 1 cent', () => {
  for (const hz of [82.41, 130.81, 220, 440, 880]) {
    const signal = saw(hz, 0.2);
    const frame = signal.subarray(0, 4096);
    const { hz: found, probability } = detectPitch(frame, SR, { minHz: 60, maxHz: 1600 });
    assert.ok(found !== null, `no pitch found for ${hz}`);
    const cents = Math.abs(1200 * Math.log2(found / hz));
    assert.ok(cents < 1, `${hz} Hz detected as ${found} (${cents.toFixed(1)} cents off)`);
    assert.ok(probability > 0.8, `low confidence ${probability} for ${hz}`);
  }
});

test('detectPitch reports nothing for silence and for noise', () => {
  const quiet = detectPitch(silence(0.1).subarray(0, 4096), SR);
  assert.equal(quiet.hz, null);

  const noise = new Float32Array(4096);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.5;
  const result = detectPitch(noise, SR, { threshold: 0.1 });
  // Noise may occasionally yield a candidate, but never a confident one.
  assert.ok(result.hz === null || result.probability < 0.8);
});

test('pitch detection survives additive noise at 20 dB SNR', () => {
  const clean = saw(220, 0.2);
  const noisy = Float32Array.from(clean, (v) => v + (Math.random() * 2 - 1) * 0.05);
  const { hz } = detectPitch(noisy.subarray(0, 4096), SR);
  assert.ok(hz !== null);
  assert.ok(Math.abs(1200 * Math.log2(hz / 220)) < 20, `got ${hz}`);
});

test('trackPitch follows a sweep monotonically upward', () => {
  const frames = cleanTrack(trackPitch(sweep(150, 600, 2), SR), {});
  const voiced = frames.filter((f) => f.hz !== null);
  assert.ok(voiced.length > 50, `only ${voiced.length} voiced frames`);
  assert.ok(voiced[0].hz < 200, `starts at ${voiced[0].hz}`);
  assert.ok(voiced[voiced.length - 1].hz > 500, `ends at ${voiced.at(-1).hz}`);

  // Monotonic to within a semitone of jitter.
  let regressions = 0;
  for (let i = 1; i < voiced.length; i++) {
    if (voiced[i].hz < voiced[i - 1].hz * Math.pow(2, -1 / 12)) regressions++;
  }
  assert.ok(regressions === 0, `${regressions} downward jumps in a rising sweep`);
});

// ---------------------------------------------------------------- cleaning

test('repairOctaves pulls a doubled frame back onto the trend', () => {
  const frames = Array.from({ length: 21 }, (_, i) => ({
    t: i * 0.01, hz: 220, probability: 0.9, rms: 0.3,
  }));
  frames[10].hz = 440; // octave error

  const repaired = repairOctaves(frames);
  assert.ok(Math.abs(repaired[10].hz - 220) < 1, `got ${repaired[10].hz}`);
  assert.equal(repaired[10].repaired, true);
  // Untouched frames stay exactly as they were.
  assert.equal(repaired[5].hz, 220);
  assert.equal(repaired[5].repaired, undefined);
});

test('repairOctaves handles a halved frame too', () => {
  const frames = Array.from({ length: 21 }, (_, i) => ({
    t: i * 0.01, hz: 330, probability: 0.9, rms: 0.3,
  }));
  frames[10].hz = 165;
  const repaired = repairOctaves(frames);
  assert.ok(Math.abs(repaired[10].hz - 330) < 1, `got ${repaired[10].hz}`);
});

test('repairOctaves leaves a real non-octave excursion alone', () => {
  const frames = Array.from({ length: 21 }, (_, i) => ({
    t: i * 0.01, hz: 220, probability: 0.9, rms: 0.3,
  }));
  frames[10].hz = 277.18; // a major third up, not an octave
  const repaired = repairOctaves(frames);
  assert.ok(Math.abs(repaired[10].hz - 277.18) < 0.01);
});

test('enforceContinuity drops an isolated wild frame', () => {
  const frames = Array.from({ length: 21 }, (_, i) => ({
    t: i * 0.01, hz: 220, probability: 0.9, rms: 0.3,
  }));
  frames[10].hz = 700; // not an octave multiple, just wrong
  const out = enforceContinuity(frames);
  assert.equal(out[10].hz, null);
  assert.equal(out[10].rejected, true);
});

test('enforceContinuity keeps a sustained leap', () => {
  // Voice jumps up and stays there: real, must survive.
  const frames = Array.from({ length: 21 }, (_, i) => ({
    t: i * 0.01, hz: i < 10 ? 220 : 440, probability: 0.9, rms: 0.3,
  }));
  const out = enforceContinuity(frames);
  const survived = out.filter((f) => f.hz !== null).length;
  assert.equal(survived, 21, 'a sustained register leap was wrongly discarded');
});

test('cleaning a sweep with injected octave errors recovers the truth', () => {
  const frames = trackPitch(sweep(200, 400, 2), SR);
  const damaged = frames.map((f, i) =>
    f.hz !== null && i % 17 === 0 ? { ...f, hz: f.hz * 2 } : f
  );
  const cleaned = cleanTrack(damaged, {});
  const reference = cleanTrack(frames, {});

  const voicedCleaned = cleaned.filter((f) => f.hz !== null);
  const voicedReference = reference.filter((f) => f.hz !== null);
  assert.ok(voicedCleaned.length > voicedReference.length * 0.9);

  const maxMidi = Math.max(...voicedCleaned.map((f) => hzToMidi(f.hz)));
  const referenceMax = Math.max(...voicedReference.map((f) => hzToMidi(f.hz)));
  assert.ok(
    maxMidi - referenceMax < 1.5,
    `octave errors leaked into the range: ${maxMidi} vs ${referenceMax}`
  );
});

// ---------------------------------------------------------------- analysis

test('percentile interpolates', () => {
  const values = [1, 2, 3, 4, 5];
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile(values, 1), 5);
  assert.equal(percentile(values, 0.5), 3);
  assert.equal(percentile(values, 0.25), 2);
});

test('percentile range ignores a single cracked note', () => {
  // Forty frames around A3, one wild frame an octave up.
  const midiValues = Array.from({ length: 40 }, () => 57);
  midiValues.push(69);
  const range = computeRange(midiValues);
  assert.equal(range.highMidi, 57, 'outlier widened the usable range');
  assert.equal(range.absoluteHighMidi, 69, 'absolute extreme should still be kept');
});

test('tessitura lands on the note the voice sits on', () => {
  // Long steady A3, brief excursion to A4: tessitura must stay at A3.
  const steady = saw(220, 3);
  const brief = saw(440, 0.3);
  const frames = cleanTrack(trackPitch(concat(steady, brief), SR), {});
  const tessitura = computeTessitura(frames);
  assert.ok(tessitura !== null);
  assert.equal(midiToNote(Math.round(tessitura.centerMidi)), 'A3');
});

test('analyze reports a plausible range for a sweep', () => {
  // C3 to C5 -- the textbook tenor span.
  const signal = sweep(noteToHz('C3'), noteToHz('C5'), 4);
  const frames = cleanTrack(trackPitch(signal, SR), {});
  const result = analyze(frames, { group: 'male' });

  assert.ok(result.range !== null);
  assert.ok(result.range.semitones > 18, `span only ${result.range.semitones}`);
  assert.ok(result.confidence.usable, `unusable: ${result.confidence.reasons}`);
  assert.equal(result.ranking.length, 3, 'male group should score three types');
  assert.ok(result.ranking[0].score >= result.ranking[1].score);
});

test('confidence refuses a single held note, and says so specifically', () => {
  const frames = cleanTrack(trackPitch(saw(220, 1), SR), {});
  const midiValues = frames.filter((f) => f.hz !== null).map((f) => hzToMidi(f.hz));
  const result = confidence(frames, computeRange(midiValues));
  assert.equal(result.usable, false);
  // One steady note is a different mistake from a short slide, and the advice
  // it needs is different too -- so the reason has to distinguish them.
  assert.ok(
    result.reasons.some((r) => r.includes('one held note')),
    `expected a held-note reason, got: ${result.reasons.join(' | ')}`
  );
  assert.equal(result.direction, 'flat');
});

test('confidence refuses a slide that is too short', () => {
  // Wide enough not to be a held note, still too narrow to place a voice.
  const frames = [];
  for (let i = 0; i < 120; i++) {
    frames.push({ t: i * 0.012, hz: 220 * Math.pow(2, (i / 120) * (4 / 12)), probability: 0.9, rms: 0.3 });
  }
  const midiValues = frames.map((f) => hzToMidi(f.hz));
  const result = confidence(frames, computeRange(midiValues));
  assert.equal(result.usable, false);
  assert.ok(
    result.reasons.some((r) => r.includes('narrow')),
    `expected a narrow-range reason, got: ${result.reasons.join(' | ')}`
  );
});

test('sweep direction is reported', () => {
  const rising = [];
  const falling = [];
  for (let i = 0; i < 200; i++) {
    const up = 130 * Math.pow(2, (i / 200) * 2);
    rising.push({ t: i * 0.012, hz: up, probability: 0.9, rms: 0.3 });
    falling.push({ t: i * 0.012, hz: 520 / Math.pow(2, (i / 200) * 2), probability: 0.9, rms: 0.3 });
  }
  const range = (frames) => computeRange(frames.map((f) => hzToMidi(f.hz)));
  assert.equal(confidence(rising, range(rising)).direction, 'up');
  assert.equal(confidence(falling, range(falling)).direction, 'down');
});

test('confidence refuses near-silence', () => {
  const frames = cleanTrack(trackPitch(silence(2), SR), {});
  const result = confidence(frames, null);
  assert.equal(result.usable, false);
  assert.ok(result.score < 0.5);
});

test('analyze is stable across sample rates', () => {
  const results = [44100, 48000].map((rate) => {
    const signal = sweep(noteToHz('C3'), noteToHz('C5'), 4, rate);
    const frames = cleanTrack(trackPitch(signal, rate), {});
    return analyze(frames, { group: 'male' });
  });
  const [a, b] = results;
  assert.ok(
    Math.abs(a.range.semitones - b.range.semitones) < 1,
    `range differs across sample rates: ${a.range.semitones} vs ${b.range.semitones}`
  );
  assert.equal(a.range.low, b.range.low);
  assert.equal(a.range.high, b.range.high);
});
