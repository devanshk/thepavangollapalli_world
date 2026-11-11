// SOUND — a generative composer and a synthesiser. This file is the thin DOM layer: the music
// is written in compose.js, performed by synth.js, timed by player.js and drawn by score.js.
import { view, bar, group, button, slider, segmented, hint, loop, el, uid, loadCSS } from '../../assets/js/kit.js';
import { MOODS, MOOD_ORDER, VOICES } from './moods.js';
import { createComposer, BEATS, SECTION_BARS } from './compose.js';
import { createPlayer, audioSupported } from './player.js';
import { createScore } from './score.js';

const VOICE_LABELS = { pad: 'Pad', bass: 'Bass', arp: 'Pluck', lead: 'Lead', drums: 'Drums' };
const SEED_FIRST = ['amber', 'quiet', 'silver', 'distant', 'slow', 'paper', 'northern', 'glass', 'violet', 'early', 'hollow', 'salt'];
const SEED_SECOND = ['tide', 'harbor', 'lantern', 'field', 'river', 'orchard', 'window', 'signal', 'meadow', 'garden', 'stair', 'cloud'];
const NO_AUDIO = 'Web Audio is not available in this browser, so the piece can be read but not heard.';
const ABOUT = 'Nothing is recorded. The notes are composed as you listen and every instrument is synthesised in your browser. The same seed always plays the same piece.';

