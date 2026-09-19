// Wiring: guide line, live trace, measurement, result.

import { trackPitch } from './pitch.js';
import { cleanTrack } from './clean.js';
import { analyze } from './analyze.js';
import { openMicrophone, describeDevice, record, gateRecording } from './record.js';
import { hzToMidi, midiToNote, noteToMidi } from './notes.js';

const DURATION = 10;
const NOISE_WINDOW = 1.2; // seconds of room tone before the guide starts
const DEFAULT_LOW_MIDI = noteToMidi('E2');  // bottom of the drawn staff
const DEFAULT_HIGH_MIDI = noteToMidi('C6'); // top of the drawn staff

// The staff widens to whatever the voice actually did. A fixed axis clamps a
// deep bass or a high soprano against the edge and hides the very notes they
// were proud of.
let LOW_MIDI = DEFAULT_LOW_MIDI;
let HIGH_MIDI = DEFAULT_HIGH_MIDI;

function fitAxis(points) {
  // Start from the guide's own span: it is drawn on this axis and must stay
  // on screen whatever the voice does.
  let low = DEFAULT_LOW_MIDI;
  let high = DEFAULT_HIGH_MIDI;
  for (const point of points) {
    if (point.midi === null) continue;
    if (point.midi < low) low = point.midi;
    if (point.midi > high) high = point.midi;
  }
  // Snap outward to whole octaves so the labelled rules land on C's. A voice
  // that stayed inside the default span leaves the axis exactly as it was.
  LOW_MIDI = Math.min(DEFAULT_LOW_MIDI, Math.floor(low / 12) * 12);
  HIGH_MIDI = Math.max(DEFAULT_HIGH_MIDI, Math.ceil(high / 12) * 12);
}

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const startButton = document.getElementById('start');
const againButton = document.getElementById('again');
const groupSelect = document.getElementById('group');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const themeButton = document.getElementById('theme');

let live = [];       // {t, midi} drawn during recording
let recording = false;
let elapsed = 0;
let lastResult = null; // kept so a resize or theme flip redraws the overlay too

// ---------------------------------------------------------------- theme

