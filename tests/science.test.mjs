// Проверки научных расчётов 3D-части: node --test tests/
// Без внешних зависимостей; данные — из public/ (то, что реально видит браузер).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as THREE from 'three';
import { latLonToVector, vectorToLatLon } from '../src/scene/coords.js';
import { getSubPoints, setEphemerisTable } from '../src/scene/ephemeris.js';
import { PolarData, PoleFrame, R_KM } from '../src/scene/polar/PolarData.js';
import { azEl, horizonProfile, siteFrame, siteConditions, EYE_HEIGHT_KM } from '../src/scene/surface/horizon.js';

const D2R = Math.PI / 180;
const ephem = JSON.parse(fs.readFileSync('public/data/ephem_subpoints.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('public/data/polar/meta.json', 'utf8'));

function loadPolar(levelKey) {
  const lv = meta.levels[levelKey];
  const buf = fs.readFileSync(`public/data/polar/${lv.file}`);
  const raw = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const m = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) m[i] = raw[i] * lv.scale;
  return new PolarData(meta, lv, m, null);
}
const polar = loadPolar('2048');

test('lat/lon ↔ vector: round trip and project axes (+X = lon 0, +Y = north, east → −Z)', () => {
  for (let i = 0; i < 200; i++) {
    const lat = Math.random() * 178 - 89;
    const lon = Math.random() * 360 - 180;
    const r = vectorToLatLon(latLonToVector(lat, lon));
    assert.ok(Math.abs(r.lat - lat) < 1e-9 && Math.abs(((r.lon - lon + 540) % 360) - 180) < 1e-9);
  }
  assert.deepEqual(latLonToVector(0, 90).toArray().map((v) => Math.round(v)), [0, 0, -1]);
});

test('south polar stereographic: round trip and agreement with the vector form', () => {
  for (const [lat, lon] of [[-89.67, 129.8], [-86, 2.9], [-84.6, 31], [-88.35, -87.1]]) {
    const m = PolarData.latLonToMap(lat, lon);
    const back = PolarData.mapToLatLon(m.x, m.y);
    assert.ok(Math.abs(back.lat - lat) < 1e-9 && Math.abs(back.lon - lon) < 1e-9);
    const m2 = PolarData.mapFromDir(latLonToVector(lat, lon));
    assert.ok(Math.hypot(m.x - m2.x, m.y - m2.y) < 1e-6);
    const d = PolarData.dirFromMap(m.x, m.y);
    assert.ok(d.distanceTo(latLonToVector(lat, lon)) < 1e-9);
  }
});

test('pole frame is a proper rotation (det = +1) and round-trips', () => {
  const p = new THREE.Vector3(12.3, -1700.1, -45.6);
  assert.ok(PoleFrame.fromLocal(PoleFrame.toLocal(p)).distanceTo(p) < 1e-9);
  const ex = PoleFrame.dirToLocal(new THREE.Vector3(1, 0, 0));
  const ey = PoleFrame.dirToLocal(new THREE.Vector3(0, 1, 0));
  const ez = PoleFrame.dirToLocal(new THREE.Vector3(0, 0, 1));
  assert.ok(Math.abs(new THREE.Matrix3().set(ex.x, ey.x, ez.x, ex.y, ey.y, ez.y, ex.z, ey.z, ez.z).determinant() - 1) < 1e-12);
});

test('LOLA tile georeference: Shackleton floor is deep, Malapert peak is high', () => {
  const shack = PolarData.latLonToMap(-89.67, 129.8);
  const mal = PolarData.latLonToMap(-86.0, 2.9);
  assert.ok(polar.heightKm(shack.x, shack.y) < -2.0, 'Shackleton floor below −2 km');
  assert.ok(polar.heightKm(mal.x, mal.y) > 4.5, 'Malapert above +4.5 km');
});

test('ephemeris: table interpolation reproduces JPL Horizons rows; analytic fallback within its stated error', () => {
  setEphemerisTable(ephem.rows);
  const row = ephem.rows[1234];
  const s = getSubPoints(new Date(row.t));
  assert.equal(s.source, 'horizons');
  assert.ok(Math.abs(s.sunLat - row.sunLat) < 1e-6 && Math.abs(s.sunLon - row.sunLon) < 1e-6);
  setEphemerisTable(null);
  const a = getSubPoints(new Date(row.t));
  assert.equal(a.source, 'analytic');
  const sunErr = latLonToVector(a.sunLat, a.sunLon).angleTo(latLonToVector(row.sunLat, row.sunLon)) / D2R;
  const earthErr = latLonToVector(a.earthLat, a.earthLon).angleTo(latLonToVector(row.earthLat, row.earthLon)) / D2R;
  assert.ok(sunErr < 1 && earthErr < 2, `analytic error sun ${sunErr.toFixed(3)}°, earth ${earthErr.toFixed(3)}°`);
  setEphemerisTable(ephem.rows);
});

test('smooth-sphere horizon dip for a 2 m eye is ≈ −0.087° (no atmosphere, no refraction)', () => {
  const P = latLonToVector(0.674, 23.473, R_KM);
  const prof = horizonProfile(null, P, siteFrame(P));
  const expected = -Math.sqrt((2 * EYE_HEIGHT_KM) / R_KM) / D2R;
  assert.equal(prof.terrainModeled, false);
  assert.ok(Math.abs(prof.el[0] - expected) < 1e-6 && Math.abs(expected + 0.0869) < 0.001); // Float32Array: ~4e-9°
});

test('Shackleton floor never sees the Sun: terrain horizon > max solar elevation (~1.6°)', () => {
  const P = polar.moonPosLatLon(-89.67, 129.8, new THREE.Vector3());
  const prof = horizonProfile(polar, P, siteFrame(P));
  const minHorizon = Math.min(...prof.el);
  assert.ok(prof.terrainModeled);
  assert.ok(minHorizon > 1.6, `lowest horizon ${minHorizon.toFixed(2)}°`);
});

test('site conditions: Sun visibility follows the terrain horizon; Earth uses parallax', () => {
  setEphemerisTable(ephem.rows);
  const P = polar.moonPosLatLon(-86.0, 2.9, new THREE.Vector3());
  const f = siteFrame(P);
  const eye = P.clone().addScaledVector(f.up, EYE_HEIGHT_KM);
  const prof = horizonProfile(polar, P, f);
  const sub = getSubPoints(new Date('2027-01-16T00:00:00Z'));
  const sun = latLonToVector(sub.sunLat, sub.sunLon);
  const earthPos = latLonToVector(sub.earthLat, sub.earthLon, sub.earthDistKm);
  const c = siteConditions(prof, f, eye, sun, earthPos, Math.asin(6371 / sub.earthDistKm) / D2R);
  assert.ok(c.sunEl > c.sunHorizonEl && c.sunVisibleFraction > 0.99, 'Malapert summit sunlit on 2027-01-16');
  // параллакс: направление «из центра» и «из точки» различаются примерно на R/D ≈ 0.26°
  const noParallax = azEl(f, earthPos).el;
  assert.ok(Math.abs(noParallax - c.earthEl) > 0.1 && Math.abs(noParallax - c.earthEl) < 0.3);
});

test('cross-check with the team DE440s ephemeris (Participant 2), if available via git', (t) => {
  let team;
  try {
    team = JSON.parse(execSync('git show origin/main:public/data/ephem.json', { maxBuffer: 64e6 }).toString());
  } catch {
    return t.skip('origin/main:public/data/ephem.json not available');
  }
  setEphemerisTable(ephem.rows);
  const sites = JSON.parse(fs.readFileSync('public/data/sites.json', 'utf8'));
  const t0 = Date.parse(team.meta.start_utc);
  let max = 0;
  for (const s of sites) {
    const P = latLonToVector(s.lat, s.lon, R_KM);
    const f = siteFrame(P);
    for (let h = 0; h < team.meta.n; h += 97) {
      const sub = getSubPoints(new Date(t0 + h * 3600e3));
      max = Math.max(max, Math.abs(azEl(f, latLonToVector(sub.sunLat, sub.sunLon)).el - team.sites[s.id].sun_el[h] / 100));
    }
  }
  assert.ok(max < 0.02, `max |Δ sun elevation| = ${max.toFixed(4)}°`);
});

test('regression: horizon cache is cleared when polar terrain arrives (no stale smooth-sphere profile)', () => {
  const src = fs.readFileSync('src/scene/MoonScene.js', 'utf8');
  const ready = src.slice(src.indexOf('this.polarReady = loadPolarData'), src.indexOf("this._emit('polarready'"));
  assert.ok(ready.includes('this.horizonCache.clear()'));
});

test('landing physics: guided descent at g = 1.62 lands on target, softly, within thrust limit', async () => {
  const { DescentSim } = await import('../src/scene/descentSim.js');
  for (const dir of [[0, 1], [0.6, -0.8]]) {
    const sim = new DescentSim({ approachDir: dir });
    let s = sim.state();
    let maxTilt = 0;
    for (let i = 0; i < 60 * 240 && s.phase !== 'LANDED'; i++) {
      s = sim.step(1 / 60);
      const T = s.thrust;
      if (T[2] > 0) maxTilt = Math.max(maxTilt, (Math.atan2(Math.hypot(T[0], T[1]), T[2]) * 180) / Math.PI);
    }
    assert.equal(s.phase, 'LANDED');
    const miss = Math.hypot(s.pos[0], s.pos[1]);
    assert.ok(miss < 5, `miss distance ${miss.toFixed(2)} m`);
    assert.ok(sim.touchdownSpeed < 3, `touchdown speed ${sim.touchdownSpeed.toFixed(2)} m/s`);
    assert.ok(sim.maxThrustSeen <= sim.thrustMax + 1e-9);
    assert.ok(maxTilt > 15, `lander pitches back while braking (max tilt ${maxTilt.toFixed(1)}°)`);
    assert.ok(s.t > 40 && s.t < 140, `descent time ${s.t.toFixed(0)} s`);
  }
});
