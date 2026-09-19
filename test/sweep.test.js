import test from 'node:test';
import assert from 'node:assert/strict';

import { trackPitch } from '../src/pitch.js';
import { cleanTrack } from '../src/clean.js';
import { analyze } from '../src/analyze.js';
import { noteToHz } from '../src/notes.js';

const SR = 44100;

/**
 * A voice-like glissando.
 *
 * Frequency is integrated sample by sample and vibrato modulates the
 * *frequency*, not the accumulated phase. Doing it the other way round looks
 * plausible and produces a signal whose real pitch is nowhere near the
 * intended one -- verified here by the zero-crossing test below, which exists
 * because an earlier version of this generator was wrong and quietly made the
 * tracker look broken.
 */
function voiceSweep(lowHz, highHz, seconds, opts = {}) {
  const vibratoCents = opts.vibratoCents ?? 35;
  const vibratoRate = opts.vibratoRate ?? 5.5;
  const noise = opts.noise ?? 0.012;
  const harmonics = opts.harmonics ?? [0.4, 0.25, 0.15, 0.08, 0.04];

  const count = Math.floor(seconds * SR);
  const out = new Float32Array(count);
  const ratio = highHz / lowHz;
  let phase = 0;

  for (let i = 0; i < count; i++) {
    const t = i / SR;
    const vibrato = Math.pow(2, (vibratoCents / 1200) * Math.sin(2 * Math.PI * vibratoRate * t));
    const hz = lowHz * Math.pow(ratio, t / seconds) * vibrato;
    phase += (2 * Math.PI * hz) / SR;
    let sample = 0;
    for (let h = 0; h < harmonics.length; h++) sample += harmonics[h] * Math.sin((h + 1) * phase);
    const envelope = Math.min(1, t / 0.15, (seconds - t) / 0.15);
    out[i] = sample * 0.7 * envelope + (Math.random() * 2 - 1) * noise;
  }
  return out;
}

/**
 * Mean frequency over a window, measured from zero crossings.
 *
 * Counting crossings as integers quantizes badly at low pitch (a 2048-sample
 * window holds only ~14 cycles at 156 Hz, so half a cycle of rounding is ~3%).
 * Instead we interpolate the exact sub-sample position of the first and last
 * upward crossing and divide by the whole cycles between them, which removes
 * the quantization entirely.
 */
function zeroCrossingHz(signal, at, window = 2048) {
  const end = Math.min(at + window, signal.length);

  // Hysteresis: the signal must swing past +/-10% of its own peak before the
  // next crossing counts. Without it, noise straddling zero registers several
  // spurious crossings per cycle and the reported frequency jumps -- which
  // made this test fail about one run in five.
  let peak = 0;
  for (let i = at; i < end; i++) peak = Math.max(peak, Math.abs(signal[i]));
  const gate = peak * 0.1;

  const crossings = [];
  let armed = false; // true once the signal has gone convincingly negative
  for (let i = at + 1; i < end; i++) {
    if (signal[i] < -gate) armed = true;
    if (armed && signal[i - 1] < 0 && signal[i] >= 0) {
      // Linear interpolation for where the signal actually crossed zero.
      crossings.push(i - 1 + signal[i - 1] / (signal[i - 1] - signal[i]));
      armed = false;
    }
  }
  if (crossings.length < 2) return 0;
  const cycles = crossings.length - 1;
  const span = crossings[crossings.length - 1] - crossings[0];
  return (cycles * SR) / span;
}

test('the test generator produces the pitch it claims', () => {
  // Guards the tests themselves. Without this, a broken generator makes every
  // downstream assertion meaningless.
  const seconds = 8;
  const low = 130.81;
  const high = 523.25;
  const signal = voiceSweep(low, high, seconds, { vibratoCents: 0, harmonics: [1] });
  const window = 2048;
  for (const t of [1, 3, 5, 7]) {
    // The measurement averages over the window, so compare against the mean of
    // the intended frequency over that same span, not a point value.
    const from = t;
    const to = t + window / SR;
    const k = Math.log(high / low) / seconds;
    const expected = (low / (k * (to - from))) * (Math.exp(k * to) - Math.exp(k * from));
    const measured = zeroCrossingHz(signal, Math.floor(t * SR), window);
    const error = Math.abs(1200 * Math.log2(measured / expected));
    assert.ok(error < 15, `at ${t}s expected ~${expected.toFixed(1)} Hz, generator gave ${measured.toFixed(1)}`);
  }
});

