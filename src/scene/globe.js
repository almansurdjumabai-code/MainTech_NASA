import * as THREE from 'three';

// Глобус Луны на данных NASA SVS CGI Moon Kit:
//  • цвет LROC 8K (запасной 2K), нормали LOLA LDEM 16 ppd в родном разрешении,
//  • смещение вершин по реальным высотам (±10 км виден на краю диска),
//  • лунное отражение: смесь Ламберта и Ломмеля–Зеелигера — полная Луна плоская, без «пластика».
// API: mesh.userData.setLighting({ sunDir, earthDir, earthshine }).

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform sampler2D uHeight;
uniform vec2 uHeightRange;   // м: min, max
uniform float uExaggeration;
varying vec2 vUv;
varying vec3 vPos;
varying vec3 vWorld;
void main() {
  vUv = uv;
  float h = mix(uHeightRange.x, uHeightRange.y, texture2D(uHeight, uv).r);
  vec3 p = normalize(position) * (1.0 + h / 1737400.0 * uExaggeration);
  vPos = normalize(position);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform sampler2D uNormal;
uniform float uNormalScale;
uniform vec3 uSunDir;
uniform vec3 uEarthDir;
uniform float uSunI;
uniform float uEarthI;
uniform float uHasMap;
varying vec2 vUv;
varying vec3 vPos;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 up = normalize(vPos);
  // касательный базис сферы: восток = ∂/∂lon, север = up × восток
  vec3 east = vec3(up.z, 0.0, -up.x);
  east = length(east) < 1e-4 ? vec3(0.0, 0.0, -1.0) : normalize(east);
  vec3 north = cross(up, east);
  vec3 t = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
  vec3 n = normalize(t.x * uNormalScale * east + t.y * uNormalScale * north + t.z * up);
  vec3 V = normalize(cameraPosition - vWorld);
  float mu0 = max(dot(n, uSunDir), 0.0);
  float mu = max(dot(n, V), 0.0);
  float brdf = mix(mu0, 2.0 * mu0 / (mu0 + mu + 1e-3), 0.6);
  // мягкий терминатор по геометрической сфере (рельеф даёт детали внутри)
  brdf *= smoothstep(-0.02, 0.02, dot(up, uSunDir));
  vec3 albedo = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb : vec3(0.55);
  // атмосферы нет: вне Солнца светит только Земля (пепельный свет)
  vec3 col = albedo * (uSunI * brdf + uEarthI * max(dot(n, uEarthDir), 0.0) * vec3(0.75, 0.85, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function placeholder(rgba) {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
  t.needsUpdate = true;
  return t;
}

export function createGlobe(renderer, { onError, quality = 'high' } = {}) {
  const loader = new THREE.TextureLoader();
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  const uniforms = {
    uMap: { value: placeholder([140, 140, 140, 255]) },
    uNormal: { value: placeholder([128, 128, 255, 255]) },
    uHeight: { value: placeholder([128, 128, 128, 255]) },
    uHeightRange: { value: new THREE.Vector2(0, 0) },
    uExaggeration: { value: 1.0 },
    uNormalScale: { value: 2.2 },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uEarthDir: { value: new THREE.Vector3(1, 0, 0) },
    uSunI: { value: 2.9 },
    uEarthI: { value: 0 },
    uHasMap: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms });

  const load = (files, onLoad) => {
    const [first, ...rest] = files;
    loader.load(
      `/textures/${first}`,
      onLoad,
      undefined,
      () => (rest.length ? load(rest, onLoad) : onError?.(first)),
    );
  };
  // 8K для качества; если файла нет или слабое устройство — 4K
  load(quality === 'low' ? ['moon_color_2k.jpg'] : ['moon_color_8k.jpg', 'moon_color_2k.jpg'], (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
    uniforms.uMap.value = tex;
    uniforms.uHasMap.value = 1;
  });
  load(quality === 'low' ? ['moon_normal_2k.jpg'] : ['moon_normal_16ppd.jpg', 'moon_normal_2k.jpg'], (tex) => {
    tex.anisotropy = anisotropy;
    uniforms.uNormal.value = tex;
  });
  fetch('/textures/moon_height_2k.json')
    .then((r) => r.json())
    .then((m) =>
      load(['moon_height_2k.png'], (tex) => {
        uniforms.uHeight.value = tex;
        uniforms.uHeightRange.value.set(m.minM, m.maxM);
      }),
    )
    .catch(() => {}); // без высот — гладкая сфера

  const segs = quality === 'low' ? [256, 128] : [1024, 512];
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, ...segs), material);
  mesh.name = 'moon-globe';
  mesh.userData.setLighting = ({ sunDir, earthDir, earthshine }) => {
    uniforms.uSunDir.value.copy(sunDir).normalize();
    uniforms.uEarthDir.value.copy(earthDir).normalize();
    uniforms.uEarthI.value = earthshine;
  };
  return mesh;
}
