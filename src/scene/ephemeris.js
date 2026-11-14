// Положение Солнца и Земли в системе координат Луны.
//
// ВРЕМЕННО: аналитическое приближение (Meeus, «Astronomical Algorithms», гл. 25/47/53),
// точность ~1–2°. Когда Участник 2 отдаст ephem.json из JPL Horizons
// (sub-solar и sub-observer точки), источник подменяется через setEphemerisTable().

const D2R = Math.PI / 180;
const INCLINATION = 1.54242 * D2R; // наклон экватора Луны к эклиптике

let table = null; // [{t: ms, sunLat, sunLon, earthLat, earthLon}], отсортировано по t

export function setEphemerisTable(rows) {
  table = rows && rows.length ? rows : null;
}

const norm360 = (deg) => ((deg % 360) + 360) % 360;
const wrap180 = (deg) => norm360(deg + 180) - 180;

function centuriesSinceJ2000(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  return (jd - 2451545.0) / 36525;
}

// Селенографические координаты подсолнечной и подземной точек
function analytic(date) {
  const T = centuriesSinceJ2000(date);

  // Солнце: геометрическая эклиптическая долгота
  const M = (357.52911 + 35999.05029 * T) * D2R;
  const sunLon = 280.46646 + 36000.76983 * T + 1.914602 * Math.sin(M) + 0.019993 * Math.sin(2 * M);

  // Луна: средние элементы + главные периодические члены
  const L = 218.3164477 + 481267.88123421 * T; // средняя долгота
  const Mp = (134.9633964 + 477198.8675055 * T) * D2R; // средняя аномалия
  const F = 93.272095 + 483202.0175233 * T; // аргумент широты
  const node = 125.0445479 - 1934.1362891 * T; // восходящий узел
  const D = (297.8501921 + 445267.1114034 * T) * D2R;
  const moonLon = L + 6.289 * Math.sin(Mp) + 1.274 * Math.sin(2 * D - Mp) + 0.658 * Math.sin(2 * D);
  const moonLat = 5.128 * Math.sin(F * D2R);

  // Подземная точка (оптическая либрация), Meeus 53.1
  const W = (moonLon - node) * D2R;
  const b = moonLat * D2R;
  const A = Math.atan2(
    Math.sin(W) * Math.cos(b) * Math.cos(INCLINATION) - Math.sin(b) * Math.sin(INCLINATION),
    Math.cos(W) * Math.cos(b),
  );
  const earthLon = wrap180(A / D2R - F);
  const earthLat =
    Math.asin(-Math.sin(W) * Math.cos(b) * Math.sin(INCLINATION) - Math.sin(b) * Math.cos(INCLINATION)) / D2R;

  // Подсолнечная точка (Meeus гл. 53): берём гелиоцентрическую долготу Луны λ☉+180°
  // (поправка на смещение Луны от Земли < 0.15°, ею пренебрегаем)
  const Ws = (sunLon + 180 - node) * D2R;
  const solarLon = wrap180(Math.atan2(Math.sin(Ws) * Math.cos(INCLINATION), Math.cos(Ws)) / D2R - F);
  const solarLat = Math.asin(-Math.sin(Ws) * Math.sin(INCLINATION)) / D2R;

  // Расстояние Земля–Луна, главные члены Meeus 47 (точность ~300 км)
  const earthDistKm = 385000.56 - 20905.355 * Math.cos(Mp) - 3699.111 * Math.cos(2 * D - Mp) - 2955.968 * Math.cos(2 * D);

  return { sunLat: solarLat, sunLon: solarLon, earthLat, earthLon, earthDistKm };
}

function lerpAngle(a, b, k) {
  return a + wrap180(b - a) * k;
}

function fromTable(date) {
  const t = date.getTime();
  if (t <= table[0].t || t >= table[table.length - 1].t) return null; // вне диапазона
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = table[lo];
  const b = table[hi];
  const k = (t - a.t) / (b.t - a.t);
  return {
    sunLat: a.sunLat + (b.sunLat - a.sunLat) * k,
    sunLon: wrap180(lerpAngle(a.sunLon, b.sunLon, k)),
    earthLat: a.earthLat + (b.earthLat - a.earthLat) * k,
    earthLon: wrap180(lerpAngle(a.earthLon, b.earthLon, k)),
    earthDistKm:
      a.earthDistKm != null && b.earthDistKm != null ? a.earthDistKm + (b.earthDistKm - a.earthDistKm) * k : null,
  };
}

/**
 * @returns {{sunLat, sunLon, earthLat, earthLon, earthDistKm, earthPhase, source:'horizons'|'analytic'}}
 * earthPhase — освещённая доля диска Земли, видимая с Луны (0 = «новоземлие», 1 = «полноземлие»).
 */
export function getSubPoints(date) {
  const row = table && fromTable(date);
  const out = row ? { ...row, source: 'horizons' } : { ...analytic(date), source: 'analytic' };
  if (out.earthDistKm == null) out.earthDistKm = analytic(date).earthDistKm;
  out.earthPhase = earthPhase(out);
  return out;
}

// Фаза Земли с Луны: k = (1 − cos θ) / 2, θ — угол между направлениями на Солнце и на Землю
function earthPhase({ sunLat, sunLon, earthLat, earthLon }) {
  const a = sunLat * D2R;
  const b = earthLat * D2R;
  const cosTheta = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos((sunLon - earthLon) * D2R);
  return (1 - cosTheta) / 2;
}
