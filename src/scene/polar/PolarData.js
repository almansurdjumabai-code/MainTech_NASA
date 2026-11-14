import * as THREE from 'three';

// Рельеф Южного полюса (LOLA LDEM_80S_80M, препроцессинг scripts/prep_polar.py).
// Проекция: south polar stereographic, R = 1737.4 км.
//   x = 2R·tan(π/4 + lat/2)·sin(lon),  y = 2R·tan(π/4 + lat/2)·cos(lon)
// Через вектор Луны (Moon ME, +Y — север, восток к −Z) это без тригонометрии:
//   x = 2R·(−u.z)/(1 − u.y),  y = 2R·u.x/(1 − u.y)

export const R_KM = 1737.4;
const D2R = Math.PI / 180;

export async function loadPolarData(level = 1024) {
  try {
    const meta = await fetchOk('/data/polar/meta.json').then((r) => r.json());
    let lv = meta.levels[String(level)] ?? meta.levels['512'];
    let heights;
    let detailHeights = null;
    const d2 = meta.levels['2048'];
    if (level === 1024 && d2) {
      // сетка 1024² = усреднение 2×2 детального уровня 2048² (один файл вместо двух)
      detailHeights = await loadHeightsM(d2);
      heights = downsample2(detailHeights, d2.size);
      lv = { ...d2, size: d2.size / 2, minHeight: d2.minHeight, maxHeight: d2.maxHeight };
    } else {
      heights = await loadHeightsM(lv);
    }
    let slope = null;
    if (meta.slope) {
      slope = await fetchOk(`/data/polar/${meta.slope.file}`)
        .then((r) => r.arrayBuffer())
        .then((b) => new Uint8Array(b))
        .catch(() => null);
    }
    const polar = new PolarData(meta, lv, heights, slope);
    // детальные высоты для теней/горизонта (int16, полуметры)
    const d = meta.levels['2048'];
    if (level >= 1024 && d) {
      try {
        polar.detail = new PolarData(meta, d, detailHeights ?? (await loadHeightsM(d)), null);
      } catch (err) {
        console.warn('[MoonScene] detailed polar heights unavailable, shadows use the base level:', err.message);
      }
    }
    return polar;
  } catch (err) {
    console.warn('[MoonScene] polar terrain unavailable:', err.message);
    return null;
  }
}

function downsample2(src, n) {
  const m = n / 2;
  const out = new Float32Array(m * m);
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      const i = 2 * r * n + 2 * c;
      out[r * m + c] = (src[i] + src[i + 1] + src[i + n] + src[i + n + 1]) / 4;
    }
  }
  return out;
}

/** Высоты уровня в метрах: int16 (× scale) или float32 — по meta.json. */
async function loadHeightsM(level) {
  const buf = await fetchOk(`/data/polar/${level.file}`).then((r) => r.arrayBuffer());
  if (level.dtype !== 'int16') return new Float32Array(buf);
  const raw = new Int16Array(buf);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] * level.scale;
  return out;
}

async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

export class PolarData {
  /** center — центр сетки в км карты (у основного тайла — полюс, у патчей — точка посадки) */
  constructor(meta, level, heightsM, slope, center = [0, 0]) {
    this.meta = meta;
    this.n = level.size;
    this.half = level.halfExtentKm ?? meta.halfExtentKm;
    this.cx = center[0];
    this.cy = center[1];
    this.pix = (2 * this.half) / this.n;
    this.heightsKm = new Float32Array(heightsM.length);
    for (let i = 0; i < heightsM.length; i++) this.heightsKm[i] = heightsM[i] / 1000;
    this.minH = level.minHeight / 1000;
    this.maxH = level.maxHeight / 1000;
    this.slope = slope;
    this.slopeSize = meta.slope?.size ?? 0;
  }

  // --- проекция ---

  static mapFromDir(u) {
    const k = (2 * R_KM) / (1 - u.y);
    return { x: -u.z * k, y: u.x * k };
  }

  static dirFromMap(x, y, out = new THREE.Vector3()) {
    const rho2 = (x * x + y * y) / (4 * R_KM * R_KM);
    const k = 1 / (rho2 + 1);
    return out.set((y / R_KM) * k, (rho2 - 1) * k, (-x / R_KM) * k);
  }

  static latLonToMap(lat, lon) {
    const r = 2 * R_KM * Math.tan(Math.PI / 4 + (lat * D2R) / 2);
    return { x: r * Math.sin(lon * D2R), y: r * Math.cos(lon * D2R) };
  }