const CASES = [
  { label: 'bass', low: 'E2', high: 'E4', group: 'male', expect: 'bass' },
  { label: 'tenor', low: 'C3', high: 'C5', group: 'male', expect: 'tenor' },
  { label: 'alto', low: 'F3', high: 'F5', group: 'female', expect: 'contralto' },
  { label: 'soprano', low: 'C4', high: 'C6', group: 'female', expect: 'soprano' },
];

for (const testCase of CASES) {
  test(`${testCase.label} sweep ${testCase.low}-${testCase.high} is measured end to end`, () => {
    const signal = voiceSweep(noteToHz(testCase.low), noteToHz(testCase.high), 8);
    const frames = cleanTrack(trackPitch(signal, SR, { frameSize: 2048, hopSize: 512 }), {});
    const result = analyze(frames, { group: testCase.group });

    // The extremes are the ground truth: the sweep really did start and end there.
    assert.equal(result.range.absoluteLow, testCase.low, 'bottom of sweep');
    assert.equal(result.range.absoluteHigh, testCase.high, 'top of sweep');

    // The reported range is the 5th-95th percentile, so it sits *inside* the
    // extremes by design -- never outside them.
    const inside =
      result.range.lowHz >= noteToHz(testCase.low) * 0.97 &&
      result.range.highHz <= noteToHz(testCase.high) * 1.03;
    assert.ok(inside, `percentile range ${result.range.low}-${result.range.high} escaped the sweep`);

    assert.ok(result.confidence.usable, `unusable: ${result.confidence.reasons.join(', ')}`);
    assert.equal(result.confidence.voicedRatio, 1, 'a clean sustained sweep should be fully voiced');

    // The correct band should at least be in the top two of its group.
    const position = result.ranking.findIndex((t) => t.id === testCase.expect);
    assert.ok(position <= 1, `${testCase.expect} ranked ${position + 1}: ${result.ranking.map((t) => t.id).join(' > ')}`);
  });
}

test('a noisy sweep still tracks, with lower confidence', () => {
  const clean = voiceSweep(noteToHz('C3'), noteToHz('C5'), 8, { noise: 0.012 });
  const noisy = voiceSweep(noteToHz('C3'), noteToHz('C5'), 8, { noise: 0.09 });

  const analyse = (signal) =>
    analyze(cleanTrack(trackPitch(signal, SR, { frameSize: 2048, hopSize: 512 }), {}), {
      group: 'male',
    });

  const a = analyse(clean);
  const b = analyse(noisy);
  assert.ok(b.range !== null, 'noise should degrade the measurement, not destroy it');
  assert.ok(
    b.confidence.score <= a.confidence.score,
    `noise did not reduce confidence: ${b.confidence.score} vs ${a.confidence.score}`
  );
});

test('range is reported inside the sweep even with an injected crack', () => {
  // One frame of nonsense near the top, as a cracked note would be.
  const signal = voiceSweep(noteToHz('C3'), noteToHz('C5'), 8);
  const crackAt = Math.floor(signal.length * 0.8);
  for (let i = crackAt; i < crackAt + 2048; i++) signal[i] = (Math.random() * 2 - 1) * 0.9;

  const frames = cleanTrack(trackPitch(signal, SR, { frameSize: 2048, hopSize: 512 }), {});
  const result = analyze(frames, { group: 'male' });
  assert.ok(
    result.range.highHz < noteToHz('C5') * 1.15,
    `the crack inflated the range to ${result.range.high}`
  );
});

