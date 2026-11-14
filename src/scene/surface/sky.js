import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createStarfield } from '../starfield.js';
import { createSunSprite } from '../sun.js';
import { earthSpin, loadEarthMaterial } from '../earth.js';
import { dirFromAzEl, horizonAt } from './horizon.js';

// Небо локальных сцен (полюс, вид с поверхности), км.
// Группа следует за камерой; внутренняя группа повёрнута «система Луны → локальная»,
// поэтому всё небесное задаётся прямо в векторах системы Луны.

export const SKY_KM = 5000;
const D2R = Math.PI / 180;
const SUN_CORE_FRACTION = 0.16; // доля диска в текстуре спрайта

// текстуры блика: лучистая звезда и мягкий «призрак» объектива
function flareTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128);
  if (kind === 'star') {
    for (let i = 0; i < 6; i++) {
      g.rotate(Math.PI / 6);
      const grd = g.createLinearGradient(-128, 0, 128, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.5, 'rgba(255,250,235,0.9)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(-128, -1.2, 256, 2.4);
    }
  } else {
    const grd = g.createRadialGradient(0, 0, 40, 0, 0, 128);
    grd.addColorStop(0, 'rgba(255,255,255,0.0)');
    grd.addColorStop(0.75, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(-128, -128, 256, 256);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Sky {
  constructor({ moonToLocal, onAssetError }) {
    this.group = new THREE.Group();
    this.group.name = 'sky';
    this.inner = new THREE.Group();
    this.inner.quaternion.copy(moonToLocal);
    this.group.add(this.inner);

    const stars = createStarfield(7000, 400);
    stars.scale.setScalar((SKY_KM * 1.6) / 400);
    stars.material.transparent = true;
    this.stars = stars;
    this.inner.add(stars);

    this.sun = createSunSprite();
    this.inner.add(this.sun);

    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), loadEarthMaterial(onAssetError));
    this.earth.name = 'earth-sky';
    this.inner.add(this.earth);
    // тонкий голубой ореол атмосферы по краю диска Земли (френель)
    this.atmo = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) } },
        vertexShader: `#include <common>
          #include <logdepthbuf_pars_vertex>
          varying vec3 vN; varying vec3 vV; varying vec3 vW;
          void main() {
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
            vV = normalize(cameraPosition - w.xyz);
            gl_Position = projectionMatrix * viewMatrix * w;
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `#include <common>
          #include <logdepthbuf_pars_fragment>
          uniform vec3 uSun; varying vec3 vN; varying vec3 vV; varying vec3 vW;
          void main() {
            #include <logdepthbuf_fragment>
            float rim = pow(1.0 - abs(dot(vN, vV)), 3.0);
            float day = smoothstep(-0.25, 0.4, dot(vN, uSun)); // светится только дневная сторона
            gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * rim * day * 1.6, rim * day);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
      }),
    );
    this.earth.add(this.atmo);

    this.dome = new THREE.Group();
    this.dome.name = 'sky-dome';
    this.dome.visible = false;
    this.inner.add(this.dome);

    this._tmp = new THREE.Vector3();

    // блик Солнца (как у объективов камер на снимках с поверхности): звезда + «призраки»
    const spr = (map, color) =>
      new THREE.Sprite(new THREE.SpriteMaterial({ map, color, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.flare = new THREE.Group();
    this.flare.renderOrder = 20;
    this.star = spr(flareTexture('star'), 0xfff4dc);
    const ghostTex = flareTexture('ghost');
    this.ghosts = [
      [0.55, 0.05, 0x9fd0ff],
      [0.2, 0.03, 0xffd38a],
      [-0.35, 0.08, 0x8affc9],
      [-0.8, 0.12, 0xb69cff],
    ].map(([k, size, color]) => Object.assign(spr(ghostTex, color), { userData: { k, size } }));
    this.flare.add(this.star, ...this.ghosts);
    for (const o of this.flare.children) o.renderOrder = 20;
    this.group.add(this.flare);
  }

  /** earthDirMoon — уже с параллаксом (из точки наблюдения), earthAngR — угловой радиус, рад. */
  update(camera, { sunDirMoon, earthDirMoon, earthAngR, sub, date }) {
    this.group.position.copy(camera.position);
    const ds = SKY_KM * 0.95;
    this.sun.position.copy(sunDirMoon).multiplyScalar(ds);
    // реальный угловой размер диска (0.53°), ореол вокруг — шире
    this.sun.scale.setScalar((ds * Math.tan(0.2665 * D2R) * 2) / SUN_CORE_FRACTION);
    const de = SKY_KM * 0.85;
    this.earth.position.copy(earthDirMoon).multiplyScalar(de);
    this.earth.scale.setScalar(de * Math.tan(earthAngR));
    this.earth.rotation.y = earthSpin(sub, date, this._tmp);
    this.atmo.material.uniforms.uSun.value.copy(sunDirMoon).applyQuaternion(this.inner.quaternion);
    // экспозиция: Солнце в кадре → звёзды гаснут (как на снимках с поверхности Луны)
    const view = camera.getWorldDirection(new THREE.Vector3());
    const sunWorld = sunDirMoon.clone().applyQuaternion(this.inner.quaternion);
    const inView = view.angleTo(sunWorld) < THREE.MathUtils.degToRad(camera.fov * 0.75);
    const target = inView ? 0.12 : 1;
    this.stars.material.opacity += (target - this.stars.material.opacity) * 0.08;
    this._updateFlare(camera, sunWorld);
  }

  /** Блик рисуется в экранных координатах: звезда на диске, призраки на линии Солнце → центр кадра. */
  _updateFlare(camera, sunWorld) {
    if (!this.flareEnabled) return (this.flare.visible = false);
    const ndc = camera.position.clone().addScaledVector(sunWorld, 1000).project(camera);
    const on = ndc.z < 1 && Math.abs(ndc.x) < 1.1 && Math.abs(ndc.y) < 1.1;
    this.flare.visible = on;
    if (!on) return;
    const d = Math.max(camera.near * 20, 0.002); // чуть дальше ближней плоскости
    const place = (o, x, y, size) => {
      const p = new THREE.Vector3(x, y, 0.5).unproject(camera).sub(camera.position).normalize().multiplyScalar(d);
      o.position.copy(p);
      o.scale.setScalar(size * d * 2.2 * (camera.fov / 60));
    };
    // Солнце за горой — блика нет; частично закрыто — слабее
    const vis = this.sunVisibility ?? 1;
    this.flare.visible = vis > 0.001;
    const fade = (1 - Math.min(1, Math.hypot(ndc.x, ndc.y) / 1.3) * 0.5) * vis;
    place(this.star, ndc.x, ndc.y, 0.15);
    this.star.material.opacity = 0.75 * fade;
    for (const g of this.ghosts) {
      place(g, ndc.x * g.userData.k, ndc.y * g.userData.k, g.userData.size * 2);
      g.material.opacity = 0.3 * fade;
    }
  }

  /**
   * Купол неба для вида с поверхности: профиль горизонта и дуги Солнца/Земли.
   * paths: { sun: [{az, el, t}], earth: [{az, el, t}] }
   */
  buildDome(frame, profile, paths) {
    this.clearDome();
    const R = SKY_KM * 0.7;
    const v = new THREE.Vector3();

    // кольцо профиля горизонта
    const ring = [];
    for (let az = 0; az <= 360; az += profile.stepDeg) {
      dirFromAzEl(frame, az, horizonAt(profile, az), v);
      ring.push(v.x * R, v.y * R, v.z * R);
    }
    this.dome.add(line(ring, null, 0x67d4ff, 0.9, true));

    // дуги: ярко — над горизонтом рельефа, тускло — под ним
    const addPath = (pts, color, dimColor) => {
      const pos = [];
      const col = [];
      const c1 = new THREE.Color(color);
      const c0 = new THREE.Color(dimColor);
      for (const p of pts) {
        dirFromAzEl(frame, p.az, p.el, v);
        pos.push(v.x * R, v.y * R, v.z * R);
        const c = p.el > horizonAt(profile, p.az) ? c1 : c0;
        col.push(c.r, c.g, c.b);
      }
      this.dome.add(line(pos, col, 0xffffff, 1, false));
    };
    addPath(paths.sun, 0xffd23f, 0x5a4a1a);
    addPath(paths.earth, 0x6fb6ff, 0x1d3550);

    // для сравнения: путь Солнца над Астаной в те же сутки (в тех же азимутах наблюдателя)
    if (paths.earthCity?.length) {
      const pos = [];
      for (const p of paths.earthCity) {
        dirFromAzEl(frame, p.az, p.el, v);
        pos.push(v.x * R, v.y * R, v.z * R);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const l = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xff9a6a, dashSize: R * 0.02, gapSize: R * 0.015, transparent: true, opacity: 0.85, depthWrite: false }));
      l.computeLineDistances();
      l.frustumCulled = false;
      this.dome.add(l);
      const top = paths.earthCity.reduce((m, p) => (p.el > m.el ? p : m));
      dirFromAzEl(frame, top.az, top.el, v).multiplyScalar(R);
      this.dome.add(label(`Sun over Astana, Earth — same day, max ${top.el.toFixed(0)}°`, v, 'sky-earthcity'));
    }

    // метки времени на дуге Солнца
    for (const p of paths.sun.filter((s) => s.label)) {
      dirFromAzEl(frame, p.az, p.el, v).multiplyScalar(R);
      this.dome.add(label(p.label, v, 'sky-tick'));
    }
    // стороны света на горизонте
    for (const [name, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      dirFromAzEl(frame, az, horizonAt(profile, az) + 0.4, v).multiplyScalar(R);
      this.dome.add(label(name, v, 'sky-cardinal'));
    }
    this.dome.visible = true;
  }

  clearDome() {
    for (const o of [...this.dome.children]) {
      o.traverse((c) => {
        c.geometry?.dispose();
        c.material?.dispose();
        if (c.isCSS2DObject) c.element.remove();
      });
      this.dome.remove(o);
    }
    this.dome.visible = false;
  }
}

function line(positions, colors, color, opacity, onTop) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const m = new THREE.LineBasicMaterial({
    color: colors ? 0xffffff : color,
    vertexColors: !!colors,
    transparent: opacity < 1,
    opacity,
    depthTest: !onTop,
    depthWrite: false,
  });
  const l = new THREE.Line(g, m);
  l.renderOrder = onTop ? 10 : 1;
  l.frustumCulled = false;
  return l;
}

function label(text, pos, cls) {
  const el = document.createElement('div');
  el.className = `sky-label ${cls}`;
  el.textContent = text;
  const o = new CSS2DObject(el);
  o.position.copy(pos);
  return o;
}
