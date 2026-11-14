import * as THREE from 'three';
import { PolarData, R_KM } from '../polar/PolarData.js';

// Горизонт и положение Солнца/Земли в точке поверхности (CPU).
// Алгоритм тот же, что в шейдере: рельеф — радиус R + h, кривизна учтена геометрией,
// атмосферы и рефракции нет.

const D2R = Math.PI / 180;
export const SUN_ANG_RADIUS_DEG = 0.2665;
export const EYE_HEIGHT_KM = 0.002;

/** Локальный базис в точке P (система Луны): up, east, north. */
export function siteFrame(P) {
  const up = P.clone().normalize();
  let east = new THREE.Vector3(up.z, 0, -up.x); // ∂u/∂lon ∝ (−sin lon, 0, −cos lon)
  if (east.lengthSq() < 1e-12) east.set(0, 0, -1); // ровно на полюсе
  east.normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  return { up, east, north };
}

/** Азимут (от севера по часовой, к востоку) и высота направления d, градусы. */
export function azEl(frame, d) {
  const v = d.clone().normalize();
  const el = Math.asin(THREE.MathUtils.clamp(v.dot(frame.up), -1, 1)) / D2R;
  let az = Math.atan2(v.dot(frame.east), v.dot(frame.north)) / D2R;
  if (az < 0) az += 360;
  return { az, el };
}

/** Направление по азимуту/высоте в системе Луны. */
export function dirFromAzEl(frame, az, el, out = new THREE.Vector3()) {
  const a = az * D2R;
  const e = el * D2R;
  return out
    .copy(frame.north)
    .multiplyScalar(Math.cos(a) * Math.cos(e))
    .addScaledVector(frame.east, Math.sin(a) * Math.cos(e))
    .addScaledVector(frame.up, Math.sin(e));
}

/**
 * Профиль горизонта: высота (°) по 360 азимутам.
 * Внутри тайла полюса — по рельефу LOLA, снаружи — гладкая сфера (terrainModeled = false).
 */
export function horizonProfile(polar, P, frame, stepDeg = 1) {
  const count = Math.round(360 / stepDeg);
  const el = new Float32Array(count);
  const smoothDip = -Math.sqrt((2 * EYE_HEIGHT_KM) / R_KM) / D2R;
  const m0 = PolarData.mapFromDir(frame.up);
  const terrainModeled = !!polar && polar.inside(m0.x, m0.y, 1);
  if (!terrainModeled) {
    el.fill(smoothDip);
    return { el, stepDeg, terrainModeled, maxRangeKm: 0 };
  }

  const eye = frame.up.clone().multiplyScalar(R_KM + polar.heightKm(m0.x, m0.y) + EYE_HEIGHT_KM);
  const d = new THREE.Vector3();
  const q = new THREE.Vector3();
  const v = new THREE.Vector3();
  let maxRange = 0;
  for (let i = 0; i < count; i++) {
    const a = i * stepDeg * D2R;
    d.copy(frame.north).multiplyScalar(Math.cos(a)).addScaledVector(frame.east, Math.sin(a));
    let best = smoothDip;
    let s = polar.pix * 0.75;
    while (s < 420) {
      const th = s / R_KM;
      q.copy(frame.up).multiplyScalar(Math.cos(th)).addScaledVector(d, Math.sin(th));
      const m = PolarData.mapFromDir(q);
      if (!polar.inside(m.x, m.y)) break;
      q.multiplyScalar(R_KM + polar.heightKm(m.x, m.y));
      v.subVectors(q, eye);
      const e = Math.asin(THREE.MathUtils.clamp(v.dot(frame.up) / v.length(), -1, 1)) / D2R;
      if (e > best) best = e;
      maxRange = Math.max(maxRange, s);
      s = s * 1.02 + 0.05;
    }
    el[i] = best;
  }
  return { el, stepDeg, terrainModeled, maxRangeKm: maxRange };
}

export function horizonAt(profile, az) {
  const n = profile.el.length;
  const x = (((az / profile.stepDeg) % n) + n) % n;
  const i = Math.floor(x);
  const f = x - i;
  return profile.el[i] * (1 - f) + profile.el[(i + 1) % n] * f;
}

/**
 * Условия в точке: Солнце/Земля над горизонтом рельефа.
 * sunDir — единичный вектор (система Луны), earthPos — положение Земли, км (с параллаксом).
 */
export function siteConditions(profile, frame, eye, sunDir, earthPos, earthRadiusDeg) {
  const sun = azEl(frame, sunDir);
  const toEarth = earthPos.clone().sub(eye);
  const earth = azEl(frame, toEarth);
  const sunHor = horizonAt(profile, sun.az);
  const earthHor = horizonAt(profile, earth.az);
  const sunFraction = THREE.MathUtils.clamp(0.5 + (sun.el - sunHor) / (2 * SUN_ANG_RADIUS_DEG), 0, 1);
  const earthFraction = THREE.MathUtils.clamp(0.5 + (earth.el - earthHor) / (2 * earthRadiusDeg), 0, 1);
  return {
    sunAz: sun.az,
    sunEl: sun.el,
    sunHorizonEl: sunHor,
    sunVisibleFraction: sunFraction,
    earthAz: earth.az,
    earthEl: earth.el,
    earthHorizonEl: earthHor,
    earthVisibleFraction: earthFraction,
    terrainModeled: profile.terrainModeled,
  };
}
