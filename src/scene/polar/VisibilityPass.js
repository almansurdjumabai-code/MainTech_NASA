import * as THREE from 'three';
import { POLAR_COMMON } from './glsl.js';

// GPU-проходы в пространстве карты (каждый тексель = точка рельефа):
//  • shadow(dir)       — доля видимого диска Солнца на дату → текстура теней (считаем только при смене даты)
//  • accumulate(...)   — сумма видимости по N положениям Солнца/Земли → «% времени на свету / со связью»

const SUN_ANG_RADIUS = (0.2665 * Math.PI) / 180;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
${POLAR_COMMON}
uniform int uMode;           // 0 — направление (Солнце), 1 — точка (Земля, с параллаксом)
uniform vec3 uDir;           // система Луны
uniform vec3 uPoint;         // км, система Луны
uniform float uAngR;
uniform float uWeight;
uniform vec3 uRegion;        // область вывода: центр x, y и половина стороны, км
varying vec2 vUv;
void main() {
  vec2 m = uRegion.xy + (vUv * 2.0 - 1.0) * uRegion.z;
  vec3 u = dirFromMap(m);
  vec3 P = u * (uR + hKm(m) + 0.002); // глаз/панель на 2 м над поверхностью
  vec3 D = uMode == 0 ? uDir : normalize(uPoint - P);
  float v = dot(D, u) < -0.2 ? 0.0 : sourceVisibility(P, D, uAngR);
  gl_FragColor = vec4(vec3(v * uWeight), 1.0);
}
`;

export class VisibilityPass {
  constructor(renderer, polar, heightTex, size = polar.n) {
    this.renderer = renderer;
    this.polar = polar;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHeight: { value: heightTex },
        uHalf: { value: polar.half },
        uR: { value: 1737.4 },
        uMaxH: { value: polar.maxH },
        uTexSize: { value: new THREE.Vector2(size, size) },
        uMode: { value: 0 },
        uDir: { value: new THREE.Vector3() },
        uPoint: { value: new THREE.Vector3() },
        uAngR: { value: SUN_ANG_RADIUS },
        uWeight: { value: 1 },
        uRegion: { value: new THREE.Vector3(0, 0, polar.half) },
        uPatch: { value: null },
        uPatchRect: { value: new THREE.Vector3() },
        uPatchSize: { value: new THREE.Vector2(1, 1) },
        uHasPatch: { value: 0 },
        uT0: { value: 0.25 },
        uDt: { value: 0.06 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.targets = new Map();
  }

  target(key, size, { float = false } = {}) {
    let rt = this.targets.get(key);
    if (!rt || rt.width !== size) {
      rt?.dispose();
      rt = new THREE.WebGLRenderTarget(size, size, {
        type: float ? THREE.HalfFloatType : THREE.UnsignedByteType,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
      this.targets.set(key, rt);
    }
    return rt;
  }

  _render(rt, clear) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.setRenderTarget(rt);
    r.autoClear = false;
    if (clear) {
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
    }
    r.render(this.scene, this.camera);
    r.autoClear = prevAuto;
    r.setRenderTarget(prevTarget);
  }

  /** Тени на одну дату: sunDir — направление на Солнце в системе Луны. */
  shadow(key, sunDir, size = 1024) {
    const rt = this.target(key, size);
    const u = this.material.uniforms;
    u.uMode.value = 0;
    u.uDir.value.copy(sunDir);
    u.uAngR.value = SUN_ANG_RADIUS;
    u.uWeight.value = 1;
    this.material.blending = THREE.NoBlending;
    this._render(rt, true);
    return rt.texture;
  }

  /** Тени только в области патча (20 м), высоты патча внутри, тайл снаружи. */
  shadowPatch(key, sunDir, patchData, patchTex, size = 1024) {
    const u = this.material.uniforms;
    u.uRegion.value.set(patchData.cx, patchData.cy, patchData.half);
    u.uPatch.value = patchTex;
    u.uPatchRect.value.set(patchData.cx, patchData.cy, patchData.half);
    u.uPatchSize.value.set(patchData.n, patchData.n);
    u.uHasPatch.value = 1;
    u.uT0.value = patchData.pix * 0.7;
    u.uDt.value = patchData.pix * 0.5;
    const tex = this.shadow(key, sunDir, size);
    u.uRegion.value.set(0, 0, this.polar.half);
    u.uHasPatch.value = 0;
    u.uT0.value = 0.25;
    u.uDt.value = 0.06;
    return tex;
  }

  /** Видимость точечного источника конечного размера (Земля) на одну дату. */
  shadowToPoint(key, point, angR, size = 512) {
    const rt = this.target(key, size);
    const u = this.material.uniforms;
    u.uMode.value = 1;
    u.uPoint.value.copy(point);
    u.uAngR.value = angR;
    u.uWeight.value = 1;
    this.material.blending = THREE.NoBlending;
    this._render(rt, true);
    return rt.texture;
  }

  /**
   * Накопление: samples — [{dir} | {point, angR}]. Считается порциями по perFrame проходов,
   * onProgress(0..1), возвращает Promise<texture>. token позволяет отменить устаревший расчёт.
   */
  accumulate(key, samples, { size = 512, perFrame = 6, onProgress, isCancelled } = {}) {
    const rt = this.target(key, size, { float: true });
    const u = this.material.uniforms;
    const m = this.material;
    let i = 0;
    return new Promise((resolve) => {
      const step = () => {
        if (isCancelled?.()) return resolve(null);
        m.blending = THREE.CustomBlending;
        m.blendSrc = THREE.OneFactor;
        m.blendDst = THREE.OneFactor;
        m.blendEquation = THREE.AddEquation;
        for (let k = 0; k < perFrame && i < samples.length; k++, i++) {
          const s = samples[i];
          if (s.point) {
            u.uMode.value = 1;
            u.uPoint.value.copy(s.point);
            u.uAngR.value = s.angR;
          } else {
            u.uMode.value = 0;
            u.uDir.value.copy(s.dir);
            u.uAngR.value = SUN_ANG_RADIUS;
          }
          u.uWeight.value = 1 / samples.length;
          this._render(rt, i === 0);
        }
        m.blending = THREE.NoBlending;
        onProgress?.(i / samples.length);
        if (i < samples.length) requestAnimationFrame(step);
        else resolve(rt.texture);
      };
      step();
    });
  }

  dispose() {
    for (const rt of this.targets.values()) rt.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
