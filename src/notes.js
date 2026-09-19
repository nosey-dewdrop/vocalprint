// Pitch <-> note conversion, in scientific pitch notation (middle C = C4).
// A4 = 440 Hz, twelve-tone equal temperament.

const A4_HZ = 440;
const A4_MIDI = 69;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Interval in semitones from `reference` to `hz`. Positive means higher. */
export function hzToSemitones(hz, reference) {
  return 12 * Math.log2(hz / reference);
}

export function hzToMidi(hz) {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

export function midiToHz(midi) {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Nearest note name, e.g. 261.6 -> "C4". */
export function hzToNote(hz) {
  const midi = Math.round(hzToMidi(hz));
  return midiToNote(midi);
}

export function midiToNote(midi) {
  const rounded = Math.round(midi);
  const name = NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

/** Parse "C4" / "A#3" back to a MIDI number. */
export function noteToMidi(note) {
  const match = /^([A-G]#?)(-?\d+)$/.exec(note.trim());
  if (!match) throw new Error(`not a note: ${note}`);
  const index = NAMES.indexOf(match[1]);
  if (index === -1) throw new Error(`not a note: ${note}`);
  return (Number(match[2]) + 1) * 12 + index;
}

export function noteToHz(note) {
  return midiToHz(noteToMidi(note));
}

/** How far hz sits from the nearest note, in cents. Range -50..+50. */
export function centsOff(hz) {
  const midi = hzToMidi(hz);
  return Math.round((midi - Math.round(midi)) * 100);
}

// Conventional ranges. These are the textbook classification bands -- the
// span a voice of each type is expected to cover in choral/operatic practice,
// not the extremes any individual can reach.
//
// Sources: Wikipedia "Soprano" and the SUNY Music Appreciation vocal-range
// chapter; both give the same bands, which is the convention we classify
// against. Female and male groups are kept separate because the bands overlap
// heavily across that divide.
export const VOICE_TYPES = [
  { id: 'soprano', label: 'Soprano', group: 'female', low: 'C4', high: 'C6' },
  { id: 'mezzo', label: 'Mezzo-soprano', group: 'female', low: 'A3', high: 'A5' },
  { id: 'contralto', label: 'Contralto / Alto', group: 'female', low: 'F3', high: 'F5' },
  { id: 'tenor', label: 'Tenor', group: 'male', low: 'C3', high: 'C5' },
  { id: 'baritone', label: 'Baritone', group: 'male', low: 'A2', high: 'A4' },
  { id: 'bass', label: 'Bass', group: 'male', low: 'E2', high: 'E4' },
].map((t) => ({ ...t, lowMidi: noteToMidi(t.low), highMidi: noteToMidi(t.high) }));
