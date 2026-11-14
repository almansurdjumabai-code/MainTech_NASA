import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createGlobe } from './globe.js';
import { createStarfield } from './starfield.js';
import { createSunSprite } from './sun.js';
import { MarkerLayer } from './markers.js';
import { createEarth } from './earth.js';
import { latLonToVector, vectorToLatLon } from './coords.js';
import { getSubPoints, setEphemerisTable } from './ephemeris.js';
import { GlobeLayers } from './globeLayers.js';
import { Hud } from './hud.js';
import { Fallback2D } from './Fallback2D.js';
import { loadModel, landerForSite } from './models.js';
import { loadPatch, loadPolarData, PolarData, PoleFrame, R_KM, TerrainStack } from './polar/PolarData.js';
const PolarData_latLonToMap = (lat, lon) => PolarData.latLonToMap(lat, lon);
import { PolarView, aimPanels } from './polar/PolarView.js';
import { SphereSiteView } from './surface/SphereSiteView.js';
import { azEl, horizonAt, horizonProfile, siteConditions, siteFrame, EYE_HEIGHT_KM } from './surface/horizon.js';
import { SiteActors } from './surface/siteActors.js';
import { setPointScale } from './effects.js';
import { LanderFx } from './landerFx.js';
import { DescentSim } from './descentSim.js';
import './scene.css';

const LAYERS = ['relief', 'illumination', 'comms', 'slope'];
const CLICK_TOLERANCE_PX = 5;
// Пепельный свет (доля солнечной яркости при «полноземлии»).
// physical — порядок реального значения (~1e-4: ночная сторона практически чёрная),
// enhanced — усилен для читаемости рельефа в тени; HUD об этом сообщает.
const EARTHSHINE = { physical: 1e-4, enhanced: 0.015 };
const LUNAR_DAY_MS = 29.530589 * 86400e3;
const LAYER_SAMPLES = 96;
const EARTH_RADIUS_KM = 6371;
const D2R = Math.PI / 180;

/**
 * Путь Солнца над Астаной (51.17°N, 71.43°E) за UTC-сутки даты — для сравнения «Луна против Земли».
 * Упрощённая солнечная формула (склонение + часовой угол, без рефракции), точность ~0.5°.
 */
function earthCitySunPath(date, lat = 51.17, lon = 71.43) {
  const day0 = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const doy = (day0 - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400e3;
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10)) * D2R;
  const phi = lat * D2R;
  const out = [];
  for (let m = 0; m <= 1440; m += 10) {
    const H = ((m / 60 + lon / 15 - 12) * 15) * D2R; // часовой угол
    const el = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H));
    let az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / D2R + 180;
    if (el > 0) out.push({ az: az % 360, el: el / D2R });
  }
  return out;
}

const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const easeOut = (k) => 1 - (1 - k) ** 3;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Публичный API 3D-сцены для UI (Участник 3).
 *
 *   const moon = new MoonScene(container, { hud: true });
 *   moon.setSites(sites); moon.setDate(date);
 *   moon.on('siteclick', ({id}) => ...); moon.on('surfaceclick', ({lat, lon}) => ...);
 *
 * Режимы: 'globe' → 'polar' (рельеф LOLA, тени по дате) → 'surface' (вид с поверхности).
 */
export class MoonScene {
  constructor(container, options = {}) {
    this.container = container;
    this.options = { hud: true, quality: 'high', autoPolar: true, ...options };
    this.date = new Date();
    this.compareDate = null;
    this.layer = 'relief';
    this.listeners = new Map();
    this.sub = null;
    this.subB = null;
    this.flight = null;
    this.mode = 'globe';
    this.sites = [];
    this.horizonCache = new Map();
    this.layerPeriod = null;
    this.earthshineMode = options.earthshine === 'physical' ? 'physical' : 'enhanced';

    this.hud = new Hud(container, this.options.hud);

    // --- рендер; без WebGL — 2D-запаска ---
    try {
      if (this.options.forceFallback) throw new Error('fallback forced');
      this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    } catch (err) {
      console.warn('[MoonScene] WebGL unavailable, using 2D fallback:', err.message);
      this.fallback = new Fallback2D(container, (e, p) => this._emit(e, p));
      this.hud.setBadge('2D fallback · LOLA');
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);
    container.insertBefore(this.renderer.domElement, this.hud.root);

    // у каждой сцены свой слой подписей: CSS2DRenderer не прячет элементы чужих сцен
    this.labelRenderers = new Map();

    // --- глобус ---
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.001, 2000);
    this.camera.position.set(3.2, 0.6, 0.8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.08;
    this.controls.maxDistance = 12;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;

    const onAssetError = (file) => {
      console.warn(`[MoonScene] asset failed to load: ${file} — using fallback`);
      this._emit('asseterror', { file });
    };
    this.onAssetError = onAssetError;
    this.globe = createGlobe(this.renderer, { onError: onAssetError, quality: this.options.quality });
    this.scene.add(this.globe);
    this.scene.add(createStarfield());

    // Солнце: направленный свет. Атмосферы нет — рассеянного света нет, тени чёрные.
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
    this.scene.add(this.sunLight, this.sunLight.target);
    // Пепельный свет: направленный от Земли, яркость по фазе Земли, видимой с Луны.
    this.earthshine = new THREE.DirectionalLight(0x9db8ff, 0);
    this.scene.add(this.earthshine, this.earthshine.target);
    this.earth = createEarth({ onError: onAssetError });
    this.scene.add(this.earth.mesh);
    this.sunSprite = createSunSprite();
    this.scene.add(this.sunSprite);

    this.globeLayers = new GlobeLayers({ onAssetError });
    this.scene.add(this.globeLayers.mesh);

    this.markers = new MarkerLayer({
      onClusterClick: (sites) => {
        const c = new THREE.Vector3();
        for (const s of sites) c.add(latLonToVector(s.lat, s.lon));
        const { lat, lon } = vectorToLatLon(c);
        this.flyTo({ lat, lon }, { distance: Math.max(1.2, 1 + (this.camera.position.length() - 1) * 0.45) });
      },
    });
    this.scene.add(this.markers.group);
    this._addOrbiter();

    // --- локальные сцены ---
    this.sphereView = new SphereSiteView({ onAssetError });
    this.actors = new SiteActors({ unit: 0.001 });
    this.polarReady = loadPolarData(this.options.quality === 'low' ? 512 : 1024).then((polar) => {
      if (!polar || this.disposed) return null;
      this.polar = polar;
      this.polarView = new PolarView(this.renderer, polar, { onAssetError, quality: this.options.quality });
      this.polarView.earthshineRatio = EARTHSHINE[this.earthshineMode];
      this.polarView.setSites(this.sites);
      this.polarView.select(this.markers.selectedId);
      // профили горизонта, посчитанные до загрузки рельефа, были по гладкой сфере — сбросить
      this.horizonCache.clear();
      if (this.mode === 'surface' && this.surface) this.enterSurfaceView(this.surface.site);
      this._syncDate();
      this._emit('polarready', {});
      return this.polarView;
    });

    this.raycaster = new THREE.Raycaster();
    this._bindInput();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(container);
    this._resize();

    this.hud.setBadge('Globe · LRO LROC + LOLA');
    this.sphereView.earthshineRatio = EARTHSHINE[this.earthshineMode];
    this.setDate(this.date);
    this._last = performance.now();
    this.renderer.setAnimationLoop((t) => this._tick(t));
  }