function paint(theme) {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('vocalprint-theme', theme); } catch { /* private mode */ }
  draw();
}
themeButton.addEventListener('click', () => {
  paint(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
try {
  const saved = localStorage.getItem('vocalprint-theme');
  if (saved) paint(saved);
  else if (matchMedia('(prefers-color-scheme: dark)').matches) paint('dark');
} catch { /* private mode: stay light */ }

// ---------------------------------------------------------------- canvas

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function resize() {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}
window.addEventListener('resize', resize);

function toY(midi, height) {
  const clamped = Math.max(LOW_MIDI, Math.min(HIGH_MIDI, midi));
  return height - ((clamped - LOW_MIDI) / (HIGH_MIDI - LOW_MIDI)) * (height - 28) - 14;
}

/** The guide: low at the start, high at the end, with room tone in front. */
function guideMidi(t) {
  if (t < NOISE_WINDOW) return null;
  const progress = (t - NOISE_WINDOW) / (DURATION - NOISE_WINDOW);
  // Anchored to the default axis, not the fitted one: the guide must not move
  // under the singer while they are following it.
  return DEFAULT_LOW_MIDI + 4 + progress * (DEFAULT_HIGH_MIDI - DEFAULT_LOW_MIDI - 8);
}

function drawStaff() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);

  // Octave rules, labelled. The data is the interface: these are real notes.
  ctx.font = '11px Arial, Helvetica, sans-serif';
  ctx.textBaseline = 'middle';
  for (let midi = Math.ceil(LOW_MIDI / 12) * 12; midi <= HIGH_MIDI; midi += 12) {
    const y = toY(midi, h);
    ctx.strokeStyle = css('--faint');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(34, y + 0.5);
    ctx.lineTo(w - 8, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = css('--mid');
    ctx.fillText(midiToNote(midi), 8, y);
  }

  // The guide line itself.
  ctx.strokeStyle = css('--faint');
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  let started = false;
  for (let t = NOISE_WINDOW; t <= DURATION; t += 0.05) {
    const x = 34 + (t / DURATION) * (w - 42);
    const y = toY(guideMidi(t), h);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Room-tone zone, before the guide begins.
  if (recording && elapsed < NOISE_WINDOW) {
    ctx.fillStyle = css('--faint');
    ctx.globalAlpha = 0.28;
    ctx.fillRect(34, 8, (NOISE_WINDOW / DURATION) * (w - 42), h - 16);
    ctx.globalAlpha = 1;
  }

  // Playhead.
  if (recording) {
    const x = 34 + (elapsed / DURATION) * (w - 42);
    ctx.strokeStyle = css('--mark');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x, h - 8);
    ctx.stroke();
  }
}

/** The measured voice itself. Painted last so nothing sits on top of it. */
function drawTrace() {
  if (!live.length) return;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  ctx.strokeStyle = css('--trace');
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let pen = false;
  for (const point of live) {
    if (point.midi === null) { pen = false; continue; }
    const x = 34 + (point.t / DURATION) * (w - 42);
    const y = toY(point.midi, h);
    if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Repaint everything, in back-to-front order. */
function draw() {
  drawStaff();
  if (lastResult) overlayResult(lastResult);
  drawTrace();
}

/** Overlay the finished measurement: range band, tessitura band, passaggio. */
function overlayResult(result) {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (!result.range) return;

  // Bands are drawn as bracketed edges, not filled blocks: a wash of colour
  // across the staff swallows the trace, which is the thing worth looking at.
  const band = (lowNote, highNote, label, solid) => {
    const top = toY(noteToMidi(highNote), h);
    const bottom = toY(noteToMidi(lowNote), h);
    const left = 34;
    const right = w - 8;

    ctx.fillStyle = css('--mark');
    ctx.globalAlpha = solid ? 0.07 : 0.035;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = css('--mark');
    ctx.lineWidth = 1;
    ctx.globalAlpha = solid ? 0.9 : 0.45;
    ctx.setLineDash(solid ? [] : [4, 4]);
    ctx.beginPath();
    ctx.moveTo(left, top + 0.5);
    ctx.lineTo(right, top + 0.5);
    ctx.moveTo(left, bottom - 0.5);
    ctx.lineTo(right, bottom - 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = css('--mark');
    ctx.font = '10px Arial, Helvetica, sans-serif';
    ctx.fillText(label, left + 5, top - 6);
    ctx.globalAlpha = 1;
  };
  band(result.range.low, result.range.high, 'range', false);
  if (result.tessitura) band(result.tessitura.low, result.tessitura.high, 'tessitura', true);

  if (result.passaggio) {
    const y = toY(result.passaggio.midi, h);
    ctx.strokeStyle = css('--mark');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(34, y);
    ctx.lineTo(w - 8, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css('--mark');
    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('register shift', w - 12, y - 7);
    ctx.textAlign = 'left';
  }
}

// ---------------------------------------------------------------- run

async function run() {
  startButton.disabled = true;
  resultEl.classList.remove('on');
  live = [];
  lastResult = null;
  LOW_MIDI = DEFAULT_LOW_MIDI;
  HIGH_MIDI = DEFAULT_HIGH_MIDI;
  elapsed = 0;
  let stream;

  try {
    statusEl.classList.remove('bad');
    statusEl.textContent = 'asking for the microphone…';
    stream = await openMicrophone();
  } catch (error) {
    statusEl.classList.add('bad');
    statusEl.textContent = `no microphone: ${error.message}. nothing can be measured without it.`;
    startButton.disabled = false;
    return;
  }

  const device = describeDevice(stream);
  recording = true;

  // Live trace: cheap per-chunk pitch so the line appears as you sing.
  let sampleRate = 48000;
  const onProgress = ({ progress, level }) => {
    elapsed = progress * DURATION;
    statusEl.textContent =
      elapsed < NOISE_WINDOW
        ? `measuring the room — stay quiet (${(NOISE_WINDOW - elapsed).toFixed(1)}s)`
        : `singing — follow the line (${(DURATION - elapsed).toFixed(1)}s)`;
    if (level < 0.005) live.push({ t: elapsed, midi: null });
    fitAxis(live);
    draw();
  };

  let captured;
  try {
    captured = await record(stream, DURATION, onProgress, NOISE_WINDOW);
    sampleRate = captured.sampleRate;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    recording = false;
  }

  statusEl.textContent = 'measuring…';

  const gate = gateRecording(captured);
  // Analyse only what comes after the room-tone window.
  const voiceStart = Math.floor(NOISE_WINDOW * sampleRate);
  const voice = captured.samples.subarray(voiceStart);

  const raw = trackPitch(voice, sampleRate, { frameSize: 2048, hopSize: 512 });
  const frames = cleanTrack(raw, { minRms: Math.max(0.008, captured.noiseFloor * 2.5) });
  const result = analyze(frames, { group: groupSelect.value || null });

  // Replace the live trace with the cleaned one -- what was measured is what shows.
  live = frames.map((f) => ({
    t: NOISE_WINDOW + f.t,
    midi: f.hz === null ? null : hzToMidi(f.hz),
  }));
  lastResult = result;
  fitAxis(live);
  draw();

  render(result, gate, device);
  startButton.disabled = false;
}

// ---------------------------------------------------------------- render

function render(result, gate, device) {
  const verdict = document.getElementById('verdict');
  const grid = document.getElementById('grid');
  const rank = document.getElementById('rank');
  const caveat = document.getElementById('caveat');

  const usable = gate.ok && result.confidence.usable && result.range;

  if (!usable) {
    const reasons = [...gate.problems, ...result.confidence.reasons];
    verdict.innerHTML =
      'not enough to measure' +
      `<span class="qual">${reasons.join(' · ') || 'no usable voice in the recording'}</span>`;
    grid.innerHTML = '';
    rank.innerHTML = '';
    const advice = [];
    if (gate.problems.some((p) => p.includes('room'))) {
      advice.push('find a quieter room, or move closer to the mic.');
    }
    if (gate.problems.some((p) => p.includes('clipping'))) {
      advice.push('move back from the mic — the input is overloading.');
    }
    if (gate.problems.some((p) => p.includes('barely'))) {
      advice.push('check that the right microphone is selected, and sing up.');
    }
    if (result.confidence.reasons.some((r) => r.includes('one held note'))) {
      advice.push('this needs a slide, not a single note: start at your lowest and climb steadily to your highest.');
    } else if (result.confidence.reasons.some((r) => r.includes('narrow'))) {
      advice.push('go further in both directions — at least an octave is needed to place a voice.');
    }
    if (result.confidence.reasons.some((r) => r.includes('hard to track'))) {
      advice.push('sing a steady open “aah” rather than a breathy or whispered tone.');
    }
    if (!advice.length) advice.push('try again with one long, steady slide from low to high.');

    caveat.innerHTML =
      '<p class="wide">nothing was classified, because a number produced from this recording would be wrong.</p>' +
      advice.map((line) => `<p>${line}</p>`).join('');
    statusEl.classList.add('bad');
    statusEl.textContent = 'recording rejected — see below.';
    resultEl.classList.add('on');
    return;
  }

  statusEl.classList.remove('bad');
  const direction = result.confidence.direction;
  statusEl.textContent =
    direction === 'down'
      ? 'done — you slid downward; the numbers hold either way.'
      : 'done.';

  // The claim is band membership, never identity.
  const best = result.best;
  verdict.innerHTML =
    `your voice sits in the <span style="color:var(--mark)">${best.label.toLowerCase()}</span> band` +
    `<span class="qual">${result.range.low}–${result.range.high} · ${result.range.octaves} octaves` +
    (result.tessitura ? ` · comfortable around ${result.tessitura.center}` : '') +
    '</span>';

  const cells = [
    ['range', `${result.range.low}–${result.range.high}`,
      `${result.range.semitones} semitones · ${result.range.lowHz}–${result.range.highHz} Hz`],
    ['tessitura', result.tessitura ? `${result.tessitura.low}–${result.tessitura.high}` : '—',
      result.tessitura ? `centred on ${result.tessitura.center}` : 'not enough steady singing'],
    ['register shift', result.passaggio ? result.passaggio.note : 'none found',
      result.passaggio ? `strength ${result.passaggio.strength}` : 'sweep was too even to locate one'],
    ['widest reach', `${result.range.absoluteLow}–${result.range.absoluteHigh}`,
      'including the notes that cracked'],
    ['confidence', `${Math.round(result.confidence.score * 100)}%`,
      `${Math.round(result.confidence.voicedRatio * 100)}% voiced · ${gate.snrDb ?? '—'} dB signal`],
  ];
  grid.innerHTML = cells
    .map(([k, v, n]) => {
      const long = String(v).length > 9 ? ' small' : '';
      return `<div class="cell"><div class="k">${k}</div><div class="v${long}">${v}</div><div class="n">${n}</div></div>`;
    })
    .join('');

  rank.innerHTML =
    '<tr><th>band</th><th>conventional range</th><th class="n">fit</th></tr>' +
    result.ranking
      .map(
        (t, i) => `<tr class="${i === 0 ? 'top' : ''}">
          <td>${t.label.toLowerCase()}<span class="meter"><i style="width:${Math.round(t.score * 100)}%"></i></span></td>
          <td>${t.low}–${t.high}</td>
          <td class="n">${Math.round(t.score * 100)}%</td>
        </tr>`
      )
      .join('');

  const groupNote = groupSelect.value
    ? ''
    : '<p>you compared against all six bands. male and female bands overlap heavily, so narrowing the comparison gives a sharper answer.</p>';

  const directionNote =
    direction === 'down'
      ? '<p>you slid from high to low rather than low to high. range and tessitura are unaffected, but the register shift is easier to place on a rising slide.</p>'
      : direction === 'flat'
        ? '<p>the slide stayed fairly level. the wider you range, the more confidently a band can be placed.</p>'
        : '';

  caveat.innerHTML =
    groupNote +
    directionNote +
    '<p><b>what this measures.</b> pitch, and only pitch. range is the span you reached, tessitura is where your voice settled and stayed steady — that second one tracks voice type more closely than range does.</p>' +
    '<p><b>what it does not.</b> timbre. real classification also weighs the colour of the voice, which needs a trained singing tone to measure reliably, so it is left out rather than guessed at.</p>' +
    '<p><b>so it says “band”, not “you are”.</b> a voice type is decided by a teacher over months, across repertoire. this is one sweep in one room on one mic.</p>' +
    `<p class="wide">measured on: ${escapeHtml(device)} · ${gate.snrDb ?? '—'} dB above the room.</p>`;

  resultEl.classList.add('on');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

startButton.addEventListener('click', run);
againButton.addEventListener('click', () => {
  resultEl.classList.remove('on');
  live = [];
  lastResult = null;
  LOW_MIDI = DEFAULT_LOW_MIDI;
  HIGH_MIDI = DEFAULT_HIGH_MIDI;
  draw();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

resize();