/** A sweep that changes register at `breakHz`: thinner and quieter above it. */
function brokenSweep(lowHz, highHz, seconds, breakHz) {
  const count = Math.floor(seconds * SR);
  const out = new Float32Array(count);
  const ratio = highHz / lowHz;
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const t = i / SR;
    const hz = lowHz * Math.pow(ratio, t / seconds);
    phase += (2 * Math.PI * hz) / SR;
    const head = hz > breakHz;
    const harmonics = head ? [0.42, 0.12, 0.05, 0.02, 0.01] : [0.4, 0.25, 0.15, 0.08, 0.04];
    const gain = head ? 0.52 : 0.78;
    let sample = 0;
    for (let h = 0; h < harmonics.length; h++) sample += harmonics[h] * Math.sin((h + 1) * phase);
    const envelope = Math.min(1, t / 0.15, (seconds - t) / 0.15);
    out[i] = sample * gain * envelope + (Math.random() * 2 - 1) * 0.008;
  }
  return out;
}

test('a register break is found at the pitch where it happens', () => {
  const breakHz = noteToHz('G4');
  const signal = brokenSweep(noteToHz('C3'), noteToHz('C5'), 8, breakHz);
  const frames = cleanTrack(trackPitch(signal, SR, { frameSize: 2048, hopSize: 512 }), {});
  const result = analyze(frames, { group: 'male' });

  assert.ok(result.passaggio !== null, 'an obvious 42% loudness step was not detected');
  const off = Math.abs(1200 * Math.log2(noteToHz(result.passaggio.note) / breakHz));
  assert.ok(off < 300, `break was at G4 but reported at ${result.passaggio.note}`);
});

test('an even sweep reports no register break', () => {
  // The detector must not invent one: a false passaggio is worse than none.
  const signal = voiceSweep(noteToHz('C3'), noteToHz('C5'), 8);
  const frames = cleanTrack(trackPitch(signal, SR, { frameSize: 2048, hopSize: 512 }), {});
  const result = analyze(frames, { group: 'male' });
  assert.equal(result.passaggio, null, `invented a break at ${result.passaggio?.note}`);
});

/** A sweep interrupted by a breath: silence, then the voice returns. */
function breathySweep(lowHz, highHz, seconds, breathAt, breathFor = 0.45) {
  const out = voiceSweep(lowHz, highHz, seconds);
  const from = Math.floor(breathAt * SR);
  const to = Math.floor((breathAt + breathFor) * SR);
  for (let i = from; i < to && i < out.length; i++) {
    // Not digital silence: a breath is quiet turbulent noise.
    out[i] = (Math.random() * 2 - 1) * 0.004;
  }
  return out;
}

test('a breath mid-sweep is not reported as a register break', () => {
  // The loudness step at a breath is larger than most real passaggi, so a
  // detector that only looks at loudness will happily call it one.
  const signal = breathySweep(noteToHz('C3'), noteToHz('C5'), 8, 4.0);
  const frames = cleanTrack(trackPitch(signal, SR, { frameSize: 2048, hopSize: 512 }), {});
  const result = analyze(frames, { group: 'male' });
  assert.equal(
    result.passaggio,
    null,
    `a breath was misread as a register shift at ${result.passaggio?.note}`
  );
});

test('a real break is still found when the sweep also contains a breath', () => {
  const breakHz = noteToHz('G4');
  const signal = brokenSweep(noteToHz('C3'), noteToHz('C5'), 8, breakHz);
  // Breath early, well away from the break.
  const from = Math.floor(1.6 * SR);
  for (let i = from; i < from + Math.floor(0.4 * SR); i++) {
    signal[i] = (Math.random() * 2 - 1) * 0.004;
  }
  const frames = cleanTrack(trackPitch(signal, SR, { frameSize: 2048, hopSize: 512 }), {});
  const result = analyze(frames, { group: 'male' });
  assert.ok(result.passaggio !== null, 'the real break was lost');
  const off = Math.abs(1200 * Math.log2(noteToHz(result.passaggio.note) / breakHz));
  assert.ok(off < 300, `break at G4 reported at ${result.passaggio.note}`);
});
