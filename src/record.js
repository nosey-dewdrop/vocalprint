// Microphone capture and the quality gate.
//
// The gate is the point: a bad recording must announce itself instead of
// quietly producing a confident wrong answer. We measure the room before the
// voice, so noise can be subtracted rather than measured as singing.

/** Ask for the mic. Throws with a readable reason if refused or absent. */
export async function openMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('this browser cannot reach the microphone');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false, // would distort the harmonics we measure
      noiseSuppression: false,
      autoGainControl: false, // would flatten the loudness contour passaggio needs
    },
  });
}

/** Label for whatever mic is actually in use -- it belongs on the result. */
export function describeDevice(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return 'unknown input';
  return track.label || 'unnamed input';
}

/**
 * Record `seconds` of mono audio, reporting progress as it goes.
 * Returns { samples, sampleRate, noiseFloor }.
 */
export async function record(stream, seconds, onProgress, noiseSeconds = 0.6) {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  await context.resume();

  const source = context.createMediaStreamSource(stream);
  const bufferSize = 4096;
  const processor = context.createScriptProcessor(bufferSize, 1, 1);
  const chunks = [];
  let collected = 0;
  const target = Math.floor(seconds * context.sampleRate);

  const done = new Promise((resolve) => {
    processor.onaudioprocess = (event) => {
      if (collected >= target) return;
      const input = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      collected += input.length;
      if (onProgress) {
        onProgress({
          progress: Math.min(1, collected / target),
          level: peak(input),
          elapsed: collected / context.sampleRate,
        });
      }
      if (collected >= target) resolve();
    };
  });

  source.connect(processor);
  processor.connect(context.destination);
  await done;
  processor.disconnect();
  source.disconnect();

  const samples = new Float32Array(collected);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk.subarray(0, Math.min(chunk.length, collected - offset)), offset);
    offset += chunk.length;
  }

  const sampleRate = context.sampleRate;
  await context.close();

  // The opening stretch is the room, recorded before anyone sings.
  const noiseSamples = samples.subarray(0, Math.floor(noiseSeconds * sampleRate));
  return { samples, sampleRate, noiseFloor: rms(noiseSamples) };
}

/**
 * Decide whether a recording is worth analysing.
 *
 * Refusing here is the honest move: a 6 dB signal-to-noise recording will still
 * produce a number, and that number will be wrong.
 */
export function gateRecording({ samples, noiseFloor }, opts = {}) {
  const minSnrDb = opts.minSnrDb ?? 12;
  const minLevel = opts.minLevel ?? 0.01;

  const level = rms(samples);
  const snrDb = noiseFloor > 0 ? 20 * Math.log10(level / noiseFloor) : Infinity;
  const clipped = countClipped(samples) / samples.length;

  const problems = [];
  if (level < minLevel) problems.push('barely any sound reached the mic');
  if (snrDb < minSnrDb) problems.push('the room is almost as loud as the voice');
  if (clipped > 0.01) problems.push('the input is clipping — move back from the mic');

  return {
    ok: problems.length === 0,
    problems,
    level: Number(level.toFixed(4)),
    snrDb: Number.isFinite(snrDb) ? Number(snrDb.toFixed(1)) : null,
    clippedRatio: Number(clipped.toFixed(4)),
  };
}

function rms(buffer) {
  if (!buffer.length) return 0;
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function peak(buffer) {
  let max = 0;
  for (let i = 0; i < buffer.length; i++) {
    const value = Math.abs(buffer[i]);
    if (value > max) max = value;
  }
  return max;
}

function countClipped(buffer) {
  let count = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (Math.abs(buffer[i]) > 0.99) count++;
  }
  return count;
}