  // =====================================================================
  // Публичный API (совместим с первой версией + новые методы)
  // =====================================================================

  /** sites: [{id, name, lat, lon, category}] */
  setSites(sites) {
    this.sites = sites.slice();
    if (this.fallback) return this.fallback.setSites(this.sites);
    this.markers.setSites(this.sites);
    this.polarView?.setSites(this.sites);
  }

  addSite(site) {
    this.sites = this.sites.filter((s) => s.id !== site.id).concat(site);
    if (this.fallback) return this.fallback.setSites(this.sites);
    this.markers.add(site);
    this.polarView?.addSite(site);
  }

  removeSite(id) {
    this.sites = this.sites.filter((s) => s.id !== id);
    if (this.fallback) return this.fallback.setSites(this.sites);
    this.markers.remove(id);
    this.polarView?.removeSite(id);
  }

  setDate(date) {
    this.date = new Date(date);
    if (this.fallback) return this.fallback.setDate(this.date);
    const prevSource = this.sub?.source;
    this.sub = getSubPoints(this.date);
    if (this._ephemLoaded && this.sub.source !== prevSource) {
      this._refreshNote();
      if (this.sub.source === 'analytic') this._emit('ephemerisfallback', { date: this.date });
    }
    this._applyGlobeLight(this.sub);
    this.earth.update(this.sub, this.date);
    this._syncDate();
    // слой «% времени» за период от текущей даты — пересчитать после паузы в перемотке
    if (!this.timelapse) {
      clearTimeout(this._layerTimer);
      this._layerTimer = setTimeout(() => this._applyLayerIfPeriodFollowsDate(), 450);
    }
    this._emit('datechange', { date: this.date, ...this.sub });
  }

  /** Дата Scenario B: split-screen A/B (null — выключить). */
  setCompareDate(date) {
    this.compareDate = date ? new Date(date) : null;
    if (this.fallback) return;
    if (this.compareDate) this.compareSite = null;
    this.subB = this.compareDate ? getSubPoints(this.compareDate) : null;
    this._syncDate();
  }

  /**
   * Сравнение двух точек в одну дату (главный сценарий: «соседняя точка»).
   * target: id или {lat, lon} для правой половины; null — выключить. Не сочетается с setCompareDate.
   */
  setCompareSite(target) {
    if (this.fallback) return;
    this.compareSite = target ? this._resolve(target) : null;
    if (this.compareSite) this.compareDate = this.subB = null;
    this._syncDate();
  }

  /** Таблица эфемерид (JPL Horizons): [{t, sunLat, sunLon, earthLat, earthLon, earthDistKm?}] */
  setEphemeris(rows) {
    setEphemerisTable(rows);
    this._ephemLoaded = !!rows?.length;
    this.sub = null; // пересчитать источник и пометку
    this.horizonCache.clear();
    if (this.compareDate) this.subB = getSubPoints(this.compareDate);
    this.setDate(this.date);
    this._refreshNote();
  }

  setLayer(name) {
    if (!LAYERS.includes(name)) throw new Error(`Unknown layer "${name}", expected: ${LAYERS.join(', ')}`);
    this.layer = name;
    if (this.fallback) return;
    this._applyLayer();
  }

  /**
   * Пепельный свет: 'physical' (реальная яркость, тени практически чёрные) или
   * 'enhanced' (усилен ×150 для читаемости; в HUD есть пометка).
   */
  setEarthshine(mode) {
    this.earthshineMode = mode === 'physical' ? 'physical' : 'enhanced';
    if (this.fallback) return;
    const r = EARTHSHINE[this.earthshineMode];
    if (this.polarView) this.polarView.earthshineRatio = r;
    this.sphereView.earthshineRatio = r;
    this._refreshNote();
    this.setDate(this.date);
  }

  /** Пометки HUD: усиление пепельного света, переход на аналитические эфемериды. */
  _refreshNote() {
    const parts = [];
    const fallback = this._ephemLoaded && this.sub?.source === 'analytic';
    if (fallback) parts.push('⚠ Date outside JPL Horizons table — analytic ephemeris (~1–2°)');
    if (this.earthshineMode === 'enhanced') parts.push('Earthshine enhanced ×150 for visibility');
    this.hud.setNote(parts.join(' · ') || null, fallback);
  }

  /** Период для слоёв illumination/comms (по умолчанию — лунные сутки от текущей даты). */
  setLayerPeriod(start, end) {
    this.layerPeriod = start ? [new Date(start), new Date(end)] : null;
    if (this.layer === 'illumination' || this.layer === 'comms') this._applyLayer();
  }

  select(id) {
    if (this.fallback) return this.fallback.select(id);
    this.markers.select(id);
    this.polarView?.select(id);
    this._ensurePatch(id);
    this._updateReadout();
  }

  /** Подгрузить 20-метровый патч для точки (если есть) — детальный рельеф и тени вокруг неё. */
  async _ensurePatch(id) {
    await this.polarReady;
    if (!this.polarView || !id || this._patchId === id) return;
    this._patchId = id;
    const data = await loadPatch(this.polar.meta, id);
    if (this._patchId !== id) return; // пока грузили, выбрали другую точку
    this.polarView.setPatch(data);
    this.horizonCache.clear();
    if (data && this.mode === 'surface' && this.surface) this._rebuildSurface({ keepView: true });
    this._updateReadout();
  }

  /**
   * target: id точки или {lat, lon}.
   * options.landing — симуляция посадки (пролёт → снижение → касание → вид с поверхности).
   */
  flyTo(target, options = {}) {
    if (this.fallback) return;
    const site = this._resolve(target);
    if (!site) return;
    if (options.landing) return this._land(site);
    if (this.mode !== 'globe') {
      if (this.mode === 'polar' && this.polar?.containsLatLon(site.lat, site.lon)) {
        this._flyPolar(site, options.altitude ?? 40);
        return;
      }
      this.setView('globe');
    }
    const { duration = 1600, distance } = options;
    const fromDir = this.camera.position.clone().normalize();
    const toDir = latLonToVector(site.lat, site.lon).normalize();
    this.flight = {
      start: performance.now(),
      duration,
      fromQ: new THREE.Quaternion(),
      toQ: new THREE.Quaternion().setFromUnitVectors(fromDir, toDir),
      fromDir,
      fromDist: this.camera.position.length(),
      toDist: distance ?? Math.min(this.camera.position.length(), 2.2),
    };
  }

  getState() {
    return {
      date: this.date,
      layer: this.layer,
      compareDate: this.compareDate,
      mode: this.mode,
      ...this.sub,
    };
  }

