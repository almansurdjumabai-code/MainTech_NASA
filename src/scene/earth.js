import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { latLonToVector } from './coords.js';

const EARTH_RADIUS_KM = 6371;
const D2R = Math.PI / 180;

// Земля в виде с орбиты: реальное направление, условные расстояние и размер.
// Дальше maxDistance камеры (12), чтобы камера не влетала в Землю.
const SCENE_DIST = 14;
export const EARTH_SIZE_EXAGGERATION = 3;

/**
 * Поворот Земли вокруг оси (рад) в системе Луны: полуденный меридиан (≈ (12 − UT)·15°) смотрит на Солнце.
 * Ось Земли условно параллельна оси Луны (ошибка до ~25° по наклону).
 */
export function earthSpin(sub, date, tmp = new THREE.Vector3()) {
  const ut = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  latLonToVector(sub.sunLat, sub.sunLon, 1, tmp);
  return Math.atan2(-tmp.z, tmp.x) - (12 - ut) * 15 * D2R;
}

export function loadEarthMaterial(onError) {
  const material = new THREE.MeshStandardMaterial({ color: 0x3b6fb6, roughness: 0.85, metalness: 0 });
  new THREE.TextureLoader().load(
    '/textures/earth_2k.jpg',
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      material.map = tex;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    },
    undefined,
    () => onError?.('earth_2k.jpg'),
  );
  return material;
}

export function createEarth({ onError } = {}) {
  const material = loadEarthMaterial(onError); // без текстуры остаётся голубой шар
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material);
  mesh.name = 'earth';

  const el = document.createElement('div');
  el.className = 'moon-label earth-label';
  const label = new CSS2DObject(el);
  label.center.set(0.5, -0.6);
  mesh.add(label);

  const dir = new THREE.Vector3();
  const sunDir = new THREE.Vector3();

  return {
    mesh,
    /** sub — результат getSubPoints(), date — момент времени */
    update(sub, date) {
      latLonToVector(sub.earthLat, sub.earthLon, 1, dir);
      mesh.position.copy(dir).multiplyScalar(SCENE_DIST);

      // Видимый размер = реальный угловой размер с Луны × EARTH_SIZE_EXAGGERATION
      const angularRadius = Math.atan(EARTH_RADIUS_KM / sub.earthDistKm);
      mesh.scale.setScalar(SCENE_DIST * Math.tan(angularRadius) * EARTH_SIZE_EXAGGERATION);

      mesh.rotation.y = earthSpin(sub, date, sunDir);

      el.textContent = `Earth · ${Math.round(sub.earthPhase * 100)}% lit`;
    },
  };
}
