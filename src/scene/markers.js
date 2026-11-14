import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { latLonToVector } from './coords.js';

export const CATEGORIES = {
  apollo: { color: '#f4c542', icon: '◆', title: 'Apollo' },
  artemis: { color: '#ff6b4a', icon: '▲', title: 'Artemis III' },
  clps: { color: '#3fd0c9', icon: '■', title: 'CLPS' },
  international: { color: '#a98bff', icon: '●', title: 'International' },
  custom: { color: '#ffffff', icon: '✚', title: 'Custom' },
};
// в каноническом sites.json (Участник 2) другие страны — категория 'intl'
CATEGORIES.intl = { ...CATEGORIES.international, title: 'International' };

// Форма «головки» пина по категории — различимы даже без цвета
export const HEADS = {
  intl: null, // заполняется ниже как international
  apollo: new THREE.OctahedronGeometry(1),
  artemis: new THREE.ConeGeometry(0.9, 1.8, 3).translate(0, 0.4, 0),
  clps: new THREE.BoxGeometry(1.4, 1.4, 1.4),
  international: new THREE.SphereGeometry(0.95, 16, 12),
  custom: new THREE.TorusGeometry(1.1, 0.28, 8, 24).rotateX(Math.PI / 2),
};
export const STEM = new THREE.CylinderGeometry(0.12, 0.12, 1, 6).translate(0, 0.5, 0);
const PIN_SIZE = 0.011; // радиус головки, в радиусах Луны (~19 км) при дальнем виде
HEADS.intl = HEADS.international;
const STEM_HEIGHT = 2.6; // в радиусах головки

const CLUSTER_RADIUS_PX = 34;

// мягкое свечение и кольцо для маяков (общие текстуры)
function radialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const GLOW_TEX = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
const RING_GEO = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);
const BEAM_GEO = new THREE.CylinderGeometry(0.05, 0.05, 1, 8, 1, true).translate(0, 0.5, 0);

/**
 * Маяк точки посадки: свечение головки, тонкий луч и пульсирующее кольцо на грунте.
 * Возвращает { group, update(t, selected) }; размеры — в единицах пина (масштаб задаёт родитель).
 */
export function makeBeacon(color, height) {
  const group = new THREE.Group();
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW_TEX, color, ...add }));
  glow.position.y = height;
  glow.scale.setScalar(4.2);
  const beam = new THREE.Mesh(BEAM_GEO, new THREE.MeshBasicMaterial({ color, opacity: 0.35, side: THREE.DoubleSide, ...add }));
  beam.scale.set(1, height, 1);
  const ring = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({ color, opacity: 0.7, side: THREE.DoubleSide, ...add }));
  ring.position.y = 0.05;
  group.add(glow, beam, ring);
  const phase = Math.random() * 10;
  return {
    group,
    update(t, selected) {
      const k = ((t * 0.6 + phase) % 1); // волна расходится от точки
      const base = selected ? 3.2 : 1.8;
      ring.scale.setScalar(base * (0.6 + k * 1.6));
      ring.material.opacity = (selected ? 0.95 : 0.55) * (1 - k);
      glow.material.opacity = selected ? 1 : 0.75 + 0.15 * Math.sin(t * 2 + phase);
      glow.scale.setScalar(selected ? 6 : 4.2);
      beam.material.opacity = selected ? 0.6 : 0.3;
    },
  };
}
const _v = new THREE.Vector3();

// Маркеры точек посадки: «ножка» по нормали + головка категории + HTML-подпись.
// При отдалении близкие подписи сливаются в кластер «Artemis III ×9».
export class MarkerLayer {
  constructor({ onClusterClick } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'markers';
    this.byId = new Map();
    this.selectedId = null;
    this.onClusterClick = onClusterClick;
    this.clusterPool = [];
  }

  setSites(sites) {
    this.clear();
    for (const site of sites) this.add(site);
  }

  add(site) {
    if (this.byId.has(site.id)) this.remove(site.id);
    const cat = CATEGORIES[site.category] ?? CATEGORIES.custom;
    const color = new THREE.Color(cat.color);

    const marker = new THREE.Group();
    const up = latLonToVector(site.lat, site.lon).normalize();
    marker.position.copy(up);
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);

    const material = new THREE.MeshBasicMaterial({ color });
    const stem = new THREE.Mesh(STEM, material);
    stem.scale.set(1, STEM_HEIGHT, 1);
    const head = new THREE.Mesh(HEADS[site.category] ?? HEADS.custom, material);
    head.position.y = STEM_HEIGHT + 0.6;
    for (const m of [stem, head]) m.userData.siteId = site.id;

