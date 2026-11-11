import { assert, equal } from '../../assets/js/check.js';
import { euclid, spellScale, MODES, inScale, mod } from './theory.js';
import { MOODS, MOOD_ORDER } from './moods.js';
import { createComposer, RANGES, BEATS, SECTION_BARS, FORM } from './compose.js';
import { renderBars } from './synth.js';

const SEEDS = ['amber-tide', 'quiet-harbor', 'glass', '7', 'x'];
const BARS = 64;

const pieces = new Map();
function piece(seed, moodId) {
  const id = `${seed}|${moodId}`;
  if (!pieces.has(id)) {
    const composer = createComposer(seed, moodId);
    const bars = [];
    for (let i = 0; i < BARS; i++) bars.push(composer.bar(i));
    pieces.set(id, { composer, bars, key: composer.key });
  }
  return pieces.get(id);
}
function everyPiece(fn) {
  for (const moodId of MOOD_ORDER) for (const seed of SEEDS) fn(piece(seed, moodId), `${moodId} / ${seed}`);
}
const notes = (bar, voice) => bar.events.filter((e) => e.voice === voice);
const where = (label, bar) => `${label}, bar ${bar.index}`;

let rendered = null;
function render() {
  if (!rendered) {
    rendered = renderBars(createComposer('amber-tide', 'pulse'), 8).then((buffer) => {
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      let peak = 0;
      let sumSquares = 0;
      let difference = 0;
      let finite = true;
      for (let i = 0; i < left.length; i++) {
        if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) finite = false;
        peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
        sumSquares += left[i] * left[i] + right[i] * right[i];
        difference += Math.abs(left[i] - right[i]);
      }
      return { peak, rms: Math.sqrt(sumSquares / (2 * left.length)), difference: difference / left.length, finite };
    });
  }
  return rendered;
}

