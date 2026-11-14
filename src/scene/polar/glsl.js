// Общий GLSL для рельефа полюса: проекция и raymarch видимости источника (Солнце/Земля).
// Тот же алгоритм на CPU — в surface/horizon.js (горизонт), чтобы цифры совпадали.

export const POLAR_COMMON = /* glsl */ `
uniform sampler2D uHeight;   // высоты, км (R32F), v = 0 — низ карты (−y)
uniform float uHalf;         // половина стороны тайла, км
uniform float uR;            // радиус сферы отсчёта, км
uniform float uMaxH;         // максимум рельефа, км
uniform vec2 uTexSize;
uniform sampler2D uPatch;    // 20-метровые высоты вокруг точки (если есть)
uniform vec3 uPatchRect;     // центр x, y и половина стороны патча, км
uniform vec2 uPatchSize;
uniform float uHasPatch;
uniform float uT0;           // первый шаг луча, км
uniform float uDt;           // линейная добавка шага, км

float bilinear(sampler2D tex, vec2 st, vec2 size) {
  vec2 f = fract(st);
  ivec2 i0 = ivec2(floor(st));
  ivec2 lim = ivec2(size) - 1;
  ivec2 a = clamp(i0, ivec2(0), lim);
  ivec2 b = clamp(i0 + 1, ivec2(0), lim);
  return mix(mix(texelFetch(tex, a, 0).r, texelFetch(tex, ivec2(b.x, a.y), 0).r, f.x),
             mix(texelFetch(tex, ivec2(a.x, b.y), 0).r, texelFetch(tex, b, 0).r, f.x), f.y);
}

// Высота рельефа (км) по координатам карты. Ручная билинейка: R32F не везде фильтруется.
float hKm(vec2 m) {
  bool inPatch = uHasPatch > 0.5 && all(lessThan(abs(m - uPatchRect.xy), vec2(uPatchRect.z - 0.05)));
  float hp = inPatch ? bilinear(uPatch, (m - uPatchRect.xy + uPatchRect.z) / (2.0 * uPatchRect.z) * uPatchSize - 0.5, uPatchSize) : 0.0;
  vec2 st = (m + uHalf) / (2.0 * uHalf) * uTexSize - 0.5;
  vec2 f = fract(st);
  ivec2 i0 = ivec2(floor(st));
  ivec2 lim = ivec2(uTexSize) - 1;
  ivec2 a = clamp(i0, ivec2(0), lim);
  ivec2 b = clamp(i0 + 1, ivec2(0), lim);
  float h00 = texelFetch(uHeight, ivec2(a.x, a.y), 0).r;
  float h10 = texelFetch(uHeight, ivec2(b.x, a.y), 0).r;
  float h01 = texelFetch(uHeight, ivec2(a.x, b.y), 0).r;
  float h11 = texelFetch(uHeight, ivec2(b.x, b.y), 0).r;
  return inPatch ? hp : mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

vec3 dirFromMap(vec2 m) {
  float rho2 = dot(m, m) / (4.0 * uR * uR);
  float k = 1.0 / (rho2 + 1.0);
  return vec3(m.y / uR * k, (rho2 - 1.0) * k, -m.x / uR * k);
}

vec2 mapFromDir(vec3 u) {
  float k = 2.0 * uR / (1.0 - u.y);
  return vec2(-u.z * k, u.x * k);
}

// Доля видимого диска источника (угловой радиус angR, рад) из точки P (система Луны, км)
// в направлении D. Атмосферы нет: горизонт = рельеф + край сферы (кривизна учтена,
// т.к. луч идёт в 3D, а рельеф — радиус R + h).
float sourceVisibility(vec3 P, vec3 D, float angR) {
  float t = uT0;
  float maxOcc = -1.0;
  for (int i = 0; i < 300; i++) {
    vec3 Q = P + D * t;
    float rq = length(Q);
    if (rq > uR + uMaxH + 0.01) break;          // луч выше всех гор
    vec2 m = mapFromDir(Q / rq);
    if (abs(m.x) > uHalf || abs(m.y) > uHalf) break; // вышли за тайл: дальше рельеф не моделируем
    float occ = (uR + hKm(m) - rq) / t;          // угол рельефа над лучом, рад
    maxOcc = max(maxOcc, occ);
    if (maxOcc > angR) return 0.0;               // диск закрыт полностью
    t = t * 1.03 + uDt;
  }
  // линейная полутень по диску
  return clamp(0.5 - maxOcc / (2.0 * angR), 0.0, 1.0);
}
`;

// Колормапы слоёв (одни и те же в GLSL и в JS-легенде)
export const COLORMAPS = /* glsl */ `
vec3 cmIllum(float t) {           // чёрный → фиолетовый → оранжевый → жёлтый (inferno-подобный)
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.0, 0.0, 0.02), c1 = vec3(0.34, 0.06, 0.43), c2 = vec3(0.89, 0.35, 0.11), c3 = vec3(0.99, 0.93, 0.45);
  return t < 0.33 ? mix(c0, c1, t / 0.33) : t < 0.66 ? mix(c1, c2, (t - 0.33) / 0.33) : mix(c2, c3, (t - 0.66) / 0.34);
}
vec3 cmComms(float t) {           // чёрный → синий → бирюзовый → белый
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.0, 0.0, 0.03), c1 = vec3(0.05, 0.2, 0.55), c2 = vec3(0.15, 0.75, 0.85), c3 = vec3(0.92, 1.0, 1.0);
  return t < 0.33 ? mix(c0, c1, t / 0.33) : t < 0.66 ? mix(c1, c2, (t - 0.33) / 0.33) : mix(c2, c3, (t - 0.66) / 0.34);
}
vec3 cmSlope(float deg) {         // < 5° зелёный, 5–10° жёлтый, > 10° красный
  vec3 g = vec3(0.18, 0.75, 0.35), y = vec3(0.98, 0.82, 0.2), r = vec3(0.92, 0.22, 0.18);
  return deg < 5.0 ? mix(g, y, smoothstep(4.0, 5.0, deg)) : mix(y, r, smoothstep(9.0, 10.0, deg));
}
`;

// Те же колормапы на JS (легенда, глобус)
const lerp3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const ramp = (stops) => (t) => {
  t = Math.min(1, Math.max(0, t));
  const k = t < 0.33 ? 0 : t < 0.66 ? 1 : 2;
  const local = k === 0 ? t / 0.33 : k === 1 ? (t - 0.33) / 0.33 : (t - 0.66) / 0.34;
  return lerp3(stops[k], stops[k + 1], local);
};
export const cmIllum = ramp([
  [0, 0, 0.02],
  [0.34, 0.06, 0.43],
  [0.89, 0.35, 0.11],
  [0.99, 0.93, 0.45],
]);
export const cmComms = ramp([
  [0, 0, 0.03],
  [0.05, 0.2, 0.55],
  [0.15, 0.75, 0.85],
  [0.92, 1, 1],
]);
export function cmSlope(deg) {
  const s = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const g = [0.18, 0.75, 0.35];
  const y = [0.98, 0.82, 0.2];
  const r = [0.92, 0.22, 0.18];
  return deg < 5 ? lerp3(g, y, s(4, 5, deg)) : lerp3(y, r, s(9, 10, deg));
}
