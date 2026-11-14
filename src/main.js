// Временная обвязка для отладки 3D. Участник 3 заменит её своим UI, используя тот же API MoonScene.
import { MoonScene } from './scene/MoonScene.js';

const params = new URLSearchParams(location.search);
if (params.has('clean')) document.querySelectorAll('.console, .timeline').forEach((e) => (e.style.display = 'none')); // для скриншотов
const moon = new MoonScene(document.getElementById('scene'), { forceFallback: params.has('fallback') });
window.moon = moon; // удобно дёргать API из консоли браузера

const $ = (s) => document.querySelector(s);
const info = $('#info');

// --- данные: каталог точек и эфемериды Horizons ---
// канонический каталог Участника 2 (координаты с источниками); запасной — временный пример
const sites = await fetch('/data/sites.json')
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .catch(() => fetch('/data/sites.sample.json').then((r) => r.json()).then((j) => j.sites));
moon.setSites(sites);
try {
  const eph = await fetch('/data/ephem_subpoints.json').then((r) => (r.ok ? r.json() : null));
  if (eph?.rows?.length) moon.setEphemeris(eph.rows);
} catch {
  /* без файла остаётся аналитика Meeus */
}

const siteSel = $('#site');
siteSel.innerHTML = sites.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
siteSel.value = 'artemis-malapert-massif';
const currentSite = () => siteSel.value;

moon.on('siteclick', ({ id }) => {
  siteSel.value = id;
  showInfo();
});
moon.on('surfaceclick', ({ lat, lon }) => {
  moon.addSite({ id: 'custom', name: 'Custom site', category: 'custom', lat, lon });
  if (![...siteSel.options].some((o) => o.value === 'custom')) siteSel.add(new Option('Custom site', 'custom'));
  siteSel.value = 'custom';
  moon.select('custom');
  showInfo();
});
moon.on('sitemove', showInfo);
moon.on('viewchange', ({ mode }) => {
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('on', b.dataset.view === mode);
  showInfo();
});

// --- таймлайн: 0..708 ч ≈ лунные сутки от t0 ---
const t0 = params.has('date') ? Date.parse(params.get('date')) : Date.parse('2027-03-12T00:00:00Z');
const slider = $('#time');
const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '°';
function applyTime() {
  moon.setDate(new Date(t0 + slider.value * 3600e3));
}
moon.on('datechange', (s) => {
  $('#date').textContent = `${s.date.toISOString().slice(0, 16)}Z  ☀ ${fmt(s.sunLat)} ${fmt(s.sunLon)}  🌍 ${Math.round(s.earthPhase * 100)}%  [${s.source}]`;
  if (moon.timelapse) slider.value = (s.date - t0) / 3600e3;
});
slider.addEventListener('input', applyTime);
applyTime();

function showInfo() {
  const id = currentSite();
  const c = moon.getSiteConditions(id);
  const s = sites.find((x) => x.id === id) ?? {};
  if (!c) return;
  info.textContent =
    `${s.name ?? id}  ${s.lat?.toFixed(3)}, ${s.lon?.toFixed(3)}\n` +
    `Sun   ${fmt(c.sunEl)}  horizon ${fmt(c.sunHorizonEl)}  ${c.sunVisibleFraction > 0 ? 'VISIBLE' : 'hidden'}\n` +
    `Earth ${fmt(c.earthEl)}  horizon ${fmt(c.earthHorizonEl)}  ${c.earthVisibleFraction > 0 ? 'LINK' : 'no link'}\n` +
    `terrain ${c.terrainModeled ? 'LOLA' : 'not modeled'} · mode ${moon.getView()}`;
}
moon.on('datechange', () => showInfo());

// --- кнопки ---
document.querySelectorAll('#views button').forEach((b) =>
  b.addEventListener('click', () => {
    const s = sites.find((x) => x.id === currentSite());
    moon.setView(b.dataset.view, s && s.lat < -80 ? { lat: s.lat, lon: s.lon, altitude: 120 } : undefined);
  }),
);
document.querySelectorAll('#layers button').forEach((b) =>
  b.addEventListener('click', () => {
    moon.setLayer(b.dataset.layer);
    for (const x of document.querySelectorAll('#layers button')) x.classList.toggle('on', x === b);
  }),
);
const actions = {
  fly: () => {
    moon.select(currentSite());
    moon.flyTo(currentSite());
  },
  surface: () => moon.enterSurfaceView(currentSite()),
  land: () => moon.flyTo(currentSite(), { landing: true }),
  compare: (btn) => {
    const on = !moon.compareDate;
    moon.setCompareDate(on ? new Date(moon.date.getTime() + 12 * 86400e3) : null);
    btn.classList.toggle('on', on);
  },
  compareSite: (btn) => {
    // соседняя точка: ближайшая к выбранной из каталога
    const a = sites.find((s) => s.id === currentSite());
    const on = !moon.compareSite && a;
    if (on) {
      const d = (s) => Math.hypot(s.lat - a.lat, (s.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180));
      const b = sites.filter((s) => s.id !== a.id).sort((x, y) => d(x) - d(y))[0];
      moon.select(a.id);
      moon.setCompareSite(b.id);
    } else moon.setCompareSite(null);
    btn.classList.toggle('on', !!on);
  },
  timelapse: (btn) => {
    if (moon.timelapse) moon.stopTimelapse();
    else moon.playTimelapse({ spanDays: 29.53, durationSec: 20 });
    btn.classList.toggle('on', !!moon.timelapse);
  },
  demo: () => runDemo(),
};
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.act](b)));
moon.on('timelapse', ({ playing }) => $('[data-act=timelapse]').classList.toggle('on', playing));
document.querySelectorAll('#earthshine button').forEach((b) =>
  b.addEventListener('click', () => {
    moon.setEarthshine(b.dataset.shine);
    for (const x of document.querySelectorAll('#earthshine button')) x.classList.toggle('on', x === b);
  }),
);
if (params.get('earthshine') === 'physical') moon.setEarthshine('physical');