    const pin = new THREE.Group(); // масштабируется от расстояния камеры
    pin.add(stem, head);
    const beacon = makeBeacon(color, STEM_HEIGHT + 0.6);
    pin.add(beacon.group);
    marker.add(pin);

    const el = document.createElement('div');
    el.className = 'moon-label';
    el.innerHTML = `<span class="ico">${cat.icon}</span>`;
    el.append(document.createTextNode(site.name));
    el.style.setProperty('--c', cat.color);
    const label = new CSS2DObject(el);
    label.center.set(-0.12, 0.5);
    label.position.y = STEM_HEIGHT + 0.6; // на уровне головки
    pin.add(label);

    this.group.add(marker);
    this.byId.set(site.id, { site, marker, pin, material, label, el, head, beacon });
  }

  remove(id) {
    const entry = this.byId.get(id);
    if (!entry) return;
    entry.label.element.remove();
    this.group.remove(entry.marker);
    entry.material.dispose();
    this.byId.delete(id);
    if (this.selectedId === id) this.selectedId = null;
  }

  clear() {
    for (const id of [...this.byId.keys()]) this.remove(id);
  }

  select(id) {
    if (this.selectedId) this.byId.get(this.selectedId)?.el.classList.remove('selected');
    this.selectedId = id;
    if (id) this.byId.get(id)?.el.classList.add('selected');
  }

  /** Каждый кадр: размер пинов, скрытие за лимбом, кластеризация подписей. */
  update(camera, width, height) {
    const camDist = camera.position.length();
    const horizonCos = 1 / camDist; // косинус угла до лимба для единичной сферы
    // пины уменьшаются при приближении, чтобы не закрывать рельеф
    const s = PIN_SIZE * THREE.MathUtils.clamp((camDist - 1) / 2.2, 0.04, 1);
    const camDir = _v.copy(camera.position).normalize().clone();

    const visible = [];
    const t = performance.now() / 1000;
    for (const entry of this.byId.values()) {
      entry.pin.scale.setScalar(s);
      entry.beacon.update(t, entry.site.id === this.selectedId);
      entry.facing = entry.marker.position.dot(camDir) > horizonCos - 0.02;
      entry.label.visible = entry.facing;
      if (!entry.facing) continue;
      _v.copy(entry.marker.position).project(camera);
      entry.sx = (_v.x * 0.5 + 0.5) * width;
      entry.sy = (-_v.y * 0.5 + 0.5) * height;
      visible.push(entry);
    }

    // Жадная кластеризация в экранных пикселях; выбранная точка всегда отдельно
    const clusters = [];
    const used = new Set();
    for (const a of visible) {
      if (used.has(a) || a.site.id === this.selectedId) continue;
      const members = [a];
      used.add(a);
      for (const b of visible) {
        if (used.has(b) || b.site.id === this.selectedId) continue;
        if (Math.hypot(a.sx - b.sx, a.sy - b.sy) < CLUSTER_RADIUS_PX) {
          members.push(b);
          used.add(b);
        }
      }
      if (members.length > 1) clusters.push(members);
    }

    let i = 0;
    for (const members of clusters) {
      for (const m of members) m.label.visible = false;
      this._showCluster(i++, members);
    }
    for (; i < this.clusterPool.length; i++) this.clusterPool[i].label.visible = false;
  }

  _showCluster(index, members) {
    if (!this.clusterPool[index]) {
      const el = document.createElement('button');
      el.className = 'moon-label moon-cluster';
      const label = new CSS2DObject(el);
      label.center.set(-0.1, 0.5);
      this.group.add(label);
      const slot = { el, label, members: [] };
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', () => this.onClusterClick?.(slot.members.map((m) => m.site)));
      this.clusterPool[index] = slot;
    }
    const slot = this.clusterPool[index];
    slot.members = members;
    slot.label.visible = true;

    // центр кластера — средняя точка на поверхности
    const c = new THREE.Vector3();
    for (const m of members) c.add(m.marker.position);
    slot.label.position.copy(c.normalize().multiplyScalar(1.01));

    const cats = new Set(members.map((m) => m.site.category));
    const cat = cats.size === 1 ? CATEGORIES[[...cats][0]] ?? CATEGORIES.custom : null;
    const text = cat ? `${cat.icon} ${cat.title} ×${members.length}` : `${members.length} sites`;
    if (slot.el.textContent !== text) slot.el.textContent = text;
    slot.el.style.setProperty('--c', cat ? cat.color : '#ffffff');
  }

  dispose() {
    this.clear();
    for (const { el } of this.clusterPool) el.remove();
    this.clusterPool = [];
  }

  pickables() {
    const out = [];
    for (const { marker } of this.byId.values()) marker.traverse((o) => o.isMesh && o.userData.siteId && out.push(o));
    return out;
  }
}
