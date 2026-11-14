import * as THREE from 'three';

// Эффекты частиц. Подход взят из нашего тестового проекта («3d models test»):
// пул частиц, «горячий» молодой дым, случайный поворот текстуры клуба.
// Разница Луна / Земля — физическая: на Луне нет воздуха → нет сопротивления и плавучести,
// пыль летит по чистой баллистике (g = 1.62 м/с²) и падает, облака не бывает.

export const G_MOON = 1.62;

function canvasTexture(draw, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// мягкий диск (огонь) и рваный клуб (дым)
export const discTex = canvasTexture((g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});
export const puffTex = canvasTexture((g, s) => {
  for (let i = 0; i < 26; i++) {
    const x = s / 2 + (Math.random() - 0.5) * s * 0.45;
    const y = s / 2 + (Math.random() - 0.5) * s * 0.45;
    const r = s * (0.12 + Math.random() * 0.22);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }
});

const pointScale = { value: 600 };
export function setPointScale(renderer, camera, heightPx = renderer.domElement.height) {
  // размер частицы в метрах → пиксели с учётом высоты вьюпорта и FOV
  pointScale.value = (heightPx / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
}

export function particleMaterial({ map = discTex, color, hot, hotTime = 0.3, opacity = 1, grow = 1, additive = true, unit = 1 }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uColor: { value: new THREE.Color(color) },
      uHot: { value: new THREE.Color(hot ?? color) },
      uHotTime: { value: hotTime },
      uOpacity: { value: opacity },
      uGrow: { value: grow },
      uScale: pointScale,
      uUnit: { value: unit },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aAge; attribute float aLife; attribute float aSize; attribute float aSeed;
      uniform float uGrow; uniform float uScale; uniform float uUnit;
      varying float vK; varying float vSeed;
      void main() {
        float k = clamp(aAge / max(aLife, 1e-4), 0.0, 1.0);
        vK = k; vSeed = aSeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aAge >= aLife ? 0.0 : aSize * uUnit * (1.0 + uGrow * sqrt(k)) * uScale / max(1e-6, -mv.z);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uMap; uniform vec3 uColor; uniform vec3 uHot; uniform float uHotTime; uniform float uOpacity;
      varying float vK; varying float vSeed;
      void main() {
        #include <logdepthbuf_fragment>
        float ang = abs(vSeed) * 6.2831;
        vec2 uv = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * (gl_PointCoord - 0.5) + 0.5;
        float fade = (1.0 - vK) * smoothstep(0.0, 0.06, vK + 0.01);
        float a = texture2D(uMap, uv).a * fade * uOpacity;
        if (a < 0.01) discard;
        vec3 base = uColor * (0.8 + 0.2 * abs(vSeed));
        vec3 col = mix(uHot, base, smoothstep(0.0, uHotTime, vK));
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/** Пул частиц: gravity (м/с²), drag (1/с), groundY — частица «садится» и останавливается. */
export class ParticlePool {
  constructor(count, material, { gravity = 0, drag = 0, groundY = null, settle = false } = {}) {
    Object.assign(this, { count, gravity, drag, groundY, settle, cursor: 0 });
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.age = new Float32Array(count).fill(1);
    this.life = new Float32Array(count).fill(1);
    this.size = new Float32Array(count);
    this.seed = new Float32Array(count);
    this.buoy = new Float32Array(count);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    this.geo = g;
    this.points = new THREE.Points(g, material);
    this.points.frustumCulled = false;
  }

  spawn(x, y, z, vx, vy, vz, life, size, { buoy = 0, hot = true } = {}) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.count;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.buoy[i] = buoy;
    this.seed[i] = (0.15 + Math.random() * 0.85) * (hot ? 1 : -1);
  }

  update(dt) {
    const damp = Math.max(0, 1 - this.drag * dt);
    const { pos, vel, age, life, buoy } = this;
    for (let i = 0; i < this.count; i++) {
      if (age[i] >= life[i]) continue;
      age[i] += dt;
      const k = i * 3;
      vel[k] *= damp;
      vel[k + 1] = vel[k + 1] * damp + (buoy[i] - this.gravity) * dt;
      vel[k + 2] *= damp;
      pos[k] += vel[k] * dt;
      pos[k + 1] += vel[k + 1] * dt;
      pos[k + 2] += vel[k + 2] * dt;
      if (this.groundY !== null && pos[k + 1] < this.groundY) {
        pos[k + 1] = this.groundY;
        if (this.settle) {
          // реголит не отскакивает: пылинка ложится и гаснет
          vel[k] = vel[k + 1] = vel[k + 2] = 0;
          age[i] = Math.max(age[i], life[i] - 0.25);
        } else {
          vel[k + 1] = Math.abs(vel[k + 1]) * 0.1;
        }
      }
    }
    for (const n of ['position', 'aAge', 'aLife', 'aSize', 'aSeed']) this.geo.attributes[n].needsUpdate = true;
  }

  clear() {
    this.age.fill(1);
  }
}

/** Лунная пыль: серая, без свечения, баллистика без сопротивления. */
export function lunarDust(count = 3000) {
  return new ParticlePool(count, particleMaterial({ map: discTex, color: 0x8d877d, hot: 0xb9b2a6, hotTime: 0.2, opacity: 0.85, grow: 0.3, additive: false }), {
    gravity: G_MOON,
    groundY: 0,
    settle: true,
  });
}

/** Вспышка пыли из-под ботинка/опоры: пологие баллистические дуги во все стороны. */
export function kickDust(pool, x, y, z, { n = 24, speed = 1.6, size = 0.05, dir = null } = {}) {
  for (let i = 0; i < n; i++) {
    const a = dir !== null ? dir + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random());
    const up = v * (0.25 + Math.random() * 0.6);
    pool.spawn(x, y + 0.02, z, Math.cos(a) * v, up, Math.sin(a) * v, 2 + Math.random() * 1.5, size * (0.6 + Math.random()), { hot: false });
  }
}

/** Конусы факела + «ударные ромбы» (для RS-25). Ось — вниз по −Y от сопла. */
export function plumeMesh({ radius = 1, length = 8, color = 0xff9a3c, diamonds = 0 } = {}) {
  const group = new THREE.Group();
  const mat = (c, o) =>
    new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const outer = new THREE.Mesh(new THREE.ConeGeometry(radius, length, 24, 1, true), mat(color, 0.55));
  outer.rotation.x = Math.PI;
  outer.position.y = -length / 2;
  const inner = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.45, length * 0.65, 18, 1, true), mat(0xfff6d8, 0.85));
  inner.rotation.x = Math.PI;
  inner.position.y = -length * 0.32;
  group.add(outer, inner);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTex, color: 0xffd9a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(radius * 6);
  glow.position.y = -radius * 0.6;
  group.add(glow);
  const dia = [];
  for (let i = 0; i < diamonds; i++) {
    const d = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTex, color: 0xfff1c4, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    d.position.y = -radius * (1.4 + i * 1.9);
    d.scale.setScalar(radius * (1.3 - i * 0.18));
    group.add(d);
    dia.push(d);
  }
  group.userData = { outer, inner, glow, dia, length };
  /** power 0..1, t — время для мерцания */
  group.userData.set = (power, t) => {
    group.visible = power > 0.01;
    const f = 0.85 + 0.15 * Math.sin(t * 61 + radius) * Math.sin(t * 37);
    outer.material.opacity = 0.55 * power * f;
    inner.material.opacity = 0.85 * power * f;
    glow.material.opacity = power * f;
    outer.scale.set(1, 0.7 + 0.3 * power * f, 1);
    dia.forEach((d, i) => (d.material.opacity = power * (0.9 - i * 0.18) * f));
  };
  return group;
}
