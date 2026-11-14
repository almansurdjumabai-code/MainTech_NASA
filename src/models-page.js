// Витрина 3D-моделей: один WebGL-рендерер, каждая карточка — свой viewport (scissor).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MODEL_CATALOG, loadModel } from './scene/models.js';
import { createGlobe } from './scene/globe.js';
import { createStarfield } from './scene/starfield.js';
import { AstronautRig } from './scene/astronautRig.js';
import { LanderFx } from './scene/landerFx.js';
import { lunarDust, ParticlePool, particleMaterial, plumeMesh, puffTex, discTex, setPointScale } from './scene/effects.js';

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.setClearColor(0x000000, 0);

const grid = document.getElementById('grid');
const cards = [];

// ---------- общая «лунная» сцена: низкое Солнце, реголит, чёрное небо ----------
function stage({ ground = true, size = 40 } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020306);
  const sun = new THREE.DirectionalLight(0xffffff, 3.4);
  sun.position.set(-12, 5, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  Object.assign(sun.shadow.camera, { left: -size / 2, right: size / 2, top: size / 2, bottom: -size / 2, near: 0.1, far: size * 4 });
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0x9db8ff, 0x000000, 0.18)); // слабый свет Земли
  const stars = createStarfield(2500, 300);
  scene.add(stars);
  if (ground) {
    const g = new THREE.Mesh(
      new THREE.CircleGeometry(size * 3, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x3b3a37, roughness: 1 }),
    );
    g.receiveShadow = true;
    scene.add(g);
  }
  return { scene, sun };
}

function addCard({ key, title, chips, text, script, animations = [], build, wide = false }) {
  const el = document.createElement('article');
  el.className = wide ? 'card wide' : 'card';
  el.innerHTML = `
    <div class="view"></div>
    <div class="meta">
      <h2>${title}</h2>
      <div class="chips">${chips.map(([cls, t]) => `<span class="chip ${cls}">${t}</span>`).join('')}</div>
      <p>${text}</p>
      ${script ? `<code>${script}</code>` : ''}
      <div class="anim"></div>
    </div>`;
  grid.appendChild(el);
  const view = el.querySelector('.view');
  const camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.05, 5000);
  const controls = new OrbitControls(camera, view);
  controls.enableDamping = true;
  const card = { key, el, view, camera, controls, scene: null, update: null, active: {}, ready: false };
  cards.push(card);
  const bar = el.querySelector('.anim');
  for (const a of animations) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.className = a.on ? 'on' : '';
    card.active[a.id] = !!a.on;
    b.addEventListener('click', () => {
      card.active[a.id] = !card.active[a.id];
      b.classList.toggle('on', card.active[a.id]);
      card.onToggle?.(a.id, card.active[a.id]);
    });
    bar.appendChild(b);
  }
  build(card).then(() => (card.ready = true)).catch((err) => {
    view.innerHTML = `<div class="missing">Model unavailable: ${err.message}</div>`;
  });
  return card;
}

function frameObject(card, object, { dist = 2.3, height = 0.4 } = {}) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const r = size.length() * 0.5;
  card.controls.target.copy(center);
  card.camera.position.copy(center).add(new THREE.Vector3(r * dist, r * height + size.y * 0.15, r * dist * 0.9));
  card.camera.near = r / 100;
  card.camera.far = r * 200;
  card.camera.updateProjectionMatrix();
}

function count(object) {
  let tris = 0;
  object.traverse((o) => {
    if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  });
  return Math.round(tris);
}

