# vocalprint

Measure your vocal range, tessitura and register break in the browser. One long
slide from your lowest note to your highest, ten seconds, nothing uploaded.

**[Try it](https://nosey-dewdrop.github.io/vocalprint/)**

## What it measures

| | |
|---|---|
| **Range** | The span you reached, reported as the 5th–95th percentile so one cracked note does not inflate it. The true extremes are shown separately. |
| **Tessitura** | Where your voice settled *and stayed steady*. Pitch frames are binned per semitone and weighted by local stability, then the narrowest band holding 68% of that weight is taken. This tracks voice type more closely than range does. |
| **Register shift** | The passaggio: where the voice changes register, found as a step in the loudness contour between the plateau on each side. A breath produces a loudness step too, so candidates are rejected unless voicing is continuous across them and both sides are steady. Reported with its strength, or not at all when the sweep is too even to locate one. |
| **Confidence** | Voiced-frame ratio, mean YIN periodicity, and how much range was actually explored. A recording that cannot support a classification is refused rather than answered, with advice specific to what went wrong — a single held note, too short a slide, a loud room, a clipping input. |
| **Direction** | Whether the slide went up, down, or stayed level. A downward slide still measures correctly and is accepted; the page just says so, since the guide asked for the other direction. |

## What it does not measure

Timbre. Real voice classification also weighs vocal colour, and the published
reference values for that ([FHE, *Scientific Reports* 2022](https://www.nature.com/articles/s41598-022-22821-w))
come from professional opera singers, where the singer's formant is a trained
result. There is no published distribution for untrained voices, so the colour
axis is left out rather than guessed at. That is also why the result says your
voice *sits in a band* rather than telling you what you are.

## How it works

```
microphone → room-tone gate → YIN f0 → clean → analyse
```

- **YIN** ([de Cheveigné & Kawahara 2002](https://doi.org/10.1121/1.1458024)), steps 1–5,
  with the dip refined by golden-section search over the interpolated difference
  function. Measured error stays under 0.4 cents from 82 Hz to 880 Hz; plain
  parabolic interpolation drifts to ~1.9 cents at the top of that range.
- **Cleaning** is three passes: octave repair (a frame within a quarter tone of
  ±12 or ±24 semitones from its local median is transposed back), continuity
  (a jump over 6 semitones is dropped unless the next frame agrees, so real
  register leaps survive), then a median filter.
- **The gate** records ~1.2 s of room tone before the guide starts, and refuses
  the recording if the voice is not at least 12 dB above it, or if the input clips.
- **The staff** is drawn from E2 to C6 by default and widens to whole octaves
  when a voice goes past either end, so a deep bass or a high soprano is not
  clamped against the edge. The guide line stays anchored to the default span
  so it cannot move under the singer mid-slide.

Echo cancellation, noise suppression and auto gain are all switched off: they
distort the harmonics and flatten the loudness contour the measurements need.

## Running it

```sh
npm test          # 33 tests, no network
python3 -m http.server 8000    # then open localhost:8000
```

Needs a server rather than `file://` — it loads ES modules. No build step, no
dependencies in the shipped page; `playwright` is a dev dependency used only for
the browser test.

The test suite includes a test for the *test generator itself*, verifying by
zero-crossing that a synthesised glissando really has the pitch it claims. An
earlier generator modulated accumulated phase instead of frequency and produced
a signal an octave and a half off, which made a working tracker look broken.

## Licence

MIT