export default [
  {
    name: 'the same seed and mood always give the same music',
    fn() {
      for (const moodId of MOOD_ORDER) {
        const a = createComposer('amber-tide', moodId);
        const b = createComposer('amber-tide', moodId);
        for (let i = 0; i < 40; i++) equal(a.bar(i), b.bar(i), `${moodId} bar ${i}`);
      }
    },
  },
  {
    name: 'different seeds give different music',
    fn() {
      for (const moodId of MOOD_ORDER) {
        const a = JSON.stringify(piece('amber-tide', moodId).bars.slice(0, 8));
        const b = JSON.stringify(piece('quiet-harbor', moodId).bars.slice(0, 8));
        assert(a !== b, `${moodId}: two seeds produced the same eight bars`);
      }
    },
  },
  {
    name: 'Euclidean rhythms match the known patterns E(3,8) and E(5,8)',
    fn() {
      equal(euclid(3, 8), [1, 0, 0, 1, 0, 0, 1, 0], 'tresillo');
      equal(euclid(5, 8), [1, 0, 1, 1, 0, 1, 1, 0], 'cinquillo');
      equal(euclid(2, 5), [1, 0, 1, 0, 0]);
      equal(euclid(4, 16), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
      for (let n = 1; n <= 16; n++) {
        for (let k = 0; k <= n; k++) {
          const p = euclid(k, n);
          equal(p.length, n);
          equal(p.reduce((a, b) => a + b, 0), k, `E(${k},${n}) onsets`);
        }
      }
    },
  },
  {
    name: 'every pitch is in the scale, except flagged approach tones',
    fn() {
      everyPiece(({ bars, key }, label) => {
        for (const bar of bars) {
          for (const e of bar.events) {
            if (e.voice === 'drums' || e.chromatic) continue;
            assert(inScale(key, e.pitch), `${where(label, bar)}: ${e.voice} plays ${e.pitch}, outside ${key.label}`);
          }
        }
      });
    },
  },
  {
    name: 'chromatic approach tones sit a semitone from the next bass note',
    fn() {
      let found = 0;
      everyPiece(({ bars, key }, label) => {
        for (let i = 0; i + 1 < bars.length; i++) {
          for (const e of bars[i].events) {
            if (!e.chromatic) continue;
            found++;
            const next = notes(bars[i + 1], 'bass')[0];
            equal(e.voice, 'bass', where(label, bars[i]));
            assert(!inScale(key, e.pitch), 'a flagged note should really be outside the scale');
            equal(Math.abs(next.pitch - e.pitch), 1, `${where(label, bars[i])}: approach interval`);
          }
        }
      });
      assert(found > 0, 'expected at least one chromatic approach tone in the sample');
    },
  },
  {
    name: 'melody notes on beats one and three are chord tones',
    fn() {
      let checked = 0;
      everyPiece(({ bars }, label) => {
        for (const bar of bars) {
          for (const e of notes(bar, 'lead')) {
            if (e.step % 8 !== 0) continue;
            checked++;
            assert(bar.chord.pcs.includes(mod(e.pitch, 12)), `${where(label, bar)}: ${e.pitch} is not in ${bar.chord.name}`);
          }
        }
      });
      assert(checked > 500, 'too few strong-beat notes to be a meaningful check');
    },
  },
  {
    name: 'bass stays below C3, pads within C3 to C5, the lead within C4 to C6',
    fn() {
      everyPiece(({ bars }, label) => {
        for (const bar of bars) {
          for (const e of bar.events) {
            if (e.voice === 'drums') continue;
            const [lo, hi] = RANGES[e.voice];
            assert(e.pitch >= lo && e.pitch <= hi, `${where(label, bar)}: ${e.voice} at ${e.pitch} outside ${lo}..${hi}`);
          }
        }
      });
      equal([RANGES.bass[1], RANGES.pad, RANGES.lead], [47, [48, 72], [60, 84]]);
    },
  },
  {
    name: 'each pad chord has four rising voices that cover the whole chord',
    fn() {
      everyPiece(({ bars }, label) => {
        for (const bar of bars) {
          equal(bar.pad.length, 4);
          for (let v = 1; v < 4; v++) assert(bar.pad[v] > bar.pad[v - 1], `${where(label, bar)}: voices cross`);
          for (const pc of bar.chord.pcs) assert(bar.pad.some((p) => mod(p, 12) === pc), `${where(label, bar)}: missing a chord tone`);
          for (const p of bar.pad) assert(bar.chord.pcs.includes(mod(p, 12)), `${where(label, bar)}: non-chord tone in the pad`);
        }
      });
    },
  },
  {
    name: 'voice-leading is smooth: no pad voice moves more than a fifth',
    fn() {
      let total = 0;
      let changes = 0;
      everyPiece(({ bars }, label) => {
        for (let i = 1; i < bars.length; i++) {
          let motion = 0;
          for (let v = 0; v < 4; v++) {
            const step = Math.abs(bars[i].pad[v] - bars[i - 1].pad[v]);
            assert(step <= 7, `${where(label, bars[i])}: voice ${v} leaps ${step} semitones`);
            motion += step;
          }
          assert(motion <= 14, `${where(label, bars[i])}: the four voices move ${motion} semitones in total`);
          total += motion;
          changes++;
        }
      });
      assert(total / changes <= 7, `average motion per chord change is ${(total / changes).toFixed(2)} semitones`);
    },
  },
  {
    name: 'bars arrive in order and every note fits inside its bar',
    fn() {
      everyPiece(({ bars }, label) => {
        bars.forEach((bar, i) => {
          equal(bar.index, i);
          equal(bar.sectionBar, i % SECTION_BARS);
          equal(bar.section, FORM[Math.floor(i / SECTION_BARS) % FORM.length]);
          let previous = 0;
          for (const e of bar.events) {
            assert(e.start >= previous, `${where(label, bar)}: events are not sorted by time`);
            assert(e.dur > 0 && e.start + e.dur <= BEATS + 1e-9, `${where(label, bar)}: ${e.voice} note runs past the bar line`);
            assert(e.vel > 0 && e.vel <= 1, `${where(label, bar)}: velocity ${e.vel}`);
            previous = e.start;
          }
        });
      });
    },
  },
  {
    name: 'bass and lead never sound two notes at once',
    fn() {
      everyPiece(({ bars }, label) => {
        for (const bar of bars) {
          for (const voice of ['bass', 'lead']) {
            const line = notes(bar, voice);
            for (let i = 1; i < line.length; i++) {
              assert(line[i - 1].start + line[i - 1].dur <= line[i].start, `${where(label, bar)}: ${voice} notes overlap`);
            }
          }
        }
      });
    },
  },
  {
    name: 'every section ends with a dominant chord resolving to the tonic',
    fn() {
      everyPiece(({ bars, key }, label) => {
        for (let i = SECTION_BARS - 1; i < bars.length; i += SECTION_BARS) {
          equal(bars[i].chord.degree, 0, `${where(label, bars[i])}: final chord`);
          equal(bars[i].chord.root, key.tonic);
          assert(key.mode.dom.includes(bars[i - 1].chord.degree), `${where(label, bars[i - 1])}: not a dominant-function chord`);
          equal(mod(notes(bars[i], 'bass')[0].pitch, 12), key.tonic, 'the bass lands on the tonic');
        }
      });
    },
  },
  {
    name: 'A sections end with the melody on the tonic; B sections end off it',
    fn() {
      everyPiece(({ bars, key }, label) => {
        for (let i = SECTION_BARS - 1; i < bars.length; i += SECTION_BARS) {
          const last = notes(bars[i], 'lead')[0];
          const onTonic = mod(last.pitch, 12) === key.tonic;
          equal(onTonic, bars[i].section !== 'B', where(label, bars[i]));
        }
      });
    },
  },
  {
    name: 'the form is A A′ B A and the returning A restates the first',
    fn() {
      const line = (bar) => notes(bar, 'lead').map((e) => [e.step, e.pitch]);
      let variedMelodies = 0;
      everyPiece(({ bars }, label) => {
        for (let b = 0; b < SECTION_BARS; b++) {
          equal(bars[24 + b].chord.degree, bars[b].chord.degree, `${label}: chords of the returning A`);
          equal(line(bars[24 + b]), line(bars[b]), `${label}: melody of the returning A`);
        }
        assert(bars[16].chord.degree !== 0, `${label}: B should start away from the tonic`);
        const a = JSON.stringify(bars.slice(0, 8).map(line));
        if (a !== JSON.stringify(bars.slice(8, 16).map(line))) variedMelodies++;
      });
      assert(variedMelodies >= 15, `A′ varied the melody in only ${variedMelodies} of 20 pieces`);
    },
  },
  {
    name: 'each mood keeps its own mode and tempo range',
    fn() {
      everyPiece(({ composer }) => {
        const mood = composer.mood;
        equal(composer.key.modeId, mood.mode);
        assert(composer.tempo >= mood.tempo[0] && composer.tempo <= mood.tempo[1], `tempo ${composer.tempo}`);
      });
      equal(new Set(MOOD_ORDER.map((id) => MOODS[id].mode)).size, 4, 'four different modes');
    },
  },
  {
    name: 'scales are spelled with each letter name exactly once',
    fn() {
      equal(spellScale(2, MODES.dorian.steps), ['D', 'E', 'F', 'G', 'A', 'B', 'C']);
      equal(spellScale(5, MODES.lydian.steps), ['F', 'G', 'A', 'B', 'C', 'D', 'E']);
      equal(spellScale(3, MODES.lydian.steps), ['E♭', 'F', 'G', 'A', 'B♭', 'C', 'D']);
      equal(spellScale(6, MODES.phrygian.steps), ['F♯', 'G', 'A', 'B', 'C♯', 'D', 'E']);
      for (const id of Object.keys(MODES)) {
        for (let tonic = 0; tonic < 12; tonic++) {
          const letters = spellScale(tonic, MODES[id].steps).map((n) => n[0]);
          equal(new Set(letters).size, 7, `${id} on ${tonic}`);
        }
      }
    },
  },
  {
    name: 'old bars are discarded as the piece runs on',
    fn() {
      const composer = createComposer('long-run', 'pulse');
      for (let i = 0; i < 400; i++) assert(composer.bar(i), `bar ${i} missing`);
      equal(composer.bar(0), null, 'bar 0 should have been dropped');
      assert(composer.bar(399).events.length > 0);
    },
  },
  {
    name: 'eight bars rendered through the synth are not silent',
    browser: true,
    async fn() {
      const { rms, finite } = await render();
      assert(finite, 'the render contains NaN or infinite samples');
      assert(rms > 0.02, `RMS level ${rms.toFixed(4)} is too quiet`);
    },
  },
  {
    name: 'the rendered audio never clips',
    browser: true,
    async fn() {
      const { peak } = await render();
      assert(peak < 0.9, `peak sample is ${peak.toFixed(3)}`);
    },
  },
  {
    name: 'left and right channels are different',
    browser: true,
    async fn() {
      const { difference } = await render();
      assert(difference > 1e-4, `mean |L − R| is ${difference}`);
    },
  },
];