function plume(radius = 0.5, length = 3.5) {
  const m = new THREE.Mesh(
    new THREE.ConeGeometry(radius, length, 24, 1, true).translate(0, -length / 2, 0),
    new THREE.MeshBasicMaterial({ color: 0xffbf73, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  const core = m.clone();
  core.material = m.material.clone();
  core.material.color.set(0xfff4dd);
  core.scale.set(0.45, 0.7, 0.45);
  m.add(core);
  return m;
}

const chipFor = (key) => {
  const m = MODEL_CATALOG[key];
  return m.source.startsWith('NASA') ? ['nasa', 'NASA official'] : ['blender', 'Blender procedural'];
};

async function modelCard(card, key, opts = {}) {
  const obj = await loadModel(key);
  if (!obj) throw new Error(`${key}.glb`);
  const { scene, sun } = stage({ size: opts.size ?? 40, ground: opts.ground ?? true });
  scene.add(obj);
  card.scene = scene;
  card.sun = sun;
  card.obj = obj;
  frameObject(card, obj, opts.frame);
  const stats = card.el.querySelector('.chips');
  const h = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3()).y;
  stats.insertAdjacentHTML('beforeend', `<span class="chip stat">${count(obj).toLocaleString('en')} tris</span><span class="chip stat">${h.toFixed(1)} m</span>`);
  return obj;
}

// ---------- карточки ----------

addCard({
  key: 'clps',
  title: 'CLPS robotic lander',
  chips: [chipFor('clps_lander')],
  text: 'Rigged for the landing simulation: legs unfold before touchdown, the solar mast tracks the Sun, the engine plume fires during descent.',
  script: 'scripts/blender/build_clps_lander.py',
  animations: [
    { id: 'land', label: 'Descent & touchdown', on: true },
    { id: 'track', label: 'Sun tracking', on: true },
  ],
  async build(card) {
    const obj = await modelCard(card, 'clps_lander', { size: 16, frame: { dist: 3.4, height: 0.9 } });
    const legs = [];
    obj.traverse((o) => o.name.startsWith('LegHinge_') && legs.push({ o, base: o.quaternion.clone() }));
    const mast = obj.getObjectByName('SolarMast');
    const nozzle = obj.getObjectByName('Nozzle_Main');
    const fire = plume(0.35, 2.4);
    (nozzle ?? obj).add(fire);
    const axis = new THREE.Vector3(0, 0, 1);
    const dust = lunarDust(3000);
    card.scene.add(dust.points);
    card.update = (t) => {
      // цикл 8 с: снижение 5 с (факел), касание, стоянка
      const c = card.active.land ? (t % 8) / 8 : 1;
      const alt = c < 0.62 ? 6 * (1 - c / 0.62) ** 2 : 0;
      obj.position.y = alt;
      fire.visible = card.active.land && c < 0.64;
      fire.material.opacity = 0.55 + 0.25 * Math.sin(t * 40);
      const unfold = THREE.MathUtils.smoothstep(c, 0.1, 0.45); // опоры раскрываются на подходе
      for (const { o, base } of legs) o.quaternion.copy(base).multiply(new THREE.Quaternion().setFromAxisAngle(axis, (1 - unfold) * -1.1));
      if (mast && card.active.track) mast.rotation.y = Math.sin(t * 0.4) * 1.2;
      // струя сдувает реголит: без воздуха — пологие баллистические дуги, облака нет
      if (fire.visible && alt < 3) {
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * Math.PI * 2;
          const v = 3 + Math.random() * 6 * (1 - alt / 3);
          dust.spawn(Math.cos(a) * 0.6, 0.02, Math.sin(a) * 0.6, Math.cos(a) * v, v * (0.05 + Math.random() * 0.15), Math.sin(a) * v, 2.5, 0.05 + Math.random() * 0.06, { hot: false });
        }
      }
      dust.update(card.dt ?? 0.016);
    };
  },
});

addCard({
  key: 'artemis',
  title: 'Artemis crew lander',
  chips: [chipFor('artemis_lander')],
  text: "After NASA's human landing system illustration: descent stage, crew cabin, gold-foil tanks, octagonal array on a mast. Astronaut for scale.",
  script: 'scripts/blender/build_models.py artemis_lander',
  animations: [
    { id: 'track', label: 'Array tracks the Sun', on: true },
    { id: 'sun', label: 'Polar day: Sun circles the horizon', on: true },
  ],
  // огни мигают, двигатели ориентации дают короткие выбросы газа
  async build(card) {
    const obj = await modelCard(card, 'artemis_lander', { size: 50 });
    const astro = await loadModel('astronaut');
    const astroRig = astro ? new AstronautRig(astro) : null;
    const astroDust = lunarDust(2000);
    card.scene.add(astroDust.points);
    if (astro) card.scene.add(astro);
    const panels = obj.getObjectByName('SolarPanels');
    const fx = new LanderFx(obj);
    card.update = (t, dt) => {
      fx.update(t, dt, { rcsRate: 1.2 }); // навигационные огни и импульсы двигателей ориентации
      if (astroRig) {
        const a = t * 0.12 + 0.8; // обход модуля по кругу 6.5 м
        astro.position.set(Math.cos(a) * 6.5, 0, Math.sin(a) * 6.5);
        astro.rotation.y = -a;
        astro.position.y = Math.max(0, astroRig.update(t, dt, { speed: 0.9, dust: astroDust }));
        astroDust.update(dt);
      }
      // на полюсе Солнце ходит по кругу у горизонта: ~1.5° над ним
      const az = card.active.sun ? t * 0.35 : 0.8;
      card.sun.position.set(Math.cos(az) * 30, 2.2, Math.sin(az) * 30);
      if (panels && card.active.track) panels.rotation.y = -az + Math.PI / 2;
    };
  },
});

addCard({
  key: 'apollo',
  title: 'Apollo Lunar Module',
  chips: [chipFor('apollo_lm')],
  text: 'Official NASA model, decimated from 97k to 15k triangles and scaled to 7 m. Used when you land at an Apollo site.',
  script: 'scripts/blender/prep_lander.py apollo_lm.glb --height 7',
  animations: [{ id: 'spin', label: 'Turntable', on: true }],
  async build(card) {
    const obj = await modelCard(card, 'apollo_lm', { size: 30 });
    card.update = (t, dt) => card.active.spin && (obj.rotation.y += dt * 0.25);
  },
});

addCard({
  key: 'astronaut',
  title: 'Astronaut, rigged',
  chips: [chipFor('astronaut')],
  text: 'Built in Blender with joints. Lunar lope like the Apollo crews: at g = 1.62 m/s² a step becomes a hop with a long flight phase; every footfall kicks dust that flies on clean ballistic arcs.',
  script: 'scripts/blender/build_models.py astronaut · src/scene/astronautRig.js',
  animations: [{ id: 'walk', label: 'Lunar lope', on: true }],
  async build(card) {
    const obj = await modelCard(card, 'astronaut', { size: 14, frame: { dist: 4.2, height: 0.6 } });
    const rig = new AstronautRig(obj);
    const dust = lunarDust(2500);
    card.scene.add(dust.points);
    card.update = (t, dt) => {
      rig.mode = card.active.walk ? 'walk' : 'idle';
      const a = t * 0.45;
      if (card.active.walk) {
        // круг 1.2 м вокруг центра кадра, лицом по ходу движения
        obj.position.x = Math.cos(a) * 1.2;
        obj.position.z = Math.sin(a) * 1.2;
        obj.rotation.y = -a;
      }
      obj.position.y = Math.max(0, rig.update(t, dt, { speed: 1, dust }));
      dust.update(dt);
    };
  },
});

addCard({
  key: 'flag',
  title: 'MainTech team flag',
  chips: [['blender', 'Team intro'], ['stat', 'animated']],
  text: 'Exported from our intro scene (blender/intro.blend) with its planting animation. Appears next to the lander after touchdown.',
  script: 'scripts/blender/export_team_flag.py',
  animations: [{ id: 'plant', label: 'Plant (loop)', on: true }],
  async build(card) {
    const obj = await modelCard(card, 'flag', { size: 12, frame: { dist: 2.2, height: 0.25 } });
    obj.rotation.y = -0.9; // полотнище к камере
    const clips = obj.userData.animations ?? [];
    const mixer = new THREE.AnimationMixer(obj);
    const actions = clips.map((c) => mixer.clipAction(c).play());
    const dur = Math.max(1, ...clips.map((c) => c.duration));
    let elapsed = 0;
    card.update = (t, dt) => {
      if (!card.active.plant) return;
      mixer.update(dt);
      elapsed += dt;
      if (elapsed > dur + 5) { // держим поставленный флаг 5 с
        elapsed = 0;
        for (const a of actions) a.reset().play();
      }
    };
  },
});

for (const n of [14, 16]) {
  addCard({
    key: `a${n}`,
    title: `Apollo ${n} landing site`,
    chips: [['nasa', 'NASA official'], ['stat', '3D-print relief']],
    text:
      n === 14
        ? 'Fra Mauro: official NASA terrain plate. The Sun circles low like at sunrise, so every crater rim throws a long shadow.'
        : 'Descartes highlands: official NASA terrain plate. A low Sun shows how relief alone decides light and shadow without an atmosphere.',
    script: 'scripts/blender/prep_site_plate.py',
    animations: [{ id: 'sun', label: 'Moving Sun', on: true }],
    async build(card) {
      await modelCard(card, `apollo${n}_site`, { size: 2.5, ground: false, frame: { dist: 1.2, height: 0.7 } });
      const sc = card.sun.shadow.camera;
      Object.assign(sc, { left: -0.8, right: 0.8, top: 0.8, bottom: -0.8, near: 0.01, far: 6 });
      sc.updateProjectionMatrix();
      card.sun.shadow.bias = -0.0002;
      card.update = (t) => {
        const a = card.active.sun ? t * 0.25 : 0.6;
        card.sun.position.set(Math.cos(a) * 2, 0.25 + Math.sin(t * 0.13) * 0.08, Math.sin(a) * 2);
      };
    },
  });
}

addCard({
  key: 'lro',
  title: 'Lunar Reconnaissance Orbiter',
  chips: [chipFor('lro')],
  text: 'The spacecraft behind our Moon: LROC images and LOLA heights. Flies a polar orbit over the globe in the main view.',
  script: 'scripts/blender/prep_lander.py lro.glb --center',
  animations: [{ id: 'orbit', label: 'Polar orbit', on: true }],
  async build(card) {
    const lro = await loadModel('lro');
    if (!lro) throw new Error('lro.glb');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020306);
    scene.add(createStarfield(2500, 300));
    const sun = new THREE.DirectionalLight(0xffffff, 3.2);
    sun.position.set(-5, 1, 3);
    scene.add(sun, new THREE.AmbientLight(0xffffff, 0.04));
    const moon = createGlobe(renderer, { quality: 'low' });
    scene.add(moon);
    const pivot = new THREE.Group();
    const holder = new THREE.Group();
    holder.position.set(0, 0, 1.25);
    lro.scale.setScalar(0.006);
    holder.add(lro);
    pivot.add(holder);
    scene.add(pivot);
    card.scene = scene;
    card.controls.target.set(0, 0, 0);
    card.camera.position.set(2.6, 0.8, 2.4);
    card.el.querySelector('.chips').insertAdjacentHTML('beforeend', `<span class="chip stat">${count(lro).toLocaleString('en')} tris</span><span class="chip stat">scale ×100</span>`);
    card.update = (t, dt) => {
      if (card.active.orbit) pivot.rotation.x += dt * 0.5;
      lro.lookAt(0, 0, 0);
      moon.rotation.y += dt * 0.02;
    };
  },
});

