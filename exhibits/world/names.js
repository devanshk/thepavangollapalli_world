// Pronounceable planet names from phonemes. A name is a run of open syllables
// (onset + vowel), optionally closed by a soft consonant, so consonants and vowels always
// alternate in groups of at most two letters.
import { rng } from '../../assets/js/kit.js';

const FIRST_ONSETS = ['', '', '', 'b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z',
  'br', 'cr', 'dr', 'gl', 'gr', 'kr', 'pr', 'st', 'tr', 'th', 'sh', 'vr'];
const INNER_ONSETS = ['b', 'd', 'g', 'k', 'l', 'l', 'm', 'm', 'n', 'n', 'r', 'r', 's', 't', 'v', 'z', 'th', 'sh', 'll', 'ss', 'nd', 'lm', 'rn', 'st'];
const SINGLE_ONSETS = ['b', 'd', 'g', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'z'];
const VOWELS = ['a', 'a', 'a', 'e', 'e', 'e', 'i', 'i', 'o', 'o', 'o', 'u', 'u', 'ae', 'ia', 'io', 'ea', 'ei', 'ou', 'au'];
const INNER_CODAS = ['n', 'r', 'l', 's', 'm'];
const FINAL_CODAS = ['', '', '', '', 'n', 'n', 'r', 'r', 's', 's', 'l', 'm', 'x', 'th', 'sh', 'nd', 'rn'];

// Random syllables occasionally spell something rude; those draws are thrown away.
const AVOID = ['shit', 'fuk', 'fuc', 'cunt', 'nig', 'fag', 'dik', 'dic', 'cok', 'coc', 'piss', 'anus', 'rape', 'slut', 'tit',
  'ass', 'cum', 'sex', 'kil', 'nazi', 'hor', 'pedo', 'poo', 'pus', 'turd', 'die', 'dead'];

function draw(r) {
  const syllables = r() < 0.55 ? 2 : 3;
  let name = r.pick(FIRST_ONSETS) + r.pick(VOWELS);
  for (let i = 1; i < syllables; i++) {
    if (r() < 0.22) {
      // a closed syllable: the coda and the next onset must be different single consonants
      const coda = r.pick(INNER_CODAS);
      let onset = r.pick(SINGLE_ONSETS);
      while (onset === coda) onset = r.pick(SINGLE_ONSETS);
      name += coda + onset;
    } else name += r.pick(INNER_ONSETS);
    name += r.pick(VOWELS);
  }
  return name + r.pick(FINAL_CODAS);
}

/** planetName(hash) → a capitalised, pronounceable name; the same hash always gives the same name. */
export function planetName(hash) {
  const r = rng((hash ^ 0x5bd1e995) >>> 0);
  for (let attempt = 0; attempt < 32; attempt++) {
    const name = draw(r);
    if (name.length < 4 || name.length > 10) continue;
    if (AVOID.some((bad) => name.includes(bad))) continue;
    return name[0].toUpperCase() + name.slice(1);
  }
  return 'Terra';
}

/** A short lowercase word for the seed field, drawn from Math.random by default. */
export function randomSeedWord(random = Math.random) {
  const r = rng(Math.floor(random() * 4294967296));
  for (let attempt = 0; attempt < 32; attempt++) {
    const word = draw(r);
    if (word.length < 4 || word.length > 9) continue;
    if (AVOID.some((bad) => word.includes(bad))) continue;
    return word;
  }
  return 'terra';
}