let playing = false;
$('#play').addEventListener('click', (e) => {
  playing = !playing;
  e.target.textContent = playing ? '⏸' : '▶';
});

// FPS (приёмка: 60 на глобусе, ≥ 45 на полюсе)
let frames = 0;
let fpsT = performance.now();
(function loop() {
  if (playing && !moon.timelapse) {
    slider.value = (Number(slider.value) + 0.5) % 708;
    applyTime();
  }
  frames++;
  const now = performance.now();
  if (now - fpsT > 1000) {
    $('#fps').textContent = `${Math.round((frames * 1000) / (now - fpsT))} FPS`;
    frames = 0;
    fpsT = now;
  }
  requestAnimationFrame(loop);
})();

// --- сценарий демо (под питч) ---
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (t) => moon.hud?.setCaption(t);
async function runDemo() {
  moon.setCompareDate(null);
  moon.setLayer('relief');
  slider.value = 0;
  applyTime();
  await moon.setView('globe');
  say('March 2027. A mission is ready for Malapert Massif.');
  siteSel.value = 'artemis-malapert-massif';
  moon.select('artemis-malapert-massif');
  moon.flyTo('artemis-malapert-massif', { distance: 1.3 });
  await wait(2200);
  await moon.setView('polar', { lat: -86, lon: 2.9, altitude: 150 });
  say('South Pole, real LOLA terrain. One lunar day in 12 seconds.');
  moon.playTimelapse({ spanDays: 29.53, durationSec: 12 });
  await wait(12500);
  slider.value = 0;
  applyTime();
  say('Launch slips 12 days. Same site, new date:');
  moon.setCompareDate(new Date(moon.date.getTime() + 12 * 86400e3));
  await wait(5000);
  moon.setCompareDate(null);
  say('Sunlight over the whole lunar day, computed on the GPU');
  moon.setLayer('illumination');
  await wait(5000);
  moon.setLayer('relief');
  await moon.setView('globe');
  say("Chang'e 4, far side: Earth never rises here.");
  siteSel.value = 'cnsa-change-4';
  moon.select('cnsa-change-4');
  moon.flyTo('cnsa-change-4', { distance: 2.4 });
  moon.setLayer('comms');
  await wait(5000);
  moon.setLayer('relief');
  say('Simulated landing at Malapert');
  siteSel.value = 'artemis-malapert-massif';
  await moon.flyTo('artemis-malapert-massif', { landing: true });
  say(null);
}

// --- параметры URL для скриншотов: ?date=&view=lat,lon,dist&mode=polar|surface&site=&layer=&compare=days&land=&timelapse= ---
await moon.polarReady;
if (params.has('view')) {
  const [lat, lon, distance] = params.get('view').split(',').map(Number);
  moon.flyTo({ lat, lon }, { duration: 1, distance });
}
const site = params.get('site');
if (site) {
  siteSel.value = site;
  moon.select(site);
}
if (params.get('mode') === 'polar') {
  const s = sites.find((x) => x.id === site);
  const [lat, lon, alt] = (params.get('pv') ?? '').split(',').map(Number);
  await moon.setView('polar', s ? { lat: s.lat, lon: s.lon, altitude: alt || 60 } : lat ? { lat, lon, altitude: alt } : {});
}
if (params.get('mode') === 'surface' && site) await moon.enterSurfaceView(site, { yawDeg: params.has('yaw') ? +params.get('yaw') : undefined });
if (params.has('layer')) moon.setLayer(params.get('layer'));
if (params.has('compare')) moon.setCompareDate(new Date(moon.date.getTime() + +params.get('compare') * 86400e3));
if (params.has('land')) moon.flyTo(params.get('land'), { landing: true });
if (params.has('demo')) runDemo();
showInfo();

// --- бенчмарк (?bench): реальные FPS по режимам, время теней и слоя → консоль ---
if (params.has('bench')) {
  const fpsFor = (ms) =>
    new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      (function f() {
        n++;
        if (performance.now() - t0 < ms) requestAnimationFrame(f);
        else resolve((n * 1000) / (performance.now() - t0));
      })();
    });
  const gl = moon.renderer.getContext();
  const r = {};
  await moon.setView('globe');
  await wait(1500);
  r.globeFps = await fpsFor(4000);
  await moon.setView('polar', { lat: -89.4, lon: 0, altitude: 150 });
  await wait(1500);
  r.polarFps = await fpsFor(4000);
  // проход теней: 10 разных дат, с ожиданием GPU
  const pv = moon.polarView;
  const times = [];
  for (let i = 0; i < 10; i++) {
    const sub = (await import('./scene/ephemeris.js')).getSubPoints(new Date(Date.parse('2027-01-01') + i * 86400e3));
    pv.setSubPoints('A', sub, new Date());
    const t0 = performance.now();
    pv.updateShadows({ size: 1024 });
    gl.finish();
    times.push(performance.now() - t0);
  }
  r.shadowMsMedian = times.sort((a, b) => a - b)[5];
  const tl = performance.now();
  moon.setLayer('illumination');
  await new Promise((res) => moon.on('layerready', res));
  r.layerMs = performance.now() - tl;
  moon.setLayer('relief');
  await moon.enterSurfaceView('artemis-malapert-massif');
  await wait(1500);
  r.surfaceFps = await fpsFor(4000);
  console.log('[bench]', JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 10) / 10]))), navigator.userAgent.includes('Headless') ? 'headless' : '');
}
if (params.has('compareSite')) moon.setCompareSite(params.get('compareSite'));