const randomSeed = () => {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(SEED_FIRST)}-${pick(SEED_SECOND)}-${10 + Math.floor(Math.random() * 90)}`;
};

export async function mount(root) {
  await loadCSS(new URL('./style.css', import.meta.url));
  const v = view(root, {
    aspect: 2.3,
    aspectNarrow: 0.9,
    label: 'Scrolling score of the piece: notes coloured by voice, the chord of each bar, and a live spectrum',
  });
  const score = createScore(v.canvas, root);

  let seed = 'amber-tide';
  let moodId = 'dawn';
  let composer = createComposer(seed, moodId);
  let shownBar = -1;
  let shownVoices = -1;
  const mutes = {};
  const player = createPlayer(syncUi);
  player.load(composer, composer.tempo);

  /* ── read-outs ── */
  const chordName = el('span', { class: 'sound-hud-chord' });
  const chordRoman = el('span', { class: 'sound-hud-roman' });
  const keyText = el('span');
  const sectionText = el('span');
  const barText = el('span');
  const voicesText = el('span');
  const field = (label, ...value) =>
    el('div', { class: 'sound-hud-item' }, el('span', { class: 'sound-hud-label' }, label), el('span', { class: 'sound-hud-value' }, value));
  root.append(
    el(
      'div',
      { class: 'sound-hud' },
      field('Chord', chordName, chordRoman),
      field('Key', keyText),
      field('Section', sectionText),
      field('Bar', barText),
      field('Live synth voices', voicesText),
    ),
  );

  /* ── controls ── */
  const bigPlay = el(
    'button',
    { type: 'button', class: 'sound-play', onClick: togglePlay },
    el('span', { class: 'sound-play-icon', 'aria-hidden': 'true' }),
    'Play',
  );
  v.wrap.append(bigPlay);
  const playBtn = button({ label: 'Play', kind: 'primary', onClick: togglePlay });
  playBtn.classList.add('sound-toggle');
  const moodSeg = segmented({
    label: 'Mood',
    options: MOOD_ORDER.map((id) => ({ value: id, label: MOODS[id].name })),
    value: moodId,
    onChange: (id) => {
      moodId = id;
      newPiece();
    },
  });
  const seedInput = el('input', { class: 'sound-seed', type: 'text', id: uid('seed'), value: seed, maxLength: 32, autocomplete: 'off' });
  seedInput.setAttribute('spellcheck', 'false');
  seedInput.setAttribute('autocapitalize', 'off');
  seedInput.addEventListener('change', () => {
    const text = seedInput.value.trim();
    if (!text) seedInput.value = seed;
    else if (text !== seed) {
      seed = text;
      newPiece();
    }
  });
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') seedInput.blur();
  });
  const seedField = el('label', { class: 'sound-seed-field', for: seedInput.id }, el('span', { class: 'kit-label' }, 'Seed'), seedInput);
  const newBtn = button({
    label: 'New piece',
    onClick: () => {
      seed = randomSeed();
      seedInput.value = seed;
      newPiece();
    },
  });
  const tempo = slider({
    label: 'Tempo',
    min: 44,
    max: 132,
    step: 1,
    value: composer.tempo,
    format: (x) => `${x} bpm`,
    onInput: (x) => player.setTempo(x),
  });
  const volume = slider({
    label: 'Volume',
    min: 0,
    max: 100,
    step: 1,
    value: 84,
    format: (x) => `${x}%`,
    onInput: (x) => player.setVolume((x / 100) ** 2),
  });
  player.setVolume((volume.value / 100) ** 2);

  const chips = {};
  for (const voice of VOICES) {
    chips[voice] = el(
      'button',
      {
        type: 'button',
        class: 'sound-chip',
        'aria-pressed': 'true',
        dataset: { voice },
        onClick: () => {
          mutes[voice] = !mutes[voice];
          chips[voice].setAttribute('aria-pressed', String(!mutes[voice]));
          player.setMute(voice, mutes[voice]);
          draw();
        },
      },
      el('span', { class: 'sound-chip-dot', 'aria-hidden': 'true' }),
      VOICE_LABELS[voice],
    );
  }
  const mixer = el(
    'div',
    { class: 'sound-mixer', role: 'group', 'aria-label': 'Voices in the mix' },
    el('span', { class: 'kit-label' }, 'Mix'),
    VOICES.map((voice) => chips[voice]),
  );
  const note = hint(ABOUT);
  bar(root, playBtn, moodSeg, group(seedField, newBtn));
  bar(root, tempo, volume, mixer);
  bar(root, note);

  /* ── behaviour ── */
  function updateHud() {
    const index = Math.max(0, Math.floor(player.beat() / BEATS));
    if (index !== shownBar) {
      const b = composer.bar(index);
      if (b) {
        shownBar = index;
        chordName.textContent = b.chord.name;
        chordRoman.textContent = b.chord.roman;
        sectionText.textContent = `${b.section} · bar ${b.sectionBar + 1} of ${SECTION_BARS}`;
        barText.textContent = String(index + 1);
      }
    }
    const voices = player.active ? player.voices : 0;
    if (voices !== shownVoices) {
      shownVoices = voices;
      voicesText.textContent = String(voices);
    }
  }

  function draw() {
    if (!v.size.pw) return;
    score.draw(v.size, {
      composer,
      beat: player.beat(),
      analyser: player.active ? player.analyser : null,
      sampleRate: player.sampleRate,
      mutes,
    });
    updateHud();
  }
  const anim = loop(draw);

  function syncUi() {
    playBtn.setLabel(player.playing ? 'Pause' : 'Play');
    if (player.active) anim.start();
    else {
      anim.stop();
      draw();
    }
  }

  function audioUnavailable() {
    playBtn.disabled = true;
    bigPlay.hidden = true;
    note.textContent = NO_AUDIO;
  }

  function togglePlay() {
    if (player.playing) {
      player.pause();
      return;
    }
    try {
      player.play();
      bigPlay.hidden = true;
    } catch (err) {
      audioUnavailable();
    }
  }

  function newPiece() {
    composer = createComposer(seed, moodId);
    tempo.value = composer.tempo;
    player.load(composer, composer.tempo);
    keyText.textContent = composer.key.label;
    const drums = !!composer.mood.drums;
    chips.drums.disabled = !drums;
    chips.drums.title = drums ? '' : 'This mood has no percussion';
    shownBar = -1;
    draw();
  }

  if (!audioSupported()) audioUnavailable();
  newPiece();
  v.onResize(draw);

  return {
    start() {
      player.start();
      if (player.active) anim.start();
    },
    stop() {
      player.stop();
      anim.stop();
    },
    destroy() {
      anim.stop();
      player.destroy();
      v.destroy();
    },
  };
}
