// Выгрузка эфемерид Луны из JPL Horizons -> public/data/ephem_subpoints.json
// Подсолнечная и подземная точки на Луне (geocentric observer), расстояние Земля–Луна.
// Либрация Земли уже учтена в sub-observer точке.
//
// Запуск: node scripts/fetch_ephem.mjs [START] [STOP] [STEP]
//   по умолчанию 2026-11-01 .. 2028-01-01, шаг 2h
// Временно делает Участник 1 для проверки 3D; канон — данные Участника 2 в том же формате.
import { writeFile, mkdir } from 'node:fs/promises';

const [START = '2026-11-01', STOP = '2028-01-01', STEP = '2h'] = process.argv.slice(2);
const AU_KM = 149597870.7;

const params = new URLSearchParams({
  format: 'text',
  COMMAND: "'301'",
  CENTER: "'500@399'",
  MAKE_EPHEM: "'YES'",
  EPHEM_TYPE: "'OBSERVER'",
  START_TIME: `'${START}'`,
  STOP_TIME: `'${STOP}'`,
  STEP_SIZE: `'${STEP}'`,
  QUANTITIES: "'14,15,20'",
  CSV_FORMAT: "'YES'",
  ANG_FORMAT: "'DEG'",
});

const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${params}`);
if (!res.ok) throw new Error(`Horizons HTTP ${res.status}`);
const text = await res.text();
const body = text.split('$$SOE')[1]?.split('$$EOE')[0];
if (!body) throw new Error(`Unexpected Horizons response:\n${text.slice(0, 2000)}`);

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

const rows = body
  .trim()
  .split('\n')
  .map((line) => {
    const c = line.split(',').map((s) => s.trim());
    // c: date, solar-presence, lunar-presence, ObsSub-LON, ObsSub-LAT, SunSub-LON, SunSub-LAT, delta(AU), deldot
    const t = Date.parse(c[0].replace(/(\d{4})-(\w{3})-(\d{2})/, '$2 $3 $1') + ' UTC');
    return {
      t,
      sunLat: r4(+c[6]),
      sunLon: r4(wrap180(+c[5])),
      earthLat: r4(+c[4]),
      earthLon: r4(wrap180(+c[3])),
      earthDistKm: Math.round(+c[7] * AU_KM),
    };
  })
  .filter((r) => Number.isFinite(r.t));

await mkdir('public/data', { recursive: true });
await writeFile(
  'public/data/ephem_subpoints.json',
  JSON.stringify({
    source: 'JPL Horizons API (ssd.jpl.nasa.gov), target 301 Moon, observer 500@399 geocenter, quantities 14,15,20',
    note: 'Sub-solar / sub-observer points, east longitude -180..180. Earth libration included.',
    generated: new Date().toISOString(),
    step: STEP,
    rows,
  }),
);
console.log(`ephem_subpoints.json: ${rows.length} rows, ${new Date(rows[0].t).toISOString()} .. ${new Date(rows.at(-1).t).toISOString()}`);