  /** 'globe' | 'polar'. Возвращает Promise<boolean>. */
  async setView(mode, { lat = -89.4, lon = 0, altitude = 260 } = {}) {
    if (this.fallback) return false;
    if (mode === 'polar') {
      await this.polarReady;
      if (!this.polarView) {
        this.hud.setCaption('Detailed South Pole terrain is unavailable');
        setTimeout(() => this.hud.setCaption(null), 2500);
        return false;
      }
    }
    if (mode === this.mode && mode !== 'surface') return true;
    await this.hud.fadeThrough(() => {
      this._leaveSurface();
      this.mode = mode;
      this.controls.enabled = mode === 'globe';
      if (this.polarView) this.polarView.controls.enabled = mode === 'polar';
      if (mode === 'polar') {
        this.polarView.lookAtSite(lat, lon, altitude);
        this.hud.setBadge('Polar view · LOLA LDEM 80 m → 391 m/px · shadows by date');
      } else {
        // смотрим на Южный полюс с орбиты
        this.camera.position.copy(latLonToVector(-62, lon, 2.0));
        this.hud.setBadge('Globe · LRO LROC + LOLA');
      }
      this._applyLayer();
    });
    this._emit('viewchange', { mode: this.mode });
    return true;
  }

  getView() {
    return this.mode;
  }

  /** Вид с поверхности (этап 5): камера на высоте 2 м, купол неба, профиль горизонта. */
  async enterSurfaceView(target, { standoffM = 0, yawDeg } = {}) {
    if (this.fallback) return;
    const site = this._resolve(target);
    if (!site) return;
    await this.polarReady;
    const polarProvider = !!this.polarView && this.polar.containsLatLon(site.lat, site.lon);
    if (polarProvider && site.id) await this._ensurePatch(site.id);
    await this.hud.fadeThrough(() => {
      this._leaveSurface();
      this.mode = 'surface';
      this.controls.enabled = false;
      if (this.polarView) this.polarView.controls.enabled = false;
      this.surface = { site: { ...site }, polar: polarProvider, standoffM, yaw: 0, pitch: 2 };
      if (this.polarView) this.polarView.material.uniforms.uGrid.value = 0;
      if (!polarProvider) this.sphereView.setSite(site.lat, site.lon);
      const sky = polarProvider ? this.polarView.sky : this.sphereView.sky;
      sky.flareEnabled = true;
      this._rebuildSurface({ yawDeg });
      this.hud.setBadge(
        polarProvider ? `Surface · ${site.name ?? 'site'} · LOLA horizon` : `Surface · ${site.name ?? 'site'} · smooth-sphere horizon`,
      );
      this.hud.setHint('Drag to look · scroll to zoom · arrows: move 250 m · Esc: exit');
    });
    this._emit('viewchange', { mode: 'surface', site });
  }

  exitSurfaceView() {
    if (this.mode !== 'surface') return;
    const back = this.surface?.polar ? 'polar' : 'globe';
    const s = this.surface.site;
    this.setView(back, { lat: s.lat, lon: s.lon, altitude: 40 });
  }

  /** «Сдвинь на 1 км»: смещение точки наблюдения (км на восток / север). */
  moveSurfacePoint(dEastKm, dNorthKm) {
    if (this.mode !== 'surface') return;
    const s = this.surface.site;
    const P = latLonToVector(s.lat, s.lon, R_KM);
    const f = siteFrame(P);
    P.addScaledVector(f.east, dEastKm).addScaledVector(f.north, dNorthKm);
    const { lat, lon } = vectorToLatLon(P);
    Object.assign(s, { lat, lon });
    if (s.id) this._moveSite(s.id, lat, lon);
    this._rebuildSurface({ keepView: true });
  }

  /** Условия в точке на дату: Солнце/Земля над горизонтом рельефа. */
  getSiteConditions(target, date = this.date) {
    const site = this._resolve(target);
    if (!site) return null;
    const { profile, frame, eye } = this._horizonFor(site.lat, site.lon);
    const sub = getSubPoints(new Date(date));
    const sunDir = latLonToVector(sub.sunLat, sub.sunLon);
    const earthPos = latLonToVector(sub.earthLat, sub.earthLon, sub.earthDistKm);
    const earthR = Math.asin(EARTH_RADIUS_KM / sub.earthDistKm) / D2R;
    return { ...siteConditions(profile, frame, eye, sunDir, earthPos, earthR), horizonRangeKm: profile.maxRangeKm, date: new Date(date) };
  }

  /** Профиль горизонта [{az, el}] в точке. */
  getHorizonProfile(target) {
    const site = this._resolve(target);
    if (!site) return null;
    const { profile } = this._horizonFor(site.lat, site.lon);
    return Array.from(profile.el, (el, i) => ({ az: i * profile.stepDeg, el }));
  }

  /** Тайм-лапс: spanDays суток за durationSec секунд (по умолчанию — лунные сутки за 20 с). */
  playTimelapse({ spanDays = 29.53, durationSec = 20, loop = false } = {}) {
    if (this.fallback) return;
    this.timelapse = {
      start: this.date.getTime(),
      spanMs: spanDays * 86400e3,
      durMs: durationSec * 1000,
      t0: performance.now(),
      loop,
      compareOffset: this.compareDate ? this.compareDate - this.date : 0,
    };
    if (this.layer === 'illumination' || this.layer === 'comms') {
      this.hud.setLegend(this.layer, { note: 'frozen during time-lapse — recomputed when it stops', source: 'LOLA + JPL Horizons' });
    }
    this._emit('timelapse', { playing: true });
  }

  stopTimelapse() {
    if (!this.timelapse) return;
    this.timelapse = null;
    this._applyLayerIfPeriodFollowsDate();
    this._emit('timelapse', { playing: false });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.listeners.get(event)?.delete(fn);
  }

  dispose() {
    this.disposed = true;
    this.hud.dispose();
    if (this.fallback) return this.fallback.dispose();
    this.renderer.setAnimationLoop(null);
    this._resizeObserver.disconnect();
    window.removeEventListener('keydown', this._onKey);
    this.controls.dispose();
    this.markers.dispose();
    this.globeLayers.dispose();
    this.actors.dispose();
    this.surface?.lander?.userData.fx?.dispose();
    this.polarView?.dispose();
    this.sphereView.sky?.clearDome();
    for (const scene of [this.scene, this.polarView?.scene, this.sphereView.scene]) {
      scene?.traverse((o) => {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
          m.dispose();
        }
      });
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
    for (const lr of this.labelRenderers.values()) lr.domElement.remove();
  }

  // =====================================================================
  // Внутреннее
  // =====================================================================

  _emit(event, payload) {
    for (const fn of this.listeners.get(event) ?? []) fn(payload);
  }

  _resolve(target) {
    if (typeof target === 'string') return this.sites.find((s) => s.id === target) ?? null;
    if (target && Number.isFinite(target.lat)) return { name: 'Custom site', ...target };
    return null;
  }

  _applyGlobeLight(sub) {
    const dir = latLonToVector(sub.sunLat, sub.sunLon);
    this.sunLight.position.copy(dir).multiplyScalar(10);
    this.sunSprite.position.copy(dir).multiplyScalar(300);
    latLonToVector(sub.earthLat, sub.earthLon, 10, this.earthshine.position);
    const ratio = EARTHSHINE[this.earthshineMode];
    this.earthshine.intensity = this.sunLight.intensity * ratio * sub.earthPhase;
    this.globe.userData.setLighting?.({ sunDir: dir, earthDir: this.earthshine.position, earthshine: 2.9 * ratio * sub.earthPhase });
  }