  static mapToLatLon(x, y) {
    const r = Math.hypot(x, y);
    return { lat: (2 * Math.atan(r / (2 * R_KM)) - Math.PI / 2) / D2R, lon: Math.atan2(x, y) / D2R };
  }

  inside(x, y, margin = 0) {
    return Math.abs(x - this.cx) <= this.half - margin && Math.abs(y - this.cy) <= this.half - margin;
  }

  containsLatLon(lat, lon, margin = 2) {
    if (lat > -70) return false;
    const { x, y } = PolarData.latLonToMap(lat, lon);
    return this.inside(x, y, margin);
  }

  /** Высота рельефа (км) в точке карты, билинейно. Строка 0 = верх (+y). */
  heightKm(x, y) {
    const n = this.n;
    const c = THREE.MathUtils.clamp((x - this.cx + this.half) / this.pix - 0.5, 0, n - 1.001);
    const r = THREE.MathUtils.clamp((this.half - (y - this.cy)) / this.pix - 0.5, 0, n - 1.001);
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const fc = c - c0;
    const fr = r - r0;
    const h = this.heightsKm;
    const i = r0 * n + c0;
    return (h[i] * (1 - fc) + h[i + 1] * fc) * (1 - fr) + (h[i + n] * (1 - fc) + h[i + n + 1] * fc) * fr;
  }

  /**
   * Высота поверхности меша (км): интерполяция по тем же треугольникам, что и в геометрии рельефа.
   * Нужна, чтобы камера/модуль не оказались «внутри» плоского треугольника на выпуклых вершинах.
   * Возвращает максимум из меша и билинейки — так объект гарантированно над видимой поверхностью.
   */
  surfaceHeightKm(x, y) {
    const n = this.n;
    const c = THREE.MathUtils.clamp((x - this.cx + this.half) / this.pix - 0.5, 0, n - 1.001);
    const r = THREE.MathUtils.clamp((this.half - (y - this.cy)) / this.pix - 0.5, 0, n - 1.001);
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const fc = c - c0;
    const fr = r - r0;
    const h = this.heightsKm;
    const i = r0 * n + c0;
    const ha = h[i];
    const hb = h[i + 1];
    const hc = h[i + n];
    const hd = h[i + n + 1];
    // диагональ треугольников идёт от b (r, c+1) к c (r+1, c) — как в buildTerrainGeometry
    const tri = fc + fr <= 1 ? ha + fc * (hb - ha) + fr * (hc - ha) : hd + (1 - fc) * (hc - hd) + (1 - fr) * (hb - hd);
    return Math.max(tri, this.heightKm(x, y));
  }

  slopeDeg(x, y) {
    if (!this.slope) return null;
    const n = this.slopeSize;
    const c = Math.round(THREE.MathUtils.clamp((x + this.half) / ((2 * this.half) / n) - 0.5, 0, n - 1));
    const r = Math.round(THREE.MathUtils.clamp((this.half - y) / ((2 * this.half) / n) - 0.5, 0, n - 1));
    return this.slope[r * n + c] / 4;
  }

  /** Точка поверхности в системе Луны (км). */
  moonPos(x, y, out = new THREE.Vector3(), lift = 0) {
    PolarData.dirFromMap(x, y, out);
    return out.multiplyScalar(R_KM + this.heightKm(x, y) + lift);
  }

  moonPosLatLon(lat, lon, out, lift = 0) {
    const { x, y } = PolarData.latLonToMap(lat, lon);
    return this.moonPos(x, y, out, lift);
  }

  /** Точка видимой поверхности (для камеры, моделей, пинов). */
  surfacePosLatLon(lat, lon, out = new THREE.Vector3(), lift = 0) {
    const { x, y } = PolarData.latLonToMap(lat, lon);
    PolarData.dirFromMap(x, y, out);
    return out.multiplyScalar(R_KM + this.surfaceHeightKm(x, y) + lift);
  }

  /** Высоты как текстура (км, float32), строки перевёрнуты: v = 0 — низ карты (−y). */
  heightTexture() {
    const n = this.n;
    const flipped = new Float32Array(n * n);
    for (let r = 0; r < n; r++) flipped.set(this.heightsKm.subarray(r * n, r * n + n), (n - 1 - r) * n);
    const tex = new THREE.DataTexture(flipped, n, n, THREE.RedFormat, THREE.FloatType);
    tex.needsUpdate = true;
    return tex;
  }

