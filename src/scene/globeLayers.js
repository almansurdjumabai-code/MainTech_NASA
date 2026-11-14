import * as THREE from 'three';
import { cmComms, cmIllum } from './polar/glsl.js';
import { latLonToVector } from './coords.js';

// Слои на глобусе. Освещённость/связь — по гладкой сфере (рельеф здесь не моделируется,
// это честно подписано в легенде). Уклон — готовая цветная карта из LOLA LDEM 16 ppd.

const W = 512;
const H = 256;
const SUN_R = (0.2665 * Math.PI) / 180;
const EARTH_RADIUS_KM = 6371;
const R_KM = 1737.4;

export class GlobeLayers {
  constructor({ onAssetError } = {}) {
    this.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.82, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1.0075, 192, 96), this.material);
    this.mesh.name = 'globe-layer';
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
    this.slope = null;
    new THREE.TextureLoader().load(
      '/textures/moon_slope_2k.jpg',
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        this.slope = t;
        if (this.layer === 'slope') this._show(t);
      },
      undefined,
      () => onAssetError?.('moon_slope_2k.jpg'),
    );
    this.dirs = new Float32Array(W * H * 3);
    const v = new THREE.Vector3();
    for (let j = 0; j < H; j++) {
      const lat = 90 - ((j + 0.5) * 180) / H;
      for (let i = 0; i < W; i++) {
        latLonToVector(lat, -180 + ((i + 0.5) * 360) / W, 1, v);
        this.dirs.set([v.x, v.y, v.z], (j * W + i) * 3);
      }
    }
    this.cache = new Map();
  }

  set(layer) {
    this.layer = layer;
    if (layer === 'relief') return (this.mesh.visible = false);
    if (layer === 'slope') return this.slope ? this._show(this.slope) : (this.mesh.visible = false);
    const tex = this.cache.get(layer);
    if (tex) this._show(tex);
  }

  /** Освещённость/связь за период: subs — эфемериды N моментов. */
  compute(layer, subs, periodKey) {
    const key = `${layer}|${periodKey}`;
    if (this.cacheKey?.[layer] === key && this.cache.has(layer)) return this.cache.get(layer);
    const acc = new Float32Array(W * H);
    const s = new THREE.Vector3();
    const e = new THREE.Vector3();
    for (const sub of subs) {
      if (layer === 'illumination') {
        latLonToVector(sub.sunLat, sub.sunLon, 1, s);
        for (let k = 0; k < W * H; k++) {
          const d = this.dirs;
          const el = Math.asin(d[k * 3] * s.x + d[k * 3 + 1] * s.y + d[k * 3 + 2] * s.z);
          acc[k] += Math.min(1, Math.max(0, 0.5 + el / (2 * SUN_R)));
        }
      } else {
        // Земля с параллаксом: направление из точки поверхности, в радиусах Луны
        latLonToVector(sub.earthLat, sub.earthLon, sub.earthDistKm / R_KM, e);
        const er = Math.asin(EARTH_RADIUS_KM / sub.earthDistKm);
        for (let k = 0; k < W * H; k++) {
          const d = this.dirs;
          const vx = e.x - d[k * 3];
          const vy = e.y - d[k * 3 + 1];
          const vz = e.z - d[k * 3 + 2];
          const el = Math.asin((vx * d[k * 3] + vy * d[k * 3 + 1] + vz * d[k * 3 + 2]) / Math.hypot(vx, vy, vz));
          acc[k] += Math.min(1, Math.max(0, 0.5 + el / (2 * er)));
        }
      }
    }
    const cm = layer === 'illumination' ? cmIllum : cmComms;
    const px = new Uint8Array(W * H * 4);
    for (let k = 0; k < W * H; k++) {
      const f = acc[k] / subs.length;
      const [r, g, b] = cm(f);
      // строка 0 текстуры = низ (v = 0) → переворачиваем
      const j = H - 1 - Math.floor(k / W);
      const o = (j * W + (k % W)) * 4;
      px[o] = r * 255;
      px[o + 1] = g * 255;
      px[o + 2] = b * 255;
      px[o + 3] = 255;
    }
    const tex = new THREE.DataTexture(px, W, H);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.cache.get(layer)?.dispose();
    this.cache.set(layer, tex);
    this.cacheKey = { ...this.cacheKey, [layer]: key };
    this.values = { ...this.values, [layer]: acc.map((a) => a / subs.length) };
    if (this.layer === layer) this._show(tex);
    return tex;
  }

  /** Значение слоя в точке (0..1) — для сверки с карточкой UI. */
  valueAt(layer, lat, lon) {
    const v = this.values?.[layer];
    if (!v) return null;
    const j = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
    const i = Math.min(W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * W)));
    return v[j * W + i];
  }

  _show(tex) {
    this.material.map = tex;
    this.material.needsUpdate = true;
    this.mesh.visible = true;
  }

  dispose() {
    for (const t of this.cache.values()) t.dispose();
    this.slope?.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
