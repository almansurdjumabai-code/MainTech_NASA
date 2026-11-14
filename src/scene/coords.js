import * as THREE from 'three';

// Единица сцены = радиус Луны.
export const MOON_RADIUS_KM = 1737.4;

const D2R = Math.PI / 180;

// Селенографические координаты -> вектор в системе Луны (Moon ME):
// +X смотрит на 0° долготы (центр видимой стороны), +Y — северный полюс,
// восточная долгота идёт к -Z (так совпадает с UV у THREE.SphereGeometry).
export function latLonToVector(latDeg, lonDeg, radius = 1, target = new THREE.Vector3()) {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  return target.set(
    radius * Math.cos(lat) * Math.cos(lon),
    radius * Math.sin(lat),
    -radius * Math.cos(lat) * Math.sin(lon),
  );
}

export function vectorToLatLon(v) {
  const r = v.length();
  return {
    lat: Math.asin(THREE.MathUtils.clamp(v.y / r, -1, 1)) / D2R,
    lon: Math.atan2(-v.z, v.x) / D2R,
  };
}
