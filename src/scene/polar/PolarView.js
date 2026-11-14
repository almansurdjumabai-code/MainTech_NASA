import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { PolarData, PoleFrame, R_KM, TerrainStack } from './PolarData.js';
import { VisibilityPass } from './VisibilityPass.js';
import { COLORMAPS } from './glsl.js';
import { Sky } from '../surface/sky.js';
import { CATEGORIES, HEADS, STEM, makeBeacon } from '../markers.js';
import { latLonToVector } from '../coords.js';

// Режим «Polar view»: рельеф Южного полюса в локальной системе (км) с началом на полюсе.
// Своя сцена — из-за точности float32 и near/far на масштабах метры vs 1737 км.
// Вершины строятся точно на сфере R + h (кривизна учтена без приближения d²/2R).

const LAYER_INDEX = { relief: 0, slope: 1, illumination: 2, comms: 3 };
const EARTH_RADIUS_KM = 6371;

const TERRAIN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 patchUv;
varying vec2 vUv;
varying vec2 vPatchUv;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vPatchUv = patchUv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}
`;

const TERRAIN_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${COLORMAPS}
uniform sampler2D uShadow;
uniform sampler2D uEarthVis;   // доля видимого диска Земли (рельеф может её закрыть)
uniform sampler2D uDetail;     // нормали из 80 м DEM (x карты, y карты, вверх)
uniform float uHasDetail;
uniform sampler2D uSlope;
uniform sampler2D uAccum;
uniform int uLayer;
uniform float uLayerOpacity;
uniform vec3 uSunL;
uniform vec3 uEarthL;
uniform float uSunI;
uniform float uEarthI;
uniform vec3 uAlbedo;
uniform float uHalf;
uniform float uR;
uniform float uGrid;
uniform sampler2D uLanderDepth;
uniform mat4 uLanderMatrix;
uniform float uLanderOn;
uniform vec2 uHighlight;
uniform float uHighlightOn;
uniform float uUsePatchUv;  // 1 — меш патча: тени из текстуры патча
uniform vec3 uHideRect;     // тайл не рисуется под патчем (центр x, y, половина стороны)
uniform float uHideOn;
uniform vec3 uPlumePos;   // точка факела (локальные км)
uniform float uPlumeI;    // яркость факела 0..1
varying vec2 vUv;
varying vec2 vPatchUv;
varying vec3 vN;
varying vec3 vWorld;

void main() {
  #include <logdepthbuf_fragment>
  if (uHideOn > 0.5) {
    vec2 mm = (vUv * 2.0 - 1.0) * uHalf - uHideRect.xy;
    if (abs(mm.x) < uHideRect.z && abs(mm.y) < uHideRect.z) discard;
  }
  vec3 N = normalize(vN);
  if (uHasDetail > 0.5) {
    // базис в точке: «вверх» — радиально от центра Луны (0, −R, 0), x/y карты — оси X и −Z
    vec3 upR = normalize(vWorld + vec3(0.0, uR, 0.0));
    vec3 ax = normalize(vec3(1.0, 0.0, 0.0) - upR * upR.x);
    vec3 ay = normalize(cross(upR, ax));
    vec3 t = texture2D(uDetail, vUv).xyz * 2.0 - 1.0;
    N = normalize(t.x * ax + t.y * ay + t.z * upR);
  }
  vec3 V = normalize(cameraPosition - vWorld);
  float mu0 = max(dot(N, uSunL), 0.0);
  float mu = max(dot(N, V), 0.0);
  // реголит: смесь Ламберта и Ломмеля–Зеелигера (плоский вид полнолуния)
  float brdf = mix(mu0, 2.0 * mu0 / (mu0 + mu + 1e-3), 0.55);
  float vis = texture2D(uShadow, uUsePatchUv > 0.5 ? vPatchUv : vUv).r;

  if (uLanderOn > 0.5) { // тень посадочного модуля (shadow map, подход B)
    vec4 sc = uLanderMatrix * vec4(vWorld, 1.0);
    vec3 p = sc.xyz / sc.w * 0.5 + 0.5;
    if (all(greaterThan(p.xy, vec2(0.0))) && all(lessThan(p.xy, vec2(1.0))) && p.z < 1.0) {
      float d = texture2D(uLanderDepth, p.xy).r;
      if (p.z - 0.0005 > d) vis = 0.0;
    }
  }

  // атмосферы нет: в тени только пепельный свет Земли, и только там, откуда Земля видна
  float evis = texture2D(uEarthVis, vUv).r;
  vec3 col = uAlbedo * (uSunI * brdf * vis + uEarthI * evis * max(dot(N, uEarthL), 0.0));
  if (uPlumeI > 0.0) { // факел двигателя подсвечивает реголит под модулем
    vec3 dl = uPlumePos - vWorld;
    float d2 = dot(dl, dl) / (0.025 * 0.025);
    col += vec3(1.0, 0.62, 0.3) * uPlumeI * 0.6 * max(dot(N, normalize(dl)), 0.0) / (1.0 + d2);
  }
  float lit = clamp(brdf * vis * 2.0 + 0.2, 0.0, 1.0);

  if (uLayer == 1) {
    float deg = texture2D(uSlope, vUv).r * 255.0 / 4.0;
    col = mix(col, cmSlope(deg) * (0.3 + 0.7 * lit), uLayerOpacity);
  } else if (uLayer == 2) {
    col = mix(col, cmIllum(texture2D(uAccum, vUv).r) * (0.75 + 0.25 * lit), uLayerOpacity);
  } else if (uLayer == 3) {
    col = mix(col, cmComms(texture2D(uAccum, vUv).r) * (0.75 + 0.25 * lit), uLayerOpacity);
  }

  vec2 m = (vUv * 2.0 - 1.0) * uHalf;
  if (uGrid > 0.0) { // сетка: широта каждый 1°, долгота каждые 30°
    float r = length(m);
    float lat = -90.0 + 2.0 * atan(r / (2.0 * uR)) * 57.29578;
    float lon = atan(m.x, m.y) * 57.29578;
    float gl = 1.0 - clamp(abs(fract(lat + 0.5) - 0.5) / max(fwidth(lat), 1e-5), 0.0, 1.0);
    float go = (1.0 - clamp(abs(fract(lon / 30.0 + 0.5) - 0.5) * 30.0 / max(fwidth(lon), 1e-4), 0.0, 1.0)) * step(6.0, r);
    float facing = smoothstep(0.15, 0.5, abs(dot(N, V))); // у горизонта сетка гаснет (иначе муар)
    col = mix(col, vec3(0.45, 0.72, 1.0), max(gl, go) * 0.09 * uGrid * facing);
  }
  if (uHighlightOn > 0.5) { // кольцо 3 км вокруг выбранной точки
    float d = length(m - uHighlight);
    // max(): вблизи камеры fwidth может быть 0, а smoothstep(0, 0, x) в GLSL не определён
    float ring = 1.0 - smoothstep(0.0, max(fwidth(d) * 1.5, 1e-3), abs(d - 3.0));
    col = mix(col, vec3(1.0, 0.82, 0.3), ring * 0.9);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Матрица поворота «система Луны → локальная система полюса»
function poleQuaternion() {
  const m = new THREE.Matrix4().set(0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export class PolarView {
  constructor(renderer, polar, { onAssetError, quality = 'high' } = {}) {
    this.renderer = renderer;
    this.polar = polar;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 30000);
    this.camera.position.set(0, 230, 210);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.maxDistance = 1400;
    this.controls.minDistance = 0.05;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 0, 0);

    this.heightTex = polar.heightTexture();
    this.slopeTex = polar.slopeTexture() ?? blackTexture();
    // тени и слои — по детальным высотам 2048² (если загружены), меш — по 1024²
    const shade = polar.detail ?? polar;
    this.shadeTex = shade === polar ? this.heightTex : shade.heightTexture();
    this.vis = new VisibilityPass(renderer, polar, this.shadeTex, shade.n);

    this.material = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      uniforms: {
        uShadow: { value: whiteTexture() },
        uEarthVis: { value: whiteTexture() },
        uDetail: { value: blackTexture() },
        uHasDetail: { value: 0 },
        uSlope: { value: this.slopeTex },
        uAccum: { value: blackTexture() },
        uLayer: { value: 0 },
        uLayerOpacity: { value: 0.85 },
        uSunL: { value: new THREE.Vector3(0, 1, 0) },
        uEarthL: { value: new THREE.Vector3(0, 1, 0) },
        uSunI: { value: 2.6 },
        uEarthI: { value: 0 },
        uAlbedo: { value: new THREE.Color(0.125, 0.122, 0.118) },
        uHalf: { value: polar.half },
        uR: { value: R_KM },
        uGrid: { value: 1 },
        uLanderDepth: { value: blackTexture() },
        uLanderMatrix: { value: new THREE.Matrix4() },
        uLanderOn: { value: 0 },
        uHighlight: { value: new THREE.Vector2() },
        uHighlightOn: { value: 0 },
        uUsePatchUv: { value: 0 },
        uHideRect: { value: new THREE.Vector3() },
        uHideOn: { value: 0 },
        uPlumePos: { value: new THREE.Vector3() },
        uPlumeI: { value: 0 },
      },
    });
    if (polar.meta.normal) {
      const file = quality === 'low' && polar.meta.normal.fileLow ? polar.meta.normal.fileLow : polar.meta.normal.file;
      new THREE.TextureLoader().load(`/data/polar/${file}`, (t) => {
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        t.colorSpace = THREE.NoColorSpace;
        this.material.uniforms.uDetail.value = t;
        this.material.uniforms.uHasDetail.value = 1;
      });
    }
    this.terrain = new THREE.Mesh(buildTerrainGeometry(polar), this.material);
    this.terrain.name = 'polar-terrain';
    this.scene.add(this.terrain);

    // свет для моделей (рельеф освещается своим шейдером)
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
    this.earthLight = new THREE.DirectionalLight(0x9db8ff, 0);
    this.scene.add(this.sunLight, this.sunLight.target, this.earthLight, this.earthLight.target);

    this.moonToLocal = poleQuaternion();
    this.sky = new Sky({ moonToLocal: this.moonToLocal, onAssetError });
    this.scene.add(this.sky.group);

    this.markers = new THREE.Group();
    this.markers.name = 'polar-markers';
    this.scene.add(this.markers);
    this.pins = new Map();

    this.models = new THREE.Group();
    this.scene.add(this.models);
    this.lander = null;

    // теневая камера модуля (подход B): рендерим только модуль в depth-текстуру
    this.landerShadow = {
      rt: new THREE.WebGLRenderTarget(1024, 1024, { depthTexture: new THREE.DepthTexture(1024, 1024) }),
      camera: new THREE.OrthographicCamera(-0.015, 0.015, 0.015, -0.015, 0, 1.2),
      scene: new THREE.Scene(),
    };

    this.state = { sunDirMoon: new THREE.Vector3(0, 1, 0), earthPosMoon: new THREE.Vector3(1e5, 0, 0) };
    this.shadowKey = { A: null, B: null };
    this.shadowTex = { A: null, B: null };
    this.earthTex = { A: null, B: null };
    this.patchShadow = { A: null, B: null };
    this.patch = null; // { data, mesh, tex, uniforms }
    this.terrainSrc = polar; // откуда брать высоты для камеры/моделей (тайл или стек с патчем)
    this.earthshineRatio = 0.015; // доля солнечной яркости при «полноземлии» (задаёт MoonScene)
    this.surface = null; // активный вид с поверхности
  }

  // ---------- состояние даты ----------

  /** sub — getSubPoints(date); key — 'A' (основной) или 'B' (сравнение) */
  setSubPoints(key, sub, date) {
    const sunDir = latLonToVector(sub.sunLat, sub.sunLon);
    const earthPos = latLonToVector(sub.earthLat, sub.earthLon, sub.earthDistKm);
    if (key === 'A') {
      this.state.sunDirMoon.copy(sunDir);
      this.state.earthPosMoon.copy(earthPos);
      this.state.sub = sub;
      this.state.date = date;
    }
    this[`_sun${key}`] = sunDir;
    this[`_earth${key}`] = earthPos;
    this[`_sub${key}`] = sub;
    const k = `${sunDir.x.toFixed(6)},${sunDir.y.toFixed(6)},${sunDir.z.toFixed(6)}`;
    if (this.shadowKey[key] !== k) {
      this.shadowKey[key] = k;
      this[`_dirty${key}`] = true;
    }
  }

  /** Пересчитать текстуры теней, если дата изменилась (только при смене, не каждый кадр). */
  updateShadows({ compare = false, size = 1024 } = {}) {
    for (const key of compare ? ['A', 'B'] : ['A']) {
      if (!this[`_dirty${key}`] && this.shadowTex[key] && this[`_size${key}`] === size) continue;
      if (!this[`_sun${key}`]) continue;
      const t0 = performance.now();
      this.shadowTex[key] = this.vis.shadow(`shadow${key}`, this[`_sun${key}`], size);
      // видимость Земли (с параллаксом) для пепельного света — в половинном разрешении
      const ep = this[`_earth${key}`];
      this.earthTex[key] = this.vis.shadowToPoint(`earth${key}`, ep, Math.asin(EARTH_RADIUS_KM / ep.length()), Math.max(256, size / 2));
      this[`_dirty${key}`] = false;
      this[`_size${key}`] = size;
      if (this.patch) this.patchShadow[key] = this.vis.shadowPatch(`patch${key}`, this[`_sun${key}`], this.patch.data, this.patch.tex, size);
      this.lastShadowMs = performance.now() - t0;
    }
  }

  /** Применить сценарий A/B к униформам и свету перед рендером. */
  applyScenario(key) {
    const sunDir = this[`_sun${key}`] ?? this.state.sunDirMoon;
    const earthPos = this[`_earth${key}`] ?? this.state.earthPosMoon;
    const sub = this[`_sub${key}`] ?? this.state.sub;
    const u = this.material.uniforms;
    if (this.shadowTex[key]) u.uShadow.value = this.shadowTex[key];
    if (this.patch && this.patchShadow[key]) this.patch.uniforms.uShadow.value = this.patchShadow[key];
    if (this.earthTex[key]) u.uEarthVis.value = this.earthTex[key];
    PoleFrame.dirToLocal(sunDir, u.uSunL.value);
    const eyeMoon = PoleFrame.fromLocal(this.camera.position, new THREE.Vector3());
    const earthDir = earthPos.clone().sub(eyeMoon).normalize();
    PoleFrame.dirToLocal(earthDir, u.uEarthL.value);
    u.uEarthI.value = u.uSunI.value * this.earthshineRatio * (sub?.earthPhase ?? 0);
    this.sunLight.position.copy(u.uSunL.value).multiplyScalar(100);
    this.earthLight.position.copy(u.uEarthL.value).multiplyScalar(100);
    this.earthLight.intensity = this.sunLight.intensity * this.earthshineRatio * (sub?.earthPhase ?? 0);
    if (sub && this.state.date) {
      this.sky.update(this.camera, (this._skyArgs = {
        sunDirMoon: sunDir,
        earthDirMoon: earthDir,
        earthAngR: Math.asin(EARTH_RADIUS_KM / earthPos.distanceTo(eyeMoon)),
        sub,
        date: this.state.date,
      }));
    }
    if (this.lander) this._updateLanderShadow(u.uSunL.value);
  }

  // ---------- слои ----------

  setLayer(name, accumTexture) {
    const u = this.material.uniforms;
    u.uLayer.value = LAYER_INDEX[name] ?? 0;
    if (accumTexture) u.uAccum.value = accumTexture;
  }

  /** Сэмплы для накопления: sun — направления, comms — положения Земли (с параллаксом в шейдере). */
  accumulate(kind, subs, opts) {
    const samples = subs.map((sub) =>
      kind === 'illumination'
        ? { dir: latLonToVector(sub.sunLat, sub.sunLon) }
        : {
            point: latLonToVector(sub.earthLat, sub.earthLon, sub.earthDistKm),
            angR: Math.asin(EARTH_RADIUS_KM / sub.earthDistKm),
          },
    );
    return this.vis.accumulate(kind, samples, opts);
  }

  // ---------- маркеры ----------

  setSites(sites) {
    for (const p of this.pins.values()) this._removePin(p);
    this.pins.clear();
    for (const s of sites) this.addSite(s);
  }

  addSite(site) {
    if (this.pins.has(site.id)) this._removePin(this.pins.get(site.id));
    if (!this.polar.containsLatLon(site.lat, site.lon)) return;
    const cat = CATEGORIES[site.category] ?? CATEGORIES.custom;
    const mat = new THREE.MeshBasicMaterial({ color: cat.color });
    const pin = new THREE.Group();
    const stem = new THREE.Mesh(STEM, mat);
    stem.scale.set(1, 2.6, 1);
    const head = new THREE.Mesh(HEADS[site.category] ?? HEADS.custom, mat);
    head.position.y = 3.2;
    stem.userData.siteId = head.userData.siteId = site.id;
    pin.add(stem, head);
    const beacon = makeBeacon(cat.color, 3.2);
    pin.add(beacon.group);
    const el = document.createElement('div');
    el.className = 'moon-label';
    el.innerHTML = `<span class="ico">${cat.icon}</span>`;
    el.append(document.createTextNode(site.name));
    el.style.setProperty('--c', cat.color);
    const label = new CSS2DObject(el);
    label.position.y = 3.2;
    label.center.set(-0.12, 0.5);
    pin.add(label);
    this.markers.add(pin);
    const entry = { site, pin, mat, el, label, beacon };
    this._placePin(entry);
    this.pins.set(site.id, entry);
  }

  removeSite(id) {
    const p = this.pins.get(id);
    if (p) this._removePin(p);
    this.pins.delete(id);
  }

  _removePin(p) {
    p.el.remove();
    this.markers.remove(p.pin);
    p.mat.dispose();
  }

  _placePin(entry) {
    const P = this.polar.surfacePosLatLon(entry.site.lat, entry.site.lon, new THREE.Vector3());
    PoleFrame.toLocal(P, entry.pin.position);
    const up = PoleFrame.dirToLocal(P.clone().normalize(), new THREE.Vector3());
    entry.pin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  }

  select(id) {
    this._selected = id;
    for (const [pid, p] of this.pins) p.el.classList.toggle('selected', pid === id);
    const p = this.pins.get(id);
    const u = this.material.uniforms;
    u.uHighlightOn.value = p ? 1 : 0;
    if (p) {
      const m = PolarData.latLonToMap(p.site.lat, p.site.lon);
      u.uHighlight.value.set(m.x, m.y);
    }
  }

  pickables() {
    const out = [];
    for (const { pin } of this.pins.values()) pin.traverse((o) => o.isMesh && o.userData.siteId && out.push(o));
    return out;
  }

  // ---------- камера ----------

  /** Камера над точкой (lat, lon): высота altKm, наклонный вид. */
  lookAtSite(lat, lon, altKm = 120, tilt = 0.75) {
    const target = this.localSurface(lat, lon);
    this.controls.target.copy(target);
    const back = target.clone().setY(0).normalize();
    if (back.lengthSq() < 0.5) back.set(0, 0, 1);
    this.camera.position.copy(target).addScaledVector(back, altKm * tilt).add(new THREE.Vector3(0, altKm, 0));
    this.camera.lookAt(target);
  }

  localSurface(lat, lon, lift = 0) {
    return PoleFrame.toLocal(this.terrainSrc.surfacePosLatLon(lat, lon, new THREE.Vector3(), lift), new THREE.Vector3());
  }

  /** Высота камеры над рельефом, км (для near/far и чтобы не провалиться). */
  altitude(pos = this.camera.position) {
    const P = PoleFrame.fromLocal(pos, new THREE.Vector3());
    const r = P.length();
    const m = PolarData.mapFromDir(P.clone().divideScalar(r));
    const h = this.polar.inside(m.x, m.y) ? this.polar.heightKm(m.x, m.y) : 0;
    return r - (R_KM + h);
  }

  /** Луч из камеры → точка рельефа {point (local), lat, lon} или null. */
  pickTerrain(raycaster) {
    const o = PoleFrame.fromLocal(raycaster.ray.origin, new THREE.Vector3());
    const d = PoleFrame.dirFromLocal(raycaster.ray.direction, new THREE.Vector3());
    const hit = this.polar.raycast(o, d);
    if (!hit) return null;
    const m = PolarData.mapFromDir(hit.clone().normalize());
    return { point: PoleFrame.toLocal(hit, new THREE.Vector3()), ...PolarData.mapToLatLon(m.x, m.y) };
  }

  /** Кадровое обновление: near/far, размер пинов, камера не уходит под рельеф. */
  frame(camera = this.camera, orbit = true) {
    const alt = this.altitude(camera.position);
    if (orbit && alt < 0.02) {
      const up = PoleFrame.dirToLocal(PoleFrame.fromLocal(camera.position, new THREE.Vector3()).normalize(), new THREE.Vector3());
      camera.position.addScaledVector(up, 0.02 - alt);
    }
    camera.near = THREE.MathUtils.clamp(Math.max(alt, 0.001) * 0.3, 0.0005, 2);
    camera.far = 30000;
    camera.updateProjectionMatrix();
    const s = THREE.MathUtils.clamp(Math.max(alt, 0.05) * 0.012, 0.0006, 2.2);
    const t = performance.now() / 1000;
    for (const { pin, beacon, site } of this.pins.values()) {
      pin.scale.setScalar(s);
      beacon.update(t, site.id === this._selected);
    }
  }

  // ---------- модели на поверхности ----------

  /** Поставить модель на рельеф в (lat, lon) по нормали поверхности. */
  placeOnSurface(object, lat, lon, yawToSunDeg = 0) {
    const { x, y } = PolarData.latLonToMap(lat, lon);
    const d = this.polar.pix;
    const src = this.terrainSrc;
    const d2 = src === this.polar ? d : src.pix;
    const p = (dx, dy) => PoleFrame.toLocal(src.moonPos(x + dx * (d2 / d), y + dy * (d2 / d), new THREE.Vector3()), new THREE.Vector3());
    const c = this.localSurface(lat, lon);
    const ex = p(d, 0).sub(p(-d, 0));
    const ey = p(0, d).sub(p(0, -d));
    const n = new THREE.Vector3().crossVectors(ey, ex).normalize();
    if (n.y < 0) n.negate();
    object.position.copy(c);
    object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    object.rotateY(THREE.MathUtils.degToRad(yawToSunDeg));
    object.scale.setScalar(0.001); // модели в метрах → км
    return { position: c, normal: n };
  }

  /** Патч 20 м вокруг точки: детальный меш + тени по 20-метровым высотам. null — убрать. */
  setPatch(patchData) {
    if (this.patch) {
      this.scene.remove(this.patch.mesh);
      this.patch.mesh.geometry.dispose();
      this.patch.tex.dispose();
      this.patch.material.dispose();
      this.patch = null;
    }
    const u = this.material.uniforms;
    u.uHideOn.value = 0;
    this.terrainSrc = this.polar;
    if (!patchData) return;
    const tex = patchData.heightTexture();
    // общие униформы (Солнце, слои, сетка…) — те же объекты; свои — тени, вид UV, нормали
    const uniforms = { ...u, uShadow: { value: u.uShadow.value }, uUsePatchUv: { value: 1 }, uHasDetail: { value: 0 }, uHideOn: { value: 0 } };
    const material = new THREE.ShaderMaterial({ vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, uniforms });
    const mesh = new THREE.Mesh(buildTerrainGeometry(patchData, this.polar.half), material);
    mesh.name = 'polar-terrain-patch-20m';
    this.scene.add(mesh);
    u.uHideRect.value.set(patchData.cx, patchData.cy, patchData.half - 0.03);
    u.uHideOn.value = 1;
    this.patch = { data: patchData, mesh, tex, material, uniforms };
    this.terrainSrc = new TerrainStack(this.polar, patchData);
    this._dirtyA = this._dirtyB = true; // пересчитать тени с патчем
  }

  setLander(object) {
    if (this.lander) {
      this.models.remove(this.lander);
      this.landerShadow.scene.remove(this.lander.userData.shadowClone);
    }
    this.lander = object;
    const u = this.material.uniforms;
    u.uLanderOn.value = object ? 1 : 0;
    if (!object) return;
    this.models.add(object);
    const shadowClone = object.clone(true);
    object.userData.shadowClone = shadowClone;
    this.landerShadow.scene.add(shadowClone);
  }

  _updateLanderShadow(sunL) {
    const l = this.lander;
    const sc = l.userData.shadowClone;
    sc.position.copy(l.position);
    sc.quaternion.copy(l.quaternion);
    sc.scale.copy(l.scale);
    const cam = this.landerShadow.camera;
    cam.position.copy(l.position).addScaledVector(sunL, 0.6);
    cam.lookAt(l.position);
    cam.updateMatrixWorld();
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.landerShadow.rt);
    r.clear();
    r.render(this.landerShadow.scene, cam);
    r.setRenderTarget(prev);
    const u = this.material.uniforms;
    u.uLanderDepth.value = this.landerShadow.rt.depthTexture;
    u.uLanderMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  /** Повернуть «SolarPanels» модели лицом к Солнцу (вокруг локальной вертикали модуля). */
  aimPanels(object, sunL) {
    aimPanels(object, sunL);
  }

  dispose() {
    this.vis.dispose();
    this.terrain.geometry.dispose();
    this.material.dispose();
    this.heightTex.dispose();
    this.slopeTex.dispose();
    this.landerShadow.rt.dispose();
    this.sky.clearDome();
    this.controls.dispose();
    for (const p of this.pins.values()) this._removePin(p);
  }
}

/**
 * Повернуть солнечные панели модели к Солнцу вокруг вертикали модуля.
 * Поддерживаются пивоты: SolarPanels (наши Blender-модели) и SolarMast (модель CLPS с ригом).
 */
export function aimPanels(object, sunL) {
  const pivot = object?.getObjectByName('SolarPanels') ?? object?.getObjectByName('SolarMast');
  if (!pivot) return;
  const parentQ = pivot.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  const s = sunL.clone().applyQuaternion(parentQ);
  // плоскость панели в модели смотрит вдоль ±Y Blender (= ∓Z в glTF): разворачиваем нормаль к Солнцу
  pivot.rotation.y = Math.atan2(s.x, s.z);
}

function buildTerrainGeometry(polar, tileHalf = polar.half) {
  const n = polar.n;
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const puv = new Float32Array(n * n * 2);
  const d = new THREE.Vector3();
  const L = new THREE.Vector3();
  for (let r = 0; r < n; r++) {
    const y = polar.cy + polar.half - (r + 0.5) * polar.pix;
    for (let c = 0; c < n; c++) {
      const x = polar.cx - polar.half + (c + 0.5) * polar.pix;
      const i = r * n + c;
      PolarData.dirFromMap(x, y, d).multiplyScalar(R_KM + polar.heightsKm[i]);
      PoleFrame.toLocal(d, L);
      pos[i * 3] = L.x;
      pos[i * 3 + 1] = L.y;
      pos[i * 3 + 2] = L.z;
      // uv — в координатах всего тайла (слои, нормали), patchUv — внутри своей сетки (тени патча)
      uv[i * 2] = (x + tileHalf) / (2 * tileHalf);
      uv[i * 2 + 1] = (y + tileHalf) / (2 * tileHalf);
      puv[i * 2] = (c + 0.5) / n;
      puv[i * 2 + 1] = 1 - (r + 0.5) / n;
    }
  }
  const index = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const a = r * n + c;
      const b = a + 1;
      const cc = a + n;
      const dd = cc + 1;
      index[k++] = a;
      index[k++] = cc;
      index[k++] = b;
      index[k++] = b;
      index[k++] = cc;
      index[k++] = dd;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('patchUv', new THREE.BufferAttribute(puv, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function whiteTexture() {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}
function blackTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}