  slopeTexture() {
    if (!this.slope) return null;
    const n = this.slopeSize;
    const flipped = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) flipped.set(this.slope.subarray(r * n, r * n + n), (n - 1 - r) * n);
    const tex = new THREE.DataTexture(flipped, n, n, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Пересечение луча (система Луны, км) с рельефом. Возвращает точку или null.
   * Маршируем: высоко над рельефом — большими шагами, в слое рельефа — по ~полпикселя.
   */
  raycast(origin, dir, maxDist = 3000) {
    const p = new THREE.Vector3();
    const top = R_KM + this.maxH + 0.05;
    let t = 0;
    let prev = 0;
    for (let i = 0; i < 20000 && t < maxDist; i++) {
      p.copy(dir).multiplyScalar(t).add(origin);
      const r = p.length();
      const above = r - top;
      if (above > 0.5) {
        prev = t;
        t += Math.max(above * 0.8, 0.2);
        continue;
      }
      const m = PolarData.mapFromDir(p.clone().divideScalar(r));
      if (!this.inside(m.x, m.y)) {
        if (above < -10) return null; // ушли под край тайла
        prev = t;
        t += this.pix * 0.5;
        continue;
      }
      if (r <= R_KM + this.heightKm(m.x, m.y)) {
        // уточняем бисекцией между prev и t
        let a = prev;
        let b = t;
        for (let k = 0; k < 24; k++) {
          const mid = (a + b) / 2;
          p.copy(dir).multiplyScalar(mid).add(origin);
          const rm = p.length();
          const mm = PolarData.mapFromDir(p.clone().divideScalar(rm));
          if (rm <= R_KM + this.heightKm(mm.x, mm.y)) b = mid;
          else a = mid;
        }
        p.copy(dir).multiplyScalar(b).add(origin);
        return p;
      }
      prev = t;
      t += this.pix * 0.4;
    }
    return null;
  }
}

/**
 * Рельеф «патч поверх тайла»: внутри патча — 20-метровые высоты, снаружи — основной тайл.
 * Тот же интерфейс, что у PolarData (горизонт, камера, модели работают без изменений).
 */
export class TerrainStack {
  constructor(base, patchData) {
    this.base = base;
    this.patch = patchData;
    this.half = base.half;
    this.n = base.n;
    this.pix = patchData.pix;
    this.maxH = Math.max(base.maxH, patchData.maxH);
    this.minH = Math.min(base.minH, patchData.minH);
  }
  inside(x, y, margin = 0) {
    return this.base.inside(x, y, margin);
  }
  containsLatLon(lat, lon, margin) {
    return this.base.containsLatLon(lat, lon, margin);
  }
  heightKm(x, y) {
    return this.patch.inside(x, y, 0.05) ? this.patch.heightKm(x, y) : this.base.heightKm(x, y);
  }
  surfaceHeightKm(x, y) {
    return this.patch.inside(x, y, 0.05) ? this.patch.surfaceHeightKm(x, y) : this.base.surfaceHeightKm(x, y);
  }
}
for (const m of ['moonPos', 'moonPosLatLon', 'surfacePosLatLon']) TerrainStack.prototype[m] = PolarData.prototype[m];

let patchIndex = null;
/** Патч 20 м для точки (или null, если для неё нет данных). */
export async function loadPatch(meta, siteId) {
  try {
    patchIndex ??= fetchOk('/data/polar/patches.json').then((r) => r.json());
    const p = (await patchIndex).patches?.[siteId];
    if (!p) return null;
    const lv = { ...p, minHeight: p.minHeight, maxHeight: p.maxHeight };
    return new PolarData(meta, lv, await loadHeightsM(p), null, p.centerKm);
  } catch (err) {
    console.warn(`[MoonScene] 20 m patch for ${siteId} unavailable:`, err.message);
    return null;
  }
}

// --- локальная система полюса (км): начало — точка полюса на сфере R ---
// X = ось x карты, Y = вверх (от центра Луны), Z = −y карты.  Базис ортонормирован, det = +1.
export const PoleFrame = {
  toLocal(p, out = new THREE.Vector3()) {
    return out.set(-p.z, -(p.y + R_KM), -p.x);
  },
  dirToLocal(d, out = new THREE.Vector3()) {
    return out.set(-d.z, -d.y, -d.x);
  },
  fromLocal(l, out = new THREE.Vector3()) {
    return out.set(-l.z, -l.y - R_KM, -l.x);
  },
  dirFromLocal(l, out = new THREE.Vector3()) {
    return out.set(-l.z, -l.y, -l.x);
  },
};
