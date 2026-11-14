import { cmComms, cmIllum, cmSlope } from './polar/glsl.js';

// HTML-оверлей поверх 3D: крупные выводы (Sun/Earth над горизонтом), легенда слоя,
// прогресс пересчёта, подписи Scenario A/B, подсказки. UI Участника 3 может отключить: { hud: false }.

const LEGENDS = {
  slope: {
    title: 'Slope',
    unit: 'degrees',
    stops: [
      [0, '0°'],
      [5, '5°'],
      [10, '10°'],
      [15, '15°+'],
    ],
    gradient: () => gradient((t) => cmSlope(t * 15)),
    note: 'Artemis landing limit: < 10° over 100 m',
  },
  illumination: {
    title: 'Sunlight',
    unit: '% of time sunlit',
    stops: [
      [0, '0%'],
      [0.5, '50%'],
      [1, '100%'],
    ],
    gradient: () => gradient(cmIllum),
  },
  comms: {
    title: 'Direct-to-Earth link',
    unit: '% of time Earth above horizon',
    stops: [
      [0, '0%'],
      [0.5, '50%'],
      [1, '100%'],
    ],
    gradient: () => gradient(cmComms),
  },
};

function gradient(fn) {
  const stops = [];
  for (let i = 0; i <= 10; i++) {
    const [r, g, b] = fn(i / 10).map((v) => Math.round(v * 255));
    stops.push(`rgb(${r},${g},${b}) ${i * 10}%`);
  }
  return `linear-gradient(90deg, ${stops.join(',')})`;
}

const fmtDeg = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}°`;
const fmtDate = (d) =>
  d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) +
  ' UTC';

export class Hud {
  constructor(container, enabled = true) {
    this.enabled = enabled;
    this.root = document.createElement('div');
    this.root.className = 'moon-hud';
    this.root.hidden = !enabled;
    this.root.innerHTML = `
      <div class="hud-fade"></div>
      <div class="hud-badge" data-badge></div>
      <div class="hud-note-line" data-noteline hidden></div>
      <div class="hud-readout" data-readout hidden>
        <div class="hud-line" data-sun></div>
        <div class="hud-line" data-earth></div>
        <div class="hud-note" data-note></div>
      </div>
      <div class="hud-caption" data-caption hidden></div>
      <div class="hud-scenario a" data-sa hidden></div>
      <div class="hud-scenario b" data-sb hidden></div>
      <div class="hud-split" data-split hidden></div>
      <div class="hud-legend" data-legend hidden>
        <div class="hud-legend-title"></div>
        <div class="hud-legend-bar"></div>
        <div class="hud-legend-ticks"></div>
        <div class="hud-legend-meta"></div>
        <div class="hud-progress" hidden><span></span></div>
      </div>
      <div class="hud-hint" data-hint hidden></div>`;
    container.appendChild(this.root);
    this.q = (s) => this.root.querySelector(s);
    this.fade = this.q('.hud-fade');
  }

  /** Небольшая пометка под бейджем: допущения визуализации, предупреждения о данных. */
  setNote(text, warn = false) {
    const el = this.q('[data-noteline]');
    el.hidden = !text;
    el.classList.toggle('warn', warn);
    if (text) el.textContent = text;
  }

  setBadge(text) {
    this.q('[data-badge]').textContent = text;
  }

  /** Плавное затемнение для смены режима. */
  async fadeThrough(fn, ms = 320) {
    this.fade.style.transitionDuration = `${ms}ms`;
    this.fade.classList.add('on');
    await new Promise((r) => setTimeout(r, ms));
    await fn();
    requestAnimationFrame(() => this.fade.classList.remove('on'));
  }

  /** Крупные выводы для вида с поверхности / выбранной точки. */
  setReadout(c) {
    const box = this.q('[data-readout]');
    if (!c) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const sunVisible = c.sunVisibleFraction > 0.001;
    const sunAboveTerrain = c.sunEl - c.sunHorizonEl;
    const sun = this.q('[data-sun]');
    sun.className = `hud-line ${sunVisible ? 'ok' : 'bad'}`;
    sun.innerHTML = sunVisible
      ? `<b>☀ Sun ${fmtDeg(c.sunEl)}</b> above horizon${c.sunVisibleFraction < 0.999 ? ` · ${Math.round(c.sunVisibleFraction * 100)}% of disk` : ''}`
      : `<b>☀ Sun hidden</b> · ${c.sunEl < 0 ? `${fmtDeg(c.sunEl)} below horizon` : `behind terrain (${fmtDeg(sunAboveTerrain)})`}`;
    const earthVisible = c.earthVisibleFraction > 0.001;
    const earth = this.q('[data-earth]');
    earth.className = `hud-line ${earthVisible ? 'ok' : 'bad'}`;
    earth.innerHTML = earthVisible ? `<b>🌍 Earth ${fmtDeg(c.earthEl)}</b> · direct link` : `<b>🌍 Earth hidden</b> · no direct link`;
    const range = c.horizonRangeKm ? ` (terrain modeled to ${Math.round(c.horizonRangeKm)} km)` : '';
    this.q('[data-note]').textContent = c.terrainModeled
      ? `Horizon from LOLA terrain${range} · no atmosphere, no refraction`
      : 'Smooth-sphere horizon · terrain not modeled here';
  }

  setCaption(text) {
    const el = this.q('[data-caption]');
    el.hidden = !text;
    if (text) el.textContent = text;
  }

  setHint(text) {
    const el = this.q('[data-hint]');
    el.hidden = !text;
    if (text) el.textContent = text;
  }

  setScenarios(a, b, extraA = '', extraB = '', titleA = null, titleB = null) {
    const on = !!b;
    this.q('[data-sa]').hidden = !on;
    this.q('[data-sb]').hidden = !on;
    this.q('[data-split]').hidden = !on;
    if (!on) return;
    this.q('[data-sa]').innerHTML = `<b>${titleA ?? 'Scenario A'}</b> ${fmtDate(a)}${extraA ? `<br>${extraA}` : ''}`;
    this.q('[data-sb]').innerHTML = `<b>${titleB ?? 'Scenario B'}</b> ${fmtDate(b)}${extraB ? `<br>${extraB}` : ''}`;
  }

  setLegend(layer, { note, source } = {}) {
    const box = this.q('[data-legend]');
    const def = LEGENDS[layer];
    if (!def) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.querySelector('.hud-legend-title').innerHTML = `<b>${def.title}</b> <span>${def.unit}</span>`;
    box.querySelector('.hud-legend-bar').style.background = def.gradient();
    const max = def.stops.at(-1)[0];
    box.querySelector('.hud-legend-ticks').innerHTML = def.stops
      .map(([v, t]) => `<span style="left:${(v / max) * 100}%">${t}</span>`)
      .join('');
    box.querySelector('.hud-legend-meta').textContent = [note ?? def.note, source].filter(Boolean).join(' · ');
  }

  setProgress(p) {
    const el = this.q('.hud-progress');
    el.hidden = p == null || p >= 1;
    if (p != null) el.firstElementChild.style.width = `${Math.round(p * 100)}%`;
  }

  dispose() {
    this.root.remove();
  }
}