  _syncDate() {
    if (this.polarView && this.sub) {
      this.polarView.setSubPoints('A', this.sub, this.date);
      if (this.subB) this.polarView.setSubPoints('B', this.subB, this.compareDate);
    }
    if (this.mode === 'surface') this._updateSurfaceSky();
    this._updateReadout();
    if (this.compareSite) {
      const a = this._resolve(this.markers.selectedId);
      const fmt = (s) => {
        if (!s) return '';
        const c = this.getSiteConditions(s);
        return `${c.sunVisibleFraction > 0.001 ? `☀ ${c.sunEl >= 0 ? '+' : ''}${c.sunEl.toFixed(2)}°` : '☀ hidden'} · ${c.earthVisibleFraction > 0.001 ? '🌍 link' : '🌍 no link'}`;
      };
      this.hud.setScenarios(this.date, this.date, fmt(a), fmt(this.compareSite), a?.name ?? 'Selected site', this.compareSite.name ?? 'Site B');
    } else {
      this.hud.setScenarios(this.date, this.compareDate, ...this._scenarioExtras());
    }
  }

  _scenarioExtras() {
    const id = this.markers?.selectedId;
    const site = this.mode === 'surface' ? this.surface?.site : id && this._resolve(id);
    if (!this.compareDate || !site) return ['', ''];
    const fmt = (c) =>
      `${site.name ?? 'Site'}: ${c.sunVisibleFraction > 0.001 ? `☀ ${c.sunEl >= 0 ? '+' : ''}${c.sunEl.toFixed(2)}°` : '☀ hidden'} · ${
        c.earthVisibleFraction > 0.001 ? '🌍 link' : '🌍 no link'
      }`;
    return [fmt(this.getSiteConditions(site, this.date)), fmt(this.getSiteConditions(site, this.compareDate))];
  }

  _updateReadout() {
    if (!this.hud) return;
    let site = null;
    if (this.mode === 'surface') site = this.surface?.site;
    else if (this.mode === 'polar' && this.markers.selectedId) site = this._resolve(this.markers.selectedId);
    if (!site || this.compareDate || this.compareSite) return this.hud.setReadout(null);
    this.hud.setReadout(this.getSiteConditions(site));
  }

  _horizonFor(lat, lon) {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    let h = this.horizonCache.get(key);
    if (!h) {
      const inPolar = this.polar?.containsLatLon(lat, lon);
      // те же высоты, что и у теней: 20-метровый патч точки (если загружен) поверх 2048²
      const base = this.polar?.detail ?? this.polar;
      const p = this.polarView?.patch?.data;
      const terrain = p && base && p.inside(...Object.values(PolarData_latLonToMap(lat, lon)), 0.5) ? new TerrainStack(base, p) : base;
      const P = inPolar ? terrain.moonPosLatLon(lat, lon, new THREE.Vector3()) : latLonToVector(lat, lon, R_KM);
      const frame = siteFrame(P);
      const profile = horizonProfile(inPolar ? terrain : null, P, frame);
      const eye = P.clone().addScaledVector(frame.up, EYE_HEIGHT_KM);
      h = { profile, frame, eye, P };
      if (this.horizonCache.size > 64) this.horizonCache.clear();
      this.horizonCache.set(key, h);
    }
    return h;
  }

  _periodSubs() {
    const [start, end] = this.layerPeriod ?? [this.date, new Date(this.date.getTime() + LUNAR_DAY_MS)];
    const subs = [];
    for (let i = 0; i < LAYER_SAMPLES; i++) {
      subs.push(getSubPoints(new Date(start.getTime() + ((i + 0.5) / LAYER_SAMPLES) * (end - start))));
    }
    return { subs, key: `${start.toISOString()}|${end.toISOString()}`, start, end };
  }

  _applyLayerIfPeriodFollowsDate() {
    if (!this.layerPeriod && (this.layer === 'illumination' || this.layer === 'comms')) this._applyLayer();
  }

  async _applyLayer() {
    const layer = this.layer;
    const view = this.mode === 'globe' ? 'globe' : 'polar';
    const timed = layer === 'illumination' || layer === 'comms';
    const period = timed ? this._periodSubs() : null;
    const periodText = period ? `${period.start.toISOString().slice(0, 10)} → ${period.end.toISOString().slice(0, 10)}` : '';

    if (view === 'globe' || !this.polarView) {
      this.polarView?.setLayer('relief');
      if (timed) this.globeLayers.compute(layer, period.subs, period.key);
      this.globeLayers.set(layer);
      this.hud.setLegend(layer, {
        note: timed ? `smooth sphere, terrain not modeled · ${periodText}` : layer === 'slope' ? 'LOLA LDEM 16 ppd (~1.9 km baseline)' : undefined,
        source: timed ? 'JPL Horizons' : 'NASA LOLA',
      });
      this._emit('layerready', { layer, view: 'globe' });
      return;
    }

    this.globeLayers.set('relief');
    if (!timed) {
      this.polarView.setLayer(layer);
      this.hud.setLegend(
        layer,
        layer === 'slope'
          ? { note: 'mean of 80 m slopes within each 391 m cell (crater walls dominate) · Artemis limit < 10° over 100 m', source: 'LOLA LDEM_80S_80M' }
          : {},
      );
      this._emit('layerready', { layer, view: 'polar' });
      return;
    }
    const key = `${layer}|${period.key}`;
    this.polarView.setLayer('relief');
    if (this._layerKey === key && this._layerTex) {
      this.polarView.setLayer(layer, this._layerTex);
    } else {
      const token = (this._layerToken = Symbol(layer));
      const t0 = performance.now();
      this.hud.setLegend(layer, { note: `computing on GPU · ${LAYER_SAMPLES} positions`, source: 'LOLA + JPL Horizons' });
      const tex = await this.polarView.accumulate(layer, period.subs, {
        onProgress: (p) => {
          this.hud.setProgress(p);
          this._emit('layerprogress', { layer, progress: p });
        },
        isCancelled: () => this._layerToken !== token || this.layer !== layer,
      });
      if (!tex) return;
      this._layerKey = key;
      this._layerTex = tex;
      this.polarView.setLayer(layer, tex);
      this.lastLayerMs = performance.now() - t0;
    }
    this.hud.setProgress(null);
    this.hud.setLegend(layer, {
      note: `LOLA terrain raymarch, ${LAYER_SAMPLES} ${layer === 'comms' ? 'Earth' : 'Sun'} positions · ${periodText}`,
      source: 'LOLA + JPL Horizons',
    });
    this._emit('layerready', { layer, view: 'polar' });
  }

