import * as THREE from 'three';

// Процедурный звёздный фон: точки на большой сфере вокруг сцены.
export function createStarfield(count = 6000, radius = 400) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.randomDirection().multiplyScalar(radius);
    positions.set([v.x, v.y, v.z], i * 3);
    const b = 0.35 + Math.random() ** 3 * 0.65; // в основном тусклые
    colors.set([b, b, b * (0.9 + Math.random() * 0.2)], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 1.2,
    sizeAttenuation: false,
    vertexColors: true,
    depthWrite: false,
  });
  const stars = new THREE.Points(geometry, material);
  stars.name = 'stars';
  stars.renderOrder = -1;
  return stars;
}