addCard({
  key: 'sls',
  wide: true,
  title: 'SLS Block 1B — liftoff',
  chips: [chipFor('sls'), ['stat', 'particles']],
  text: 'Earth launch for the pitch intro. Layered exhaust after our test-project approach: white-hot core and shock diamonds on the four RS-25, dense orange booster flames, smoke that spreads over the pad and rises, flickering light and camera shake.',
  script: 'scripts/blender/build_models.py sls · src/scene/effects.js',
  animations: [{ id: 'launch', label: 'Countdown & liftoff', on: true }],
  async build(card) {
    const obj = await modelCard(card, 'sls', { size: 400, frame: { dist: 2.3, height: 0.1 } });
    const { scene, sun } = card;
    // земное небо днём: голубой фон, дымка, без звёзд
    scene.background = new THREE.Color(0x9fb8d4);
    scene.fog = new THREE.Fog(0x9fb8d4, 250, 1400);
    for (const o of scene.children.filter((c) => c.isPoints)) scene.remove(o);
    sun.intensity = 2.6;
    sun.position.set(-120, 160, 90);
    Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 160, bottom: -20, far: 600 });
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x55606a, 1.1));
    const ground = scene.children.find((o) => o.isMesh && o.geometry.type === 'CircleGeometry');
    if (ground) ground.material.color.set(0x5d6650);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(22, 26, 6, 48), new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.9 }));
    pad.position.y = -3;
    pad.receiveShadow = true;
    scene.add(pad);
    const rocket = new THREE.Group();
    scene.add(rocket);
    rocket.add(obj);

    const flames = new ParticlePool(4000, particleMaterial({ map: discTex, color: 0xd2501e, hot: 0xfff3c8, hotTime: 0.5, opacity: 0.9, grow: 1.6 }), { drag: 1.0 });
    const smoke = new ParticlePool(9000, particleMaterial({ map: puffTex, color: 0xe7eaee, hot: 0xffb066, hotTime: 0.08, opacity: 0.6, grow: 5, additive: false }), { drag: 0.5 });
    scene.add(smoke.points, flames.points);
    const light = new THREE.PointLight(0xffa860, 0, 600, 1.4);
    scene.add(light);
    // факелы: 2 ускорителя (плотное пламя), 4 × RS-25 (прозрачное, с ударными ромбами)
    const boosters = [-6.6, 6.6].map((x) => {
      const m = plumeMesh({ radius: 2.4, length: 34, color: 0xff8a2a });
      m.position.set(x, 0, 0);
      obj.add(m);
      return m;
    });
    const cores = [[-1.7, 1.7], [1.7, 1.7], [-1.7, -1.7], [1.7, -1.7]].map(([x, z]) => {
      const m = plumeMesh({ radius: 1.1, length: 16, color: 0x9fc4ff, diamonds: 4 });
      m.position.set(x, 0, z);
      obj.add(m);
      return m;
    });
    const baseCam = card.camera.position.clone();
    const rnd = (a) => (Math.random() - 0.5) * 2 * a;
    let lastT = 0;
    card.update = (t, dt) => {
      const T = card.active.launch ? t % 14 : 0; // 0–3 с отсчёт, 3 с зажигание RS-25, 4 с ускорители, 4.2 с отрыв
      const ign = T > 3;
      const lift = Math.max(0, T - 4.2);
      const y = 1.6 * lift * lift;
      rocket.position.y = y;
      const corePow = ign ? Math.min(1, (T - 3) / 0.6) : 0;
      const srbPow = T > 4 ? 1 : 0;
      for (const m of cores) m.userData.set(corePow, t);
      for (const m of boosters) m.userData.set(srbPow, t);
      const n = ign ? Math.round(dt * 400) : 0;
      for (let i = 0; i < n; i++) {
        for (const x of srbPow ? [-6.6, 6.6, 0] : [0]) {
          const big = x !== 0;
          flames.spawn(x + rnd(big ? 1.2 : 2), y - 2, rnd(big ? 1.2 : 2), rnd(4), -(50 + Math.random() * 40), rnd(4), 0.35 + Math.random() * 0.25, big ? 4 : 2.6);
        }
        // у стола дым растекается во все стороны и поднимается
        const nearPad = Math.max(0, 1 - y / 120);
        if (Math.random() < 0.9 * nearPad * (srbPow ? 1 : 0.3)) {
          const a = Math.random() * Math.PI * 2;
          const v = 18 + Math.random() * 28;
          smoke.spawn(Math.cos(a) * 8, 1 + Math.random() * 3, Math.sin(a) * 8, Math.cos(a) * v, 2 + Math.random() * 5, Math.sin(a) * v, 7 + Math.random() * 5, 7 + Math.random() * 5, { buoy: 1.2 });
        }
        // дымный след ускорителей
        if (srbPow && y > 10 && Math.random() < 0.7) {
          for (const x of [-6.6, 6.6]) smoke.spawn(x + rnd(2), y - 30 - Math.random() * 10, rnd(2), rnd(3), -8, rnd(3), 9 + Math.random() * 4, 6 + Math.random() * 3, { buoy: 0.3 });
        }
      }
      if (T < lastT) {
        flames.clear();
        smoke.clear();
      }
      lastT = T;
      flames.update(dt);
      smoke.update(dt);
      light.position.set(0, y - 10, 0);
      light.intensity = (corePow * 3000 + srbPow * 9000) * (0.85 + 0.15 * Math.sin(t * 47));
      // камера следит за ракетой и дрожит от звуковой волны
      const shake = ign ? Math.max(0, 1 - y / 300) * (srbPow ? 1.2 : 0.4) : 0;
      card.controls.target.set(0, 45 + y * 0.85, 0);
      card.camera.position.set(baseCam.x + rnd(shake), baseCam.y + y * 0.6 + rnd(shake), baseCam.z + rnd(shake));
    };
  },
});

// ---------- рендер: каждая карточка в своём прямоугольнике ----------
const clock = new THREE.Clock();
function render() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
  }
  renderer.setScissorTest(false);
  renderer.setClearColor(0x000000, 0); // фон карточки (небо SLS) не должен заливать страницу
  renderer.clear();
  renderer.setScissorTest(true);
  for (const c of cards) {
    if (!c.ready || !c.scene) continue;
    const r = c.view.getBoundingClientRect();
    if (r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) continue;
    c.dt = dt;
    c.update?.(t, dt);
    c.controls.update();
    c.camera.aspect = r.width / r.height;
    c.camera.updateProjectionMatrix();
    setPointScale(renderer, c.camera, r.height * renderer.getPixelRatio());
    const y = h - r.bottom;
    renderer.setViewport(r.left, y, r.width, r.height);
    renderer.setScissor(r.left, y, r.width, r.height);
    renderer.render(c.scene, c.camera);
  }
  requestAnimationFrame(render);
}
render();