  _moveSite(id, lat, lon) {
    const s = this.sites.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, { lat, lon });
    this.markers.add(s);
    this.polarView?.addSite(s);
    this.markers.select(this.markers.selectedId);
    this.polarView?.select(this.markers.selectedId);
    this._emit('sitemove', { id, lat, lon });
  }

  // ---------- орбитальный аппарат LRO на глобусе ----------

  async _addOrbiter() {
    const lro = await loadModel('lro');
    if (!lro || this.disposed) return;
    const pivot = new THREE.Group();
    pivot.rotation.z = 0.1;
    const holder = new THREE.Group();
    holder.position.set(0, 0, 1.06); // условная высота: реальная ~50 км = 1.03 R
    lro.scale.setScalar(0.0016); // условно увеличен, иначе не виден
    holder.add(lro);
    const el = document.createElement('div');
    el.className = 'moon-label lro-label';
    el.textContent = 'LRO';
    const label = new CSS2DObject(el);
    label.center.set(-0.2, 0.5);
    holder.add(label);
    pivot.add(holder);
    this.scene.add(pivot);
    this.orbiter = { pivot, holder, lro };
  }

  // ---------- вид с поверхности ----------

  _rebuildSurface({ keepView = false, yawDeg } = {}) {
    const s = this.surface;
    const { profile, frame, eye, P } = this._horizonFor(s.site.lat, s.site.lon);
    s.profile = profile;
    s.frame = frame;
    s.eyeMoon = eye;
    s.P = P;

    // начальный взгляд — на Солнце
    if (!keepView) {
      const sunDir = latLonToVector(this.sub.sunLat, this.sub.sunLon);
      s.yaw = yawDeg ?? azEl(frame, sunDir).az;
      s.pitch = 2;
    }

    // купол: пути Солнца и Земли за лунные сутки с шагом 2 ч
    const paths = { sun: [], earth: [] };
    const steps = Math.round(LUNAR_DAY_MS / 7200e3);
    for (let k = 0; k <= steps; k++) {
      const t = new Date(this.date.getTime() + k * 7200e3);
      const sub = getSubPoints(t);
      const sa = azEl(frame, latLonToVector(sub.sunLat, sub.sunLon));
      const ea = azEl(frame, latLonToVector(sub.earthLat, sub.earthLon, sub.earthDistKm).sub(eye));
      const day = (k * 2) / 24;
      const above = sa.el > horizonAt(profile, sa.az);
      paths.sun.push({ ...sa, label: k > 0 && day % 3 === 0 && above ? `+${day}d` : null });
      paths.earth.push(ea);
    }
    paths.earthCity = earthCitySunPath(this.date);
    const sky = s.polar ? this.polarView.sky : this.sphereView.sky;
    sky.buildDome(frame, profile, paths);

    // модели: модуль (если садились) и астронавт рядом для масштаба
    this._placeSurfaceModels();
    this._updateSurfaceSky();
    this._updateReadout();
    this._emit('horizonchange', {
      site: s.site,
      terrainModeled: profile.terrainModeled,
      profile: Array.from(profile.el, (el, i) => ({ az: i * profile.stepDeg, el })),
    });
  }

  async _placeSurfaceModels() {
    const s = this.surface;
    const lander = s.lander ?? null;
    if (s.polar) {
      if (lander && !this.polarView.lander) this.polarView.setLander(lander);
      if (lander) this.polarView.placeOnSurface(lander, s.site.lat, s.site.lon);
    } else {
      this.sphereView.placeModel(lander);
    }
    // астронавт и флаг рядом с модулем (группа в метрах)
    const g = this.actors.group;
    g.removeFromParent();
    if (!lander) return;
    if (s.polar) {
      this.polarView.placeOnSurface(g, s.site.lat, s.site.lon);
      this.polarView.scene.add(g);
    } else {
      g.position.set(0, 0, 0);
      g.quaternion.identity();
      g.scale.setScalar(0.001);
      this.sphereView.scene.add(g);
    }
  }

  _surfaceCameraBasis() {
    const s = this.surface;
    if (s.polar) {
      const toL = (v) => PoleFrame.dirToLocal(v, new THREE.Vector3());
      return { up: toL(s.frame.up), east: toL(s.frame.east), north: toL(s.frame.north) };
    }
    return { up: new THREE.Vector3(0, 1, 0), east: new THREE.Vector3(1, 0, 0), north: new THREE.Vector3(0, 0, -1) };
  }

  _updateSurfaceCamera() {
    const s = this.surface;
    const cam = s.polar ? this.polarView.camera : this.sphereView.camera;
    const b = this._surfaceCameraBasis();
    const yaw = s.yaw * D2R;
    const pitch = s.pitch * D2R;
    const fwd = b.north
      .clone()
      .multiplyScalar(Math.cos(yaw) * Math.cos(pitch))
      .addScaledVector(b.east, Math.sin(yaw) * Math.cos(pitch))
      .addScaledVector(b.up, Math.sin(pitch));
    const base = s.polar
      ? this.polarView.localSurface(s.site.lat, s.site.lon, EYE_HEIGHT_KM)
      : b.up.clone().multiplyScalar(EYE_HEIGHT_KM);
    // со стоянием у модуля: отходим назад от направления взгляда
    const flat = fwd.clone().addScaledVector(b.up, -fwd.dot(b.up)).normalize();
    cam.position.copy(base).addScaledVector(flat, -(s.standoffM ?? 0) / 1000);
    cam.up.copy(b.up);
    cam.fov = s.fov ?? 60;
    cam.lookAt(cam.position.clone().add(fwd));
    cam.near = 0.0008;
    cam.far = 30000;
    cam.updateProjectionMatrix();
  }

  _updateSurfaceSky() {
    const s = this.surface;
    if (!s) return;
    const sky = s.polar ? this.polarView.sky : this.sphereView.sky;
    if (sky) sky.sunVisibility = this.getSiteConditions(s.site)?.sunVisibleFraction ?? 1;
    this._updateSurfaceCamera();
    if (!s.polar) {
      const { sunL } = this.sphereView.applyState(this.sub, this.date);
      if (s.lander) aimPanels(s.lander, sunL);
    } else if (s.lander) {
      aimPanels(s.lander, this.polarView.material.uniforms.uSunL.value);
    }
  }

  _leaveSurface() {
    if (!this.surface) return;
    this.polarView?.sky.clearDome();
    if (this.polarView) this.polarView.material.uniforms.uGrid.value = 1;
    if (this.polarView) this.polarView.sky.flareEnabled = false;
    this.sphereView.sky?.clearDome();
    this.polarView?.setLander(null);
    this.sphereView.placeModel(null);
    this.actors.group.removeFromParent();
    this.surface = null;
    this.hud.setHint(null);
    this.hud.setReadout(null);
  }

  // ---------- полёты и посадка ----------

  _flyPolar(site, altKm) {
    const pv = this.polarView;
    const target = pv.localSurface(site.lat, site.lon);
    const from = { pos: pv.camera.position.clone(), target: pv.controls.target.clone() };
    const back = target.clone().setY(0).normalize();
    if (back.lengthSq() < 0.5) back.set(0, 0, 1);
    const toPos = target.clone().addScaledVector(back, altKm * 0.8).add(new THREE.Vector3(0, altKm, 0));
    this.polarFlight = { t0: performance.now(), dur: 1800, from, to: { pos: toPos, target } };
  }

  async _land(site) {
    this._emit('landingstart', { id: site.id ?? null });
    this.stopTimelapse();
    const modelName = landerForSite(site);
    const lander = await loadModel(modelName);
    await this.polarReady;
    const inPolar = !!this.polarView && this.polar.containsLatLon(site.lat, site.lon);

    if (!inPolar) {
      // деградация: обычный пролёт и вид с поверхности на гладкой сфере
      if (this.mode !== 'globe') await this.setView('globe');
      this.flyTo(site.id ?? site, { duration: 1800, distance: 1.15 });
      this.hud.setCaption(`Approach · ${site.name ?? 'site'} (detailed terrain only near the South Pole)`);
      await wait(1900);
      await this.enterSurfaceView(site, { standoffM: lander ? 28 : 0 });
      if (lander && this.surface) {
        this.surface.lander = lander;
        this._placeSurfaceModels();
        this._updateSurfaceSky();
      }
      this.hud.setCaption(`Touchdown · ${site.name ?? 'site'}`);
      setTimeout(() => this.hud.setCaption(null), 3000);
      this._emit('landingend', { id: site.id ?? null });
      return;
    }

    if (this.mode === 'globe') {
      this.flyTo(site.id ?? site, { duration: 1500, distance: 1.25 });
      await wait(1550);
    }
    if (this.mode === 'surface') this._leaveSurface();
    await this.setView('polar', { lat: site.lat, lon: site.lon, altitude: 4 });
    const pv = this.polarView;
    pv.controls.enabled = false;
    if (lander) {
      pv.setLander(lander);
      this._attachPlume(lander);
      this.actors.restart();
      pv.placeOnSurface(this.actors.group, site.lat, site.lon);
      pv.scene.add(this.actors.group);
      this.actors.group.visible = true;
      lander.userData.fx = new LanderFx(lander, { unit: 0.001 });
      lander.userData.legs = [];
      lander.traverse((o) => o.name.startsWith('LegHinge_') && lander.userData.legs.push({ o, q: o.quaternion.clone() }));
    }
    // --- физическая посадка: симуляция в системе точки (м), сцена — в км полюса ---
    const src = pv.terrainSrc;
    const P0 = src.surfacePosLatLon(site.lat, site.lon, new THREE.Vector3());
    const frame = siteFrame(P0);
    const h0 = P0.length() - R_KM;
    // подлёт так, чтобы Солнце светило сбоку: модуль и его длинная тень в кадре камеры сопровождения
    const sunAz = azEl(frame, latLonToVector(this.sub.sunLat, this.sub.sunLon)).az * D2R;
    const head = sunAz + Math.PI / 2;
    const approachDir = [Math.sin(head), Math.cos(head)];
    const toMoon = (x, y, z, out = new THREE.Vector3()) =>
      out.copy(P0).addScaledVector(frame.east, x / 1000).addScaledVector(frame.north, y / 1000).addScaledVector(frame.up, z / 1000);
    const groundZ = (x, y) => {
      // высота рельефа под (x, y) относительно точки, с учётом кривизны (м)
      const q = toMoon(x, y, 0).normalize();
      const m = PolarData.mapFromDir(q);
      return (src.heightKm(m.x, m.y) - h0) * 1000 - (x * x + y * y) / (2 * R_KM * 1000);
    };
    const dirL = (x, y, z) => PoleFrame.dirToLocal(new THREE.Vector3().addScaledVector(frame.east, x).addScaledVector(frame.north, y).addScaledVector(frame.up, z).normalize(), new THREE.Vector3());
    this.landing = {
      sim: new DescentSim({ approachDir }),
      groundZ,
      toMoon,
      dirL,
      site,
      lander,
      upL: dirL(0, 0, 1),
      approachL: dirL(approachDir[0], approachDir[1], 0),
      sideL: dirL(approachDir[1], -approachDir[0], 0),
      timeScale: 4,
      landedAt: null,
      quat: new THREE.Quaternion(),
      camTarget: null,
      plume: this._plume,
    };
    await new Promise((resolve) => (this.landing.resolve = resolve));
    const l = this.landing;
    this.landing = null;
    this.polarView.camera.fov = 45;
    this._detachPlume();
    this.polarView.material.uniforms.uPlumeI.value = 0;
    await this.enterSurfaceView(site, { standoffM: lander ? 24 : 0 });
    if (lander && this.surface) {
      this.surface.lander = lander;
      this._placeSurfaceModels();
      this._updateSurfaceSky();
    }
    const v = l.sim.touchdownSpeed;
    this.hud.setCaption(`Touchdown · ${site.name ?? 'site'}${v != null ? ` · ${v.toFixed(1)} m/s` : ''}`);
    setTimeout(() => this.hud.setCaption(null), 3500);
    this._emit('landingend', { id: l.site.id ?? null, touchdownSpeed: v, durationSec: l.sim.t });
  }

  _stepLanding(now) {
    const L = this.landing;
    const pv = this.polarView;
    const dtReal = this._dt ?? 1 / 60;
    // ускорение времени: подход ×4, вертикальный спуск ×2, касание — реальное время
    const scale = L.sim.phase === 'APPROACH' ? L.timeScale : L.sim.phase === 'VERTICAL' ? Math.min(L.timeScale, 2) : Math.min(L.timeScale, 1);
    let s = L.sim.state(L.groundZ);
    const steps = Math.ceil((dtReal * scale) / (1 / 120));
    for (let i = 0; i < steps && s.phase !== 'LANDED'; i++) s = L.sim.step((dtReal * scale) / steps, L.groundZ);
    if (s.phase === 'LANDED' && L.landedAt == null) L.landedAt = now;

    const names = { APPROACH: 'Approach · braking (P64)', VERTICAL: 'Vertical descent (P66)', CONTACT: 'CONTACT LIGHT · engine stop', LANDED: 'Touchdown' };
    const f1 = (x) => (Math.abs(x) < 10 ? x.toFixed(1) : Math.round(x));
    this.hud.setCaption(
      `${names[s.phase]} · ALT ${f1(Math.max(s.alt, 0))} m · V/S ${f1(s.vs)} m/s · H/S ${f1(s.hs)} m/s · THR ${Math.round(s.throttle * 100)}% · ×${scale}`,
    );

    const landerMoon = L.toMoon(s.pos[0], s.pos[1], s.pos[2]);
    const landerL = PoleFrame.toLocal(landerMoon, new THREE.Vector3());
    if (L.lander) {
      // ориентация: ось модуля по вектору тяги (наклон назад при торможении); после выключения — по нормали
      const T = s.thrust;
      const axis = s.phase === 'APPROACH' || s.phase === 'VERTICAL' ? L.dirL(T[0], T[1], T[2]) : L.upL.clone();
      const target = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      const before = L.quat.clone();
      L.quat.slerp(target, 1 - Math.exp(-dtReal * scale * 2.5)); // ограниченная скорость разворота
      L.lander.position.copy(landerL);
      L.lander.quaternion.copy(L.quat);
      L.lander.scale.setScalar(0.001);
      aimPanels(L.lander, pv.material.uniforms.uSunL.value);
      // двигатели ориентации работают, когда модуль доворачивает
      const turning = before.angleTo(L.quat) / Math.max(dtReal, 1e-3);
      L.lander.userData.fx?.update(now / 1000, dtReal, { rcsRate: turning > 0.05 ? 8 : 0 });
      // опоры раскрываются на ~500 м
      const unfold = 1 - THREE.MathUtils.smoothstep(s.alt, 300, 600);
      for (const { o, q } of L.lander.userData.legs ?? []) {
        o.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (1 - unfold) * -1.1));
      }
      // факел и пыль — от реальной тяги
      const firing = s.phase === 'APPROACH' || s.phase === 'VERTICAL';
      if (L.plume) {
        L.plume.material.opacity = firing ? (0.25 + 0.55 * s.throttle) * (0.9 + 0.1 * Math.sin(now * 0.05)) : 0;
        L.plume.scale.y = 0.6 + 0.9 * s.throttle;
      }
      if (firing) this.actors.engineBlast(s.alt, s.throttle);
      const u = pv.material.uniforms;
      u.uPlumePos.value.copy(PoleFrame.toLocal(L.toMoon(s.pos[0], s.pos[1], L.groundZ(s.pos[0], s.pos[1]) + 1), new THREE.Vector3()));
      u.uPlumeI.value = firing ? THREE.MathUtils.clamp(1 - s.alt / 60, 0, 1) * s.throttle : 0;
    }

    // камера сопровождения: сзади-сбоку, дистанция и высота уменьшаются с высотой, у грунта — низкий ракурс
    const km = (m) => m / 1000;
    // телеобъектив и плотное сопровождение: модуль крупно, рельеф и тень видны
    const dist = km(THREE.MathUtils.clamp(30 + s.alt * 0.085, 30, 140));
    const height = km(THREE.MathUtils.clamp(3 + s.alt * 0.035, 3, 50));
    const side = km(THREE.MathUtils.clamp(12 + s.alt * 0.04, 12, 60));
    const goal = landerL.clone().addScaledVector(L.approachL, -dist).addScaledVector(L.sideL, side).addScaledVector(L.upL, height);
    if (!L.camInit) {
      L.camInit = true;
      pv.camera.position.copy(goal); // старт сразу за модулем
      pv.camera.fov = 32;
    }
    const k = 1 - Math.exp(-dtReal * 2.2); // пружина-демпфер: плавно догоняет, без рывков
    pv.camera.position.lerp(goal, k);
    // не уходим под рельеф
    const camMoon = PoleFrame.fromLocal(pv.camera.position, new THREE.Vector3());
    const mm = PolarData.mapFromDir(camMoon.clone().normalize());
    const minR = R_KM + pv.terrainSrc.heightKm(mm.x, mm.y) + km(1.5);
    if (camMoon.length() < minR) pv.camera.position.copy(PoleFrame.toLocal(camMoon.setLength(minR), new THREE.Vector3()));
    const look = landerL.clone().addScaledVector(L.upL, km(3));
    L.camTarget = L.camTarget ? L.camTarget.lerp(look, 1 - Math.exp(-dtReal * 6)) : look;
    pv.camera.up.copy(L.upL);
    pv.camera.lookAt(L.camTarget);
    if (L.landedAt != null && now - L.landedAt > 2200) L.resolve();
  }

  _attachPlume(lander) {
    const geo = new THREE.ConeGeometry(1.1, 7, 24, 1, true).translate(0, -3.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffc27a,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const plume = new THREE.Mesh(geo, mat);
    const nozzle = lander.getObjectByName('Nozzle_Main') ?? lander.getObjectByName('Engine') ?? lander;
    plume.position.set(0, nozzle === lander ? 0.6 : 0, 0);
    nozzle.add(plume);
    this._plume = plume;
  }

  _detachPlume() {
    if (!this._plume) return;
    this._plume.parent?.remove(this._plume);
    this._plume.geometry.dispose();
    this._plume.material.dispose();
    this._plume = null;
  }

  // ---------- ввод ----------

  _bindInput() {
    const el = this.renderer.domElement;
    let down = null;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (this.landing) {
        this.landing.timeScale = 30; // клик ускоряет посадку (физика та же, время быстрее)
        return;
      }
      down = { x: e.clientX, y: e.clientY, yaw: this.surface?.yaw, pitch: this.surface?.pitch };
      if (this.mode === 'polar') {
        const hit = this._raycast(e, this.polarView.camera).intersectObjects(this.polarView.pickables(), false)[0];
        const site = hit && this.sites.find((s) => s.id === hit.object.userData.siteId);
        if (site?.category === 'custom') {
          drag = site;
          this.polarView.controls.enabled = false;
        }
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!down) return;
      if (this.mode === 'surface') {
        const s = this.surface;
        const k = (s.fov ?? 60) / el.clientHeight;
        s.yaw = down.yaw - (e.clientX - down.x) * k;
        s.pitch = THREE.MathUtils.clamp(down.pitch + (e.clientY - down.y) * k, -30, 85);
        this._updateSurfaceSky();
      } else if (drag) {
        // «Сдвинь на 1 км»: тащим свою точку по рельефу, условия пересчитываются вживую
        const hit = this.polarView.pickTerrain(this._raycast(e, this.polarView.camera));
        if (hit) {
          this._moveSite(drag.id, hit.lat, hit.lon);
          this._updateReadout();
        }
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (drag) {
        drag = null;
        this.polarView.controls.enabled = true;
        return;
      }
      if (moved > CLICK_TOLERANCE_PX || this.mode === 'surface') return;
      this._pick(e);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'surface') return;
        e.preventDefault();
        const s = this.surface;
        s.fov = THREE.MathUtils.clamp((s.fov ?? 60) * (e.deltaY > 0 ? 1.1 : 0.9), 4, 80);
        this._updateSurfaceSky();
      },
      { passive: false },
    );
    this._onKey = (e) => {
      if (this.mode !== 'surface' || e.target.closest?.('input, textarea, select')) return;
      const step = 0.25;
      if (e.key === 'Escape') this.exitSurfaceView();
      else if (e.key === 'ArrowUp') this.moveSurfacePoint(0, step);
      else if (e.key === 'ArrowDown') this.moveSurfacePoint(0, -step);
      else if (e.key === 'ArrowRight') this.moveSurfacePoint(step, 0);
      else if (e.key === 'ArrowLeft') this.moveSurfacePoint(-step, 0);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', this._onKey);
  }

  _raycast(e, camera) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    if (this.compareDate) ndc.x = ndc.x < 0 ? ndc.x * 2 + 1 : ndc.x * 2 - 1; // половинки split-screen
    this.raycaster.setFromCamera(ndc, camera);
    return this.raycaster;
  }

  _pick(e) {
    if (this.mode === 'polar') {
      const rc = this._raycast(e, this.polarView.camera);
      const hit = rc.intersectObjects(this.polarView.pickables(), false)[0];
      if (hit) {
        const id = hit.object.userData.siteId;
        this.select(id);
        this._emit('siteclick', { id });
        return;
      }
      const t = this.polarView.pickTerrain(rc);
      if (t) this._emit('surfaceclick', { lat: t.lat, lon: t.lon });
      return;
    }
    const rc = this._raycast(e, this.camera);
    const siteHit = rc.intersectObjects(this.markers.pickables(), false)[0];
    if (siteHit) {
      const id = siteHit.object.userData.siteId;
      this.select(id);
      this._emit('siteclick', { id });
      return;
    }
    const surfaceHit = rc.intersectObject(this.globe, false)[0];
    if (surfaceHit) this._emit('surfaceclick', vectorToLatLon(surfaceHit.point));
  }

  _labelsFor(scene) {
    let lr = this.labelRenderers.get(scene);
    if (!lr) {
      lr = new CSS2DRenderer();
      lr.domElement.className = 'moon-labels';
      this.container.insertBefore(lr.domElement, this.hud.root);
      if (this.size) lr.setSize(this.size.w, this.size.h);
      this.labelRenderers.set(scene, lr);
    }
    return lr;
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.size = { w, h };
    this.renderer.setSize(w, h);
    for (const lr of this.labelRenderers.values()) lr.setSize(w, h);
  }

  // ---------- кадр ----------

  _tick(now) {
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    this._dt = dt;
    if (!this.size) return;

    if (this.timelapse) {
      const tl = this.timelapse;
      let k = (now - tl.t0) / tl.durMs;
      if (k >= 1 && tl.loop) {
        tl.t0 = now;
        k = 0;
      }
      this.setDate(new Date(tl.start + Math.min(k, 1) * tl.spanMs));
      // сценарий B идёт с тем же сдвигом по времени
      if (this.compareDate) this.setCompareDate(new Date(this.date.getTime() + tl.compareOffset));
      if (k >= 1) this.stopTimelapse();
    }

    if (this.orbiter) {
      this.orbiter.pivot.rotation.x += dt * 0.16; // полярная орбита (ускорено)
      this.orbiter.lro.lookAt(0, 0, 0);
    }

    if (this.mode === 'globe') this._frameGlobe();
    else if (this.mode === 'polar') this._framePolar(now);
    else this._frameSurface();
  }

  _frameGlobe() {
    if (this.flight) this._stepFlight();
    this.controls.update();
    this.markers.update(this.camera, this.size.w, this.size.h);
    // автопереход в Polar view при сильном приближении к полюсу
    if (this.options.autoPolar && !this.flight && this.polarView && !this._autoLock) {
      const d = this.camera.position.length();
      const { lat, lon } = vectorToLatLon(this.camera.position);
      if (d < 1.16 && lat < -80) {
        this._autoLock = true;
        this.setView('polar', { lat, lon, altitude: 220 }).then(() => setTimeout(() => (this._autoLock = false), 1500));
      }
    }
    this._render(this.scene, this.camera, (key) => this._applyGlobeLight(key === 'B' ? this.subB : this.sub));
  }

  _updateActors(dt, camera) {
    if (!this.actors.group.parent) return;
    setPointScale(this.renderer, camera);
    // во время посадки астронавт ещё в модуле
    this.actors.group.visible = true;
    if (this.actors.astro) this.actors.astro.visible = !this.landing;
    if (this.actors.flag) this.actors.flag.visible = !this.landing;
    this.actors.update(dt, { walking: !this.landing });
    // навигационные огни модуля мигают и после посадки
    const lander = this.surface?.lander;
    if (lander && !this.landing) lander.userData.fx?.update(performance.now() / 1000, dt);
  }

  _framePolar(now) {
    const pv = this.polarView;
    this._updateActors(this._dt ?? 0.016, pv.camera);
    if (this.landing) this._stepLanding(now);
    else if (this.polarFlight) {
      const f = this.polarFlight;
      const k = easeInOut(Math.min(1, (now - f.t0) / f.dur));
      pv.camera.position.lerpVectors(f.from.pos, f.to.pos, k);
      pv.controls.target.lerpVectors(f.from.target, f.to.target, k);
      pv.camera.lookAt(pv.controls.target);
      if (k >= 1) this.polarFlight = null;
    } else {
      pv.controls.update();
      pv.camera.up.set(0, 1, 0);
      if (this.options.autoPolar && !this._autoLock && pv.camera.position.distanceTo(pv.controls.target) > 1300) {
        this._autoLock = true;
        this.setView('globe').then(() => setTimeout(() => (this._autoLock = false), 1500));
      }
    }
    pv.frame(pv.camera, !this.landing);
    pv.updateShadows({ compare: !!this.compareDate, size: this.timelapse ? 512 : 1024 });
    this._render(pv.scene, pv.camera, (key) => pv.applyScenario(key));
  }

  _frameSurface() {
    const s = this.surface;
    this._updateActors(this._dt ?? 0.016, s.polar ? this.polarView.camera : this.sphereView.camera);
    if (s.polar) {
      const pv = this.polarView;
      pv.frame(pv.camera, false);
      this._updateSurfaceCamera();
      pv.updateShadows({ compare: !!this.compareDate, size: this.timelapse ? 512 : 1024 });
      this._render(pv.scene, pv.camera, (key) => pv.applyScenario(key));
    } else {
      const v = this.sphereView;
      this._render(v.scene, v.camera, (key) => v.applyState(key === 'B' ? this.subB : this.sub, key === 'B' ? this.compareDate : this.date));
    }
  }

  /** Рендер с поддержкой split-screen A/B (общая камера, разные даты). */
  _render(scene, camera, apply) {
    const r = this.renderer;
    const { w, h } = this.size;
    const split = (!!this.compareDate && !!this.subB) || !!this.compareSite;
    const camB = this.compareSite ? this._compareCamera(camera) : camera;
    const labels = this._labelsFor(scene);
    for (const lr of this.labelRenderers.values()) lr.domElement.hidden = split || lr !== labels;
    if (!split) {
      apply('A');
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
      r.render(scene, camera);
      labels.render(scene, camera);
      return;
    }
    camera.aspect = w / 2 / h;
    camera.updateProjectionMatrix();
    r.setScissorTest(true);
    apply('A');
    r.setViewport(0, 0, w / 2, h);
    r.setScissor(0, 0, w / 2, h);
    r.render(scene, camera);
    apply(this.compareSite ? 'A' : 'B');
    if (camB !== camera) {
      camB.aspect = w / 2 / h;
      camB.updateProjectionMatrix();
      if (this.mode === 'polar' && this.polarView._skyArgs) this.polarView.sky.update(camB, this.polarView._skyArgs);
    }
    r.setViewport(w / 2, 0, w / 2, h);
    r.setScissor(w / 2, 0, w / 2, h);
    r.render(scene, camB);
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    apply('A');
  }

  /** Камера для точки B: тот же ракурс, что у камеры A относительно выбранной точки. */
  _compareCamera(camera) {
    const a = this._resolve(this.markers.selectedId);
    const b = this.compareSite;
    this._camB ??= new THREE.PerspectiveCamera();
    const cb = this._camB;
    cb.copy(camera);
    if (!a || !b) return cb;
    if (this.mode === 'globe') {
      const q = new THREE.Quaternion().setFromUnitVectors(latLonToVector(a.lat, a.lon), latLonToVector(b.lat, b.lon));
      cb.position.applyQuaternion(q);
      cb.up.applyQuaternion(q);
      cb.lookAt(0, 0, 0);
    } else if (this.mode === 'polar' && this.polar?.containsLatLon(b.lat, b.lon) && this.polar.containsLatLon(a.lat, a.lon)) {
      const pv = this.polarView;
      const shift = pv.localSurface(b.lat, b.lon).sub(pv.localSurface(a.lat, a.lon));
      cb.position.add(shift);
      cb.lookAt(pv.controls.target.clone().add(shift));
    }
    cb.updateMatrixWorld();
    return cb;
  }

  _stepFlight() {
    const f = this.flight;
    const k = Math.min((performance.now() - f.start) / f.duration, 1);
    const e = easeInOut(k);
    const q = f.fromQ.clone().slerp(f.toQ, e);
    const dist = f.fromDist + (f.toDist - f.fromDist) * e;
    this.camera.position.copy(f.fromDir).applyQuaternion(q).multiplyScalar(dist);
    this.controls.enabled = k >= 1 && this.mode === 'globe'; // на время перелёта мышь не мешает
    if (k >= 1) this.flight = null;
  }
}
