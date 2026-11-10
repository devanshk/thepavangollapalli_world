// The data card: the planet's name, its seed, and facts measured from the terrain.
import { el } from '../../assets/js/kit.js';
import { linearToCss } from './params.js';
import { KM_PER_UNIT } from './terrain.js';

const PENDING = '…';
const percent = (x) => `${(100 * x).toFixed(1)} %`;
const km = (units) => `${(units * KM_PER_UNIT).toFixed(1)} km`;

/**
 * Colours the atmosphere's scattering coefficients imply. Air scatters each channel in
 * proportion to tau, which tints the sky; sunlight grazing the horizon has lost
 * exp(-tau × path), which tints the sunset. Both are normalised to full brightness.
 */
export function skyColors(atmosphere) {
  const horizonPath = Math.sqrt((0.5 * Math.PI) / atmosphere.scaleHeight);
  const sky = atmosphere.tau.map((t) => t);
  const sunset = atmosphere.tau.map((t) => Math.exp(-t * horizonPath));
  const norm = (c) => {
    const peak = Math.max(c[0], c[1], c[2]) || 1;
    return c.map((x) => x / peak);
  };
  return { sky: norm(sky), sunset: norm(sunset) };
}

export function createCard() {
  const kicker = el('p', { class: 'world-kicker' });
  const name = el('p', { class: 'world-name', role: 'heading', 'aria-level': '3' });
  const seedLine = el('p', { class: 'world-seedline' });

  const fact = (label) => {
    const dt = el('dt', null, label);
    const dd = el('dd', null, PENDING);
    return { row: el('div', { class: 'world-fact' }, dt, dd), dt, dd };
  };
  const ocean = fact('Ocean');
  const frozen = fact('Ice and snow');
  const peak = fact('Highest peak');
  const deepest = fact('Deepest point');
  const tilt = fact('Axial tilt');
  const sky = fact('Sky, sunset');
  const skySwatch = el('span', { class: 'world-swatch' });
  const sunsetSwatch = el('span', { class: 'world-swatch' });
  sky.dd.replaceChildren(skySwatch, sunsetSwatch);
  const facts = el('dl', { class: 'world-facts' }, ocean.row, frozen.row, peak.row, deepest.row, tilt.row, sky.row);

  const mixBar = el('div', { class: 'world-mix-bar' });
  const mixLegend = el('ul', { class: 'world-mix-legend' });
  const mix = el('div', { class: 'world-mix' }, mixBar, mixLegend);
  const note = el('p', { class: 'world-note' });

  const node = el('aside', { class: 'world-card', 'aria-label': 'Planet data' }, el('div', { class: 'world-title' }, kicker, name, seedLine), facts, mix, note);
  let current = null;

  function setPlanet(params) {
    current = params;
    kicker.textContent = `${params.familyLabel}${params.ring ? ' · ringed' : ''}`;
    name.textContent = params.name;
    const hex = params.hash.toString(16).padStart(8, '0');
    seedLine.replaceChildren('seed ', el('span', { class: 'world-seed-text' }, params.seed), ` · hash ${hex}`);
    ocean.dt.textContent = params.terms.sea;
    tilt.dd.textContent = `${params.tiltDeg.toFixed(1)}°`;
    const colors = skyColors(params.atmosphere);
    skySwatch.style.background = linearToCss(colors.sky);
    sunsetSwatch.style.background = linearToCss(colors.sunset);
    sky.dd.setAttribute('aria-label', 'colour swatches computed from the scattering coefficients');
    for (const f of [ocean, frozen, peak, deepest]) f.dd.textContent = PENDING;
    node.classList.add('world-card--pending');
    note.textContent = 'Measuring the surface…';
  }

  /** survey: result of createSurvey().result(); ms: how long the measurement took. */
  function setSurvey(survey, ms) {
    if (!current) return;
    const pal = current.palette;
    const slot = (i) => linearToCss([pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]]);
    ocean.dd.textContent = percent(survey.ocean);
    frozen.dd.textContent = percent(survey.frozen);
    peak.dd.textContent = km(survey.peak);
    deepest.dd.textContent = km(survey.deepest);

    const parts = [
      { label: current.terms.sea, share: survey.ocean - survey.seaIce, color: slot(0) },
      { label: 'Ice and snow', share: survey.frozen, color: slot(10) },
      { label: current.terms.wet, share: survey.land.wet, color: slot(6) },
      { label: current.terms.open, share: survey.land.open, color: slot(5) },
      { label: current.terms.dry, share: survey.land.dry, color: slot(3) },
    ].filter((part) => part.share >= 0.0005);
    mixBar.replaceChildren(
      ...parts.map((part) => el('span', { class: 'world-mix-part', style: { flexGrow: String(part.share), background: part.color } })),
    );
    mixLegend.replaceChildren(
      ...parts.map((part) =>
        el('li', null, el('span', { class: 'world-dot', style: { background: part.color } }), `${part.label} ${Math.round(part.share * 100)} %`),
      ),
    );
    mix.setAttribute('role', 'img');
    mix.setAttribute('aria-label', `Surface: ${parts.map((part) => `${part.label} ${Math.round(part.share * 100)} %`).join(', ')}`);
    note.textContent =
      `Measured, not written: ${survey.samples.toLocaleString('en-US')} points of the terrain function the shader draws, ` +
      `evaluated in JavaScript in ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms. One height unit is counted as ${KM_PER_UNIT} km.`;
    node.classList.remove('world-card--pending');
  }

  return { node, setPlanet, setSurvey };
}
